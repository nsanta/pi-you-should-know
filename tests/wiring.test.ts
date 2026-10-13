import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import youShouldKnowExtension from "../src/index.ts";

// --- fixtures --------------------------------------------------------------

const FIXTURES = mkdtempSync(join(tmpdir(), "ysk-wiring-"));
const CWD = join(FIXTURES, "ws");
const PROJECT_CONFIG = join(CWD, ".pi", "you-should-know.json");
afterAll(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
});

function writeProjectConfig(config: Record<string, unknown>): void {
  mkdirSync(join(CWD, ".pi"), { recursive: true });
  writeFileSync(PROJECT_CONFIG, JSON.stringify(config), "utf8");
}

const readProjectConfig = (): Record<string, unknown> => JSON.parse(readFileSync(PROJECT_CONFIG, "utf8"));

const REVIEW_NOTES = [
  { topic: "silent assumption", severity: "warning", title: "Silent assumption", detail: "detail a" },
  { topic: "hidden decision", severity: "critical", title: "Hidden decision", detail: "detail b" },
];
const REVIEW_JSON = JSON.stringify(REVIEW_NOTES);

function toolEndEvent(toolCallId: string): unknown {
  return { type: "tool_execution_end", toolCallId, toolName: "read", isError: false };
}

// --- fake pi / ctx (okf_god wiring-test pattern) -----------------------------

type Handler = (event: any, ctx: any) => any;

/** Stream result the fake modelRegistry hands back for every review. */
interface StreamOutcome {
  text?: string;
  errorMessage?: string;
  stopReason?: string;
  reject?: Error;
  /** Hold the result promise until `release()` is called. */
  hold?: boolean;
}

function fakeModelRegistry(outcome: StreamOutcome = {}) {
  let release: (value?: any) => void = () => {};
  const held = new Promise<any>((resolve) => {
    release = resolve;
  });
  const registry = {
    find: vi.fn((provider: string, id: string) => (provider === "ghost" ? undefined : { provider, id })),
    getAll: vi.fn(() => [{ provider: "p", id: "bare-model" }]),
  };
  const streamSimple = vi.fn((_model: any, _context: any, _options: any) => ({
    result: (): Promise<any> => {
      if (outcome.reject) return Promise.reject(outcome.reject);
      if (outcome.hold) return held;
      return Promise.resolve({
        stopReason: outcome.stopReason ?? "stop",
        errorMessage: outcome.errorMessage,
        content: [{ type: "text", text: outcome.text ?? REVIEW_JSON }],
      });
    },
  }));
  return {
    ...registry,
    streamSimple,
    release,
    calls: (): any[][] => streamSimple.mock.calls,
    /** AbortSignal passed to the most recent streamSimple call, if any. */
    lastSignal: (): AbortSignal | undefined => streamSimple.mock.calls.at(-1)?.[2]?.signal,
  };
}

function mockCtx(registry: ReturnType<typeof fakeModelRegistry>, overrides: Record<string, unknown> = {}) {
  /** One unique unsubscribe spy per onTerminalInput subscription. */
  const unsubscribers: Array<ReturnType<typeof vi.fn>> = [];
  const ui = {
    notify: vi.fn(),
    setWidget: vi.fn(),
    setEditorText: vi.fn(),
    custom: vi.fn(async (..._args: unknown[]) => undefined),
    onTerminalInput: vi.fn((_handler: unknown) => {
      const unsubscribe = vi.fn();
      unsubscribers.push(unsubscribe);
      return unsubscribe;
    }),
    theme: { fg: vi.fn((token: string, text: string) => `<${token}>${text}`) },
  };
  const ctx: any = {
    hasUI: true,
    mode: "tui",
    cwd: CWD,
    ui,
    sessionManager: {
      getBranch: (): unknown[] => [{ type: "message", message: { role: "user", content: "hello world" } }],
    },
    modelRegistry: registry,
    model: { provider: "sess", id: "session-model" },
    ...overrides,
  };
  return { ctx, ui, unsubscribers };
}

async function setup(
  options: {
    config?: Record<string, unknown>;
    hasUI?: boolean;
    outcome?: StreamOutcome;
    ctxOverrides?: Record<string, unknown>;
  } = {},
) {
  writeProjectConfig(options.config ?? {});
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Handler[]>();
  const sent: string[] = [];
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, options: any) => commands.set(name, options),
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendUserMessage: (content: unknown) => {
      sent.push(typeof content === "string" ? content : JSON.stringify(content));
    },
  };
  const registry = fakeModelRegistry(options.outcome);
  const { ctx, ui, unsubscribers } = mockCtx(registry, { hasUI: options.hasUI ?? true, ...options.ctxOverrides });
  youShouldKnowExtension(pi as never);
  await handlers.get("session_start")![0]({ type: "session_start", reason: "startup" }, ctx);
  return { registry, ctx, ui, unsubscribers, sent, tools, commands, handlers };
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const widgetCalls = (ui: { setWidget: any }): any[][] => ui.setWidget.mock.calls;
const lastWidgetArg = (ui: { setWidget: any }): unknown => widgetCalls(ui).at(-1)?.[1];
const widgetText = (ui: { setWidget: any }): string =>
  widgetCalls(ui)
    .map((call) => (Array.isArray(call[1]) ? call[1].join("\n") : String(call[1] ?? "")))
    .join("\n");

async function addNoteViaTool(tools: Map<string, any>, note: string, severity?: string): Promise<any> {
  return tools.get("heads_up").execute("id", severity ? { note, severity } : { note });
}

/** The terminal-input handler registered by the most recent session. */
const inputHandler = (ui: { onTerminalInput: any }): ((data: string) => { consume?: boolean } | undefined) =>
  ui.onTerminalInput.mock.calls.at(-1)![0];

/** Register a pending note and let the runtime render it, then return the key handler. */
async function setupWithPendingNote(
  options: Parameters<typeof setup>[0] = {},
  note = "Deployment gate is manual",
  severity?: string,
) {
  const session = await setup(options);
  await addNoteViaTool(session.tools, note, severity);
  session.handlers.get("tool_execution_end")![0](toolEndEvent("ysk-keys"), session.ctx);
  return { ...session, handler: inputHandler(session.ui) };
}

// --- tests -------------------------------------------------------------------

describe("you-should-know wiring", () => {
  it("registers the heads_up tool, the /ysk command, and lifecycle handlers", async () => {
    const { tools, commands, handlers } = await setup();
    expect(tools.get("heads_up")?.parameters).toBeDefined();
    expect(commands.get("ysk")?.handler).toBeTypeOf("function");
    for (const event of [
      "session_start",
      "session_shutdown",
      "tool_execution_end",
      "agent_start",
      "agent_end",
      "agent_settled",
    ]) {
      expect(handlers.get(event)?.length).toBe(1);
    }
  });

  it("session_start loads project config and clears the widget baseline", async () => {
    const { ui } = await setup({ config: { reviewEvery: 2 } });
    expect(ui.setWidget).toHaveBeenCalledWith("ysk", undefined, { placement: "aboveEditor" });
  });

  it("is headless-safe: no UI calls, review still runs", async () => {
    const { ui, registry, handlers, ctx } = await setup({ config: { reviewEvery: 1 }, hasUI: false });
    handlers.get("tool_execution_end")![0](toolEndEvent("a"), ctx);
    await flush();
    expect(registry.calls()).toHaveLength(1);
    expect(ui.setWidget).not.toHaveBeenCalled();
    expect(ui.custom).not.toHaveBeenCalled();
  });

  it("runs a background review after reviewEvery steps and surfaces notes on the widget", async () => {
    const { ui, registry, handlers, ctx } = await setup({ config: { reviewEvery: 2 } });

    handlers.get("tool_execution_end")![0](toolEndEvent("a"), ctx);
    expect(registry.calls()).toHaveLength(0); // below threshold

    handlers.get("tool_execution_end")![0](toolEndEvent("b"), ctx);
    await flush();
    expect(registry.calls()).toHaveLength(1);
    expect(lastWidgetArg(ui)).toEqual([
      "<error>✦ Heads up · Hidden decision",
      "<muted>+1 more · /ysk",
      "<accent>1: Learn more  2: Knew this already  0: Dismiss",
    ]);

    // Counter reset: two more steps trigger exactly one more review.
    handlers.get("tool_execution_end")![0](toolEndEvent("c"), ctx);
    handlers.get("tool_execution_end")![0](toolEndEvent("d"), ctx);
    await flush();
    expect(registry.calls()).toHaveLength(2);
  });

  it("skips dismissed topics before notes reach the store", async () => {
    const { ui, handlers, ctx } = await setup({ config: { reviewEvery: 1, dismissedTopics: ["silent assumption"] } });
    handlers.get("tool_execution_end")![0](toolEndEvent("a"), ctx);
    await flush();
    expect(widgetText(ui)).toContain("Hidden decision");
    expect(widgetText(ui)).not.toContain("Silent assumption");
  });

  it("guards against concurrent reviews with the in-flight flag", async () => {
    const { registry, handlers, ctx } = await setup({ config: { reviewEvery: 1 }, outcome: { hold: true } });
    handlers.get("tool_execution_end")![0](toolEndEvent("a"), ctx);
    handlers.get("tool_execution_end")![0](toolEndEvent("b"), ctx);
    expect(registry.calls()).toHaveLength(1);
    registry.release();
    await flush();
    expect(registry.calls()).toHaveLength(1); // second step consumed by the guard
  });

  it("fails quiet when the reviewer stream rejects or returns an error stop", async () => {
    const rejecting = await setup({ config: { reviewEvery: 1 }, outcome: { reject: new Error("no network") } });
    rejecting.handlers.get("tool_execution_end")![0](toolEndEvent("a"), rejecting.ctx);
    await flush();
    expect(lastWidgetArg(rejecting.ui)).toBeUndefined();

    const errored = await setup({
      config: { reviewEvery: 1 },
      outcome: { stopReason: "error", errorMessage: "auth missing" },
    });
    errored.handlers.get("tool_execution_end")![0](toolEndEvent("a"), errored.ctx);
    await flush();
    expect(lastWidgetArg(errored.ui)).toBeUndefined();
  });

  it("session_shutdown aborts the in-flight request and discards its result", async () => {
    const { ui, registry, handlers, ctx } = await setup({ config: { reviewEvery: 1 }, outcome: { hold: true } });
    handlers.get("tool_execution_end")![0](toolEndEvent("a"), ctx);
    const signal = registry.lastSignal();
    expect(signal).toBeInstanceOf(AbortSignal);

    handlers.get("session_shutdown")![0]({ type: "session_shutdown", reason: "quit" }, ctx);
    expect(signal?.aborted).toBe(true);

    registry.release({ stopReason: "stop", content: [{ type: "text", text: REVIEW_JSON }] });
    await flush();
    // The late result belongs to a dead generation: never rendered.
    expect(lastWidgetArg(ui)).toBeUndefined();
  });

  it("heads_up records through the store, re-renders, and dedupes", async () => {
    const { ui, tools, handlers, ctx } = await setup();
    const result = await addNoteViaTool(tools, "Deployment gate is manual", "warning");
    expect(result.content[0].text).toContain("Recorded");
    expect(result.details).toMatchObject({ topic: "deployment gate is manual", severity: "warning", added: true });
    // The runtime fires tool_execution_end after the tool; the handler re-renders.
    handlers.get("tool_execution_end")![0](toolEndEvent("ysk-1"), ctx);
    expect(widgetText(ui)).toContain("Deployment gate is manual");

    const duplicate = await addNoteViaTool(tools, "Deployment gate is manual\nrestated with a different body");
    expect(duplicate.details.added).toBe(false);
  });

  it("heads_up reports bad input as an isError result without throwing", async () => {
    const { tools } = await setup();
    const result = await tools.get("heads_up").execute("id", { note: "   " });
    expect(result.isError).toBe(true);
  });

  it("/ysk learn expands the newest note in place and no /ysk action opens an overlay", async () => {
    const { ctx, ui, commands, tools } = await setup();
    await addNoteViaTool(tools, "Some assumption");
    await commands.get("ysk").handler("learn", ctx);
    const expanded = String(lastWidgetArg(ui));
    expect(expanded).toContain("Understood");
    expect(expanded).toContain("Some assumption");
    expect(expanded).not.toContain("Learn more");

    // Expansion is newest-only: an older note is a quiet no-op.
    const two = await setup();
    await addNoteViaTool(two.tools, "Older note");
    await addNoteViaTool(two.tools, "Newest note");
    two.handlers.get("tool_execution_end")![0](toolEndEvent("ysk-older"), two.ctx);
    expect(String(lastWidgetArg(two.ui))).toContain("Learn more");
    await two.commands.get("ysk").handler("learn 1", two.ctx);
    const collapsed = String(lastWidgetArg(two.ui));
    expect(collapsed).toContain("Learn more");
    expect(collapsed).not.toContain("Understood");

    // The modal overlay is gone: no /ysk action may touch ui.custom.
    await commands.get("ysk").handler("status", ctx);
    await commands.get("ysk").handler("chat", ctx);
    await commands.get("ysk").handler("dismiss", ctx);
    expect(ui.custom).not.toHaveBeenCalled();
  });

  it("headless /ysk learn does nothing UI-wise and does not throw", async () => {
    const { ctx, ui, commands, tools } = await setup({ hasUI: false });
    await addNoteViaTool(tools, "Some assumption");
    await expect(commands.get("ysk").handler("learn", ctx)).resolves.toBeUndefined();
    expect(ui.setWidget).not.toHaveBeenCalled();
    expect(ui.custom).not.toHaveBeenCalled();
    expect(ui.setEditorText).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it("expanded '2' and /ysk chat fill the editor with the same text, never auto-sending", async () => {
    const { ctx, ui, commands, handler, sent } = await setupWithPendingNote(
      {},
      "Deployment gate is manual\ndetail body",
      "warning",
    );
    handler("1"); // expand
    handler("2"); // key-layer editor fill
    expect(ui.setEditorText).toHaveBeenCalledOnce();
    const keyText = ui.setEditorText.mock.calls[0]![0] as string;
    expect(keyText).toContain("Re: heads-up — please address");
    expect(keyText).toContain("Deployment gate is manual");
    expect(keyText).toContain("detail body");

    await commands.get("ysk").handler("chat", ctx);
    expect(ui.setEditorText).toHaveBeenCalledTimes(2);
    expect(ui.setEditorText.mock.calls[1]![0]).toBe(keyText); // identical composition
    expect(sent).toHaveLength(0); // no pi.sendUserMessage anywhere
  });

  it("/ysk known persists the dismissal into the project config", async () => {
    const { ctx, commands, tools } = await setup();
    await addNoteViaTool(tools, "Deployment gate is manual");
    await commands.get("ysk").handler("known", ctx);
    expect(readProjectConfig().dismissedTopics).toContain("deployment gate is manual");
  });

  it("/ysk chat fills the editor instead of sending to the session", async () => {
    const { ctx, ui, commands, tools, sent } = await setup();
    await addNoteViaTool(tools, "Deployment gate is manual");
    await commands.get("ysk").handler("chat", ctx);
    expect(ui.setEditorText).toHaveBeenCalledOnce();
    const text = ui.setEditorText.mock.calls[0]![0] as string;
    expect(text).toContain("Re: heads-up — please address");
    expect(text).toContain("Deployment gate is manual");
    expect(ui.notify).toHaveBeenCalledWith("Note copied to the prompt — review and send when ready.", "info");
    expect(sent).toHaveLength(0);
  });

  it("/ysk dismiss hides for the session without persisting", async () => {
    const { ctx, ui, commands, tools } = await setup();
    await addNoteViaTool(tools, "Noisy note");
    await commands.get("ysk").handler("dismiss", ctx);
    expect(lastWidgetArg(ui)).toBeUndefined();
    expect(readProjectConfig().dismissedTopics ?? []).toHaveLength(0);
  });

  it("/ysk status reports reviewer state through notifications", async () => {
    const { ctx, ui, commands, tools } = await setup({ config: { reviewEvery: 3 } });
    await addNoteViaTool(tools, "Pending note");
    await commands.get("ysk").handler("status", ctx);
    const statusText = ui.notify.mock.calls.at(-1)![0] as string;
    expect(statusText).toContain("pending notes: 1");
    expect(statusText).toContain("review in flight: no");
    expect(statusText).toContain("every 3 tool steps");
  });

  it("routes the reviewer call through config.model when set", async () => {
    const providerModel = await setup({ config: { reviewEvery: 1, model: "prov/custom-model" } });
    providerModel.handlers.get("tool_execution_end")![0](toolEndEvent("a"), providerModel.ctx);
    await flush();
    expect(providerModel.registry.calls()[0]![0]).toMatchObject({ provider: "prov", id: "custom-model" });

    const bareModel = await setup({ config: { reviewEvery: 1, model: "bare-model" } });
    bareModel.handlers.get("tool_execution_end")![0](toolEndEvent("a"), bareModel.ctx);
    await flush();
    expect(bareModel.registry.calls()[0]![0]).toMatchObject({ id: "bare-model" });

    const unknownModel = await setup({ config: { reviewEvery: 1, model: "ghost/model" } });
    unknownModel.handlers.get("tool_execution_end")![0](toolEndEvent("a"), unknownModel.ctx);
    await flush();
    // Falls back to the session model rather than skipping the review.
    expect(unknownModel.registry.calls()[0]![0]).toMatchObject({ provider: "sess", id: "session-model" });
  });

  it("a session replacement invalidates in-flight work from the old session", async () => {
    const { ui, registry, handlers, ctx } = await setup({ config: { reviewEvery: 1 }, outcome: { hold: true } });
    handlers.get("tool_execution_end")![0](toolEndEvent("a"), ctx);

    // New session start bumps the generation, invalidating the held review.
    await handlers.get("session_start")![0]({ type: "session_start", reason: "resume" }, ctx);
    registry.release({ stopReason: "stop", content: [{ type: "text", text: REVIEW_JSON }] });
    await flush();
    expect(lastWidgetArg(ui)).toBeUndefined();
  });

  // --- terminal-input key layer (T2) -----------------------------------------

  it("subscribes one terminal-input handler per TUI session, unsubscribes on shutdown, re-subscribes on session_start", async () => {
    const { ui, unsubscribers, handlers, ctx } = await setup();
    expect(ui.onTerminalInput).toHaveBeenCalledOnce();
    expect(ui.onTerminalInput.mock.calls[0]![0]).toBeTypeOf("function");

    handlers.get("session_shutdown")![0]({ type: "session_shutdown", reason: "quit" }, ctx);
    expect(unsubscribers[0]).toHaveBeenCalledOnce();

    // Session replacement: the stale handler is detached before the new one subscribes.
    await handlers.get("session_start")![0]({ type: "session_start", reason: "resume" }, ctx);
    expect(ui.onTerminalInput).toHaveBeenCalledTimes(2);
    expect(unsubscribers[0]).toHaveBeenCalledOnce();
    expect(unsubscribers[0]!.mock.invocationCallOrder[0]).toBeLessThan(ui.onTerminalInput.mock.invocationCallOrder[1]!);
  });

  it("never subscribes terminal input outside TUI contexts", async () => {
    const headless = await setup({ hasUI: false });
    expect(headless.ui.onTerminalInput).not.toHaveBeenCalled();

    const rpc = await setup({ ctxOverrides: { mode: "rpc" } });
    expect(rpc.ui.onTerminalInput).not.toHaveBeenCalled();
  });

  it("collapsed '1' expands the newest note in place and consumes the key", async () => {
    const { ui, handler } = await setupWithPendingNote();
    expect(String(lastWidgetArg(ui))).toContain("Learn more");

    expect(handler("1")).toEqual({ consume: true });
    const expanded = String(lastWidgetArg(ui));
    expect(expanded).toContain("Understood");
    expect(expanded).toContain("Deployment gate is manual");
  });

  it("expanded '2' fills the editor with the composed explanation instead of sending", async () => {
    const { ui, handler, sent } = await setupWithPendingNote({}, "Deployment gate is manual\ndetail body", "warning");
    handler("1"); // expand

    expect(handler("2")).toEqual({ consume: true });
    expect(ui.setEditorText).toHaveBeenCalledOnce();
    const text = ui.setEditorText.mock.calls[0]![0] as string;
    expect(text).toContain("Re: heads-up — please address");
    expect(text).toContain("Deployment gate is manual");
    expect(text).toContain("detail body");
    expect(sent).toHaveLength(0); // never auto-sends
    expect(String(lastWidgetArg(ui))).toContain("Deployment gate is manual"); // note stays pending
  });

  it("expanded '1' acknowledges non-destructively and collapses back", async () => {
    const { ui, handler } = await setupWithPendingNote();
    handler("1"); // expand

    expect(handler("1")).toEqual({ consume: true });
    const collapsed = String(lastWidgetArg(ui));
    expect(collapsed).toContain("Learn more");
    expect(collapsed).not.toContain("Understood");
    expect(collapsed).toContain("Deployment gate is manual"); // note still pending
    expect(ui.setEditorText).not.toHaveBeenCalled();
  });

  it("collapsed '2' dismisses permanently and persists through the config path", async () => {
    const { ui, handler } = await setupWithPendingNote();

    expect(handler("2")).toEqual({ consume: true });
    await flush();
    expect(readProjectConfig().dismissedTopics).toContain("deployment gate is manual");
    expect(lastWidgetArg(ui)).toBeUndefined(); // widget cleared
  });

  it("collapsed '0' dismisses for the session without persisting", async () => {
    const { ui, handler } = await setupWithPendingNote();

    expect(handler("0")).toEqual({ consume: true });
    expect(lastWidgetArg(ui)).toBeUndefined();
    expect(readProjectConfig().dismissedTopics ?? []).toHaveLength(0);
  });

  it("expanded '0' dismisses for the session and collapses", async () => {
    const { ui, handler } = await setupWithPendingNote();
    handler("1"); // expand

    expect(handler("0")).toEqual({ consume: true });
    expect(lastWidgetArg(ui)).toBeUndefined();
    expect(readProjectConfig().dismissedTopics ?? []).toHaveLength(0);
  });

  it("passes keys through untouched when no note is pending", async () => {
    const { ui } = await setup();
    const handler = inputHandler(ui);
    expect(handler("1")).toBeUndefined();
    expect(handler("2")).toBeUndefined();
    expect(handler("0")).toBeUndefined();
  });

  it("never consumes multi-character input (paste chunks), even with a pending note", async () => {
    const { ui, handler } = await setupWithPendingNote();

    expect(handler("12")).toBeUndefined();
    expect(handler("1abc")).toBeUndefined();
    expect(String(lastWidgetArg(ui))).toContain("Learn more"); // state untouched
  });

  it("expansion silently resets to collapsed when a newer note arrives", async () => {
    const { ui, tools, handlers, ctx, handler } = await setupWithPendingNote({}, "First note topic", "info");
    handler("1"); // expand the newest (first) note
    expect(String(lastWidgetArg(ui))).toContain("Understood");

    await addNoteViaTool(tools, "Second note topic");
    handlers.get("tool_execution_end")![0](toolEndEvent("ysk-newer"), ctx);
    const rendered = String(lastWidgetArg(ui));
    expect(rendered).toContain("Learn more");
    expect(rendered).not.toContain("Understood");
  });
});

// --- answer-completion presentation (T4) --------------------------------------

describe("you-should-know answer-completion presentation", () => {
  it("defers widget writes while the agent loop runs and flushes notes at agent_end", async () => {
    const { ui, registry, handlers, ctx } = await setup({ config: { reviewEvery: 1 } });
    handlers.get("agent_start")![0]({ type: "agent_start" }, ctx);
    const callsWhenLoopStarted = widgetCalls(ui).length;

    handlers.get("tool_execution_end")![0](toolEndEvent("a"), ctx);
    await flush();
    expect(registry.calls()).toHaveLength(1); // reviewer still runs mid-loop
    expect(widgetCalls(ui).length).toBe(callsWhenLoopStarted); // no widget write while active
    expect(widgetText(ui)).not.toContain("Hidden decision");

    handlers.get("agent_end")![0]({ type: "agent_end", messages: [] }, ctx);
    expect(widgetText(ui)).toContain("Hidden decision"); // presented at completion
  });

  it("renders immediately when the agent loop is idle", async () => {
    const { ui, tools, handlers, ctx } = await setup();
    await addNoteViaTool(tools, "Idle note");
    handlers.get("tool_execution_end")![0](toolEndEvent("ysk-idle"), ctx);
    expect(widgetText(ui)).toContain("Idle note");
  });

  it("agent_settled is the safety net: flushes pending renders without a second render at agent_end", async () => {
    const { ui, tools, handlers, ctx } = await setup();
    await addNoteViaTool(tools, "Settled note");
    handlers.get("agent_start")![0]({ type: "agent_start" }, ctx);
    handlers.get("tool_execution_end")![0](toolEndEvent("ysk-settle"), ctx); // deferred: dirty
    expect(widgetText(ui)).not.toContain("Settled note");

    handlers.get("agent_settled")![0]({ type: "agent_settled", aborted: false }, ctx);
    expect(widgetText(ui)).toContain("Settled note");
    const callsAfterSettle = widgetCalls(ui).length;

    handlers.get("agent_end")![0]({ type: "agent_end", messages: [] }, ctx);
    expect(widgetCalls(ui).length).toBe(callsAfterSettle); // flag cleared: idempotent
  });

  it("defers dismissals mid-loop and flushes the cleared band at agent_end", async () => {
    const { ui, handler, handlers, ctx } = await setupWithPendingNote();
    expect(String(lastWidgetArg(ui))).toContain("Deployment gate is manual");
    handlers.get("agent_start")![0]({ type: "agent_start" }, ctx);
    const callsBeforeDismiss = widgetCalls(ui).length;

    expect(handler("0")).toEqual({ consume: true }); // session dismissal mid-loop
    expect(widgetCalls(ui).length).toBe(callsBeforeDismiss); // write deferred
    expect(widgetText(ui)).toContain("Deployment gate is manual"); // band still up

    handlers.get("agent_end")![0]({ type: "agent_end", messages: [] }, ctx);
    expect(lastWidgetArg(ui)).toBeUndefined(); // flushed: empty band clears the widget
  });
});
