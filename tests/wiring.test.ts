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

/** One recorded ui.custom overlay open: the component plus its contract pieces. */
interface RecordedCustomOpen {
  component: {
    render?: (width?: number) => string[];
    invalidate?: () => void;
    handleInput?: (data: string) => void;
    handleMouse?: (event: unknown) => unknown;
  };
  opts: Record<string, unknown> | undefined;
  fakeTui: { requestRender: ReturnType<typeof vi.fn> };
  /** Spy-wrapped done/resolve: invoking it resolves the overlay promise. */
  resolve: ReturnType<typeof vi.fn>;
}

function mockCtx(
  registry: ReturnType<typeof fakeModelRegistry>,
  overrides: Record<string, unknown> = {},
) {
  /** Every ui.custom open, in order, with the pieces the overlay contract hands out. */
  const customCalls: RecordedCustomOpen[] = [];
  /** OverlayHandle stand-in handed to every open's onHandle. */
  const fakeHandle = {
    hide: vi.fn(),
    setHidden: vi.fn(),
    focus: vi.fn(),
    unfocus: vi.fn(),
    getBounds: vi.fn(() => undefined),
  };
  /** The TUI instance the factory receives (pi hands the live TUI). */
  const fakeOverlayTui = { requestRender: vi.fn() };
  const ui = {
    notify: vi.fn(),
    setWidget: vi.fn(),
    setEditorText: vi.fn(),
    // pi's overlay contract: onHandle fires with the handle, the factory gets
    // (tui, theme, keybindings, done) and done resolves the promise. done is
    // spy-wrapped so tests can assert overlay dismissal.
    custom: vi.fn(
      (factory: any, opts: any): Promise<unknown> =>
        new Promise((resolve) => {
          const done = vi.fn((value: unknown) => resolve(value));
          opts?.onHandle?.(fakeHandle);
          const component = factory(fakeOverlayTui, fakeTheme, undefined, done);
          customCalls.push({ component, opts, fakeTui: fakeOverlayTui, resolve: done });
        }),
    ),
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
  return { ctx, ui, customCalls, fakeOverlayTui, fakeHandle };
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
  const { ctx, ui, customCalls, fakeOverlayTui, fakeHandle } = mockCtx(registry, {
    hasUI: options.hasUI ?? true,
    ...options.ctxOverrides,
  });
  youShouldKnowExtension(pi as never);
  await handlers.get("session_start")![0]({ type: "session_start", reason: "startup" }, ctx);
  return {
    registry,
    ctx,
    ui,
    customCalls,
    fakeOverlayTui,
    fakeHandle,
    sent,
    tools,
    commands,
    handlers,
  };
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Stand-in for pi's Theme; output format matches the ctx.ui.theme fake. */
const fakeTheme = { fg: (token: string, text: string) => `<${token}>${text}` };

/** Themed render of one recorded custom open at a fixed width. */
const renderOf = (open: RecordedCustomOpen): string => (open.component.render?.(100) ?? []).join("\n");

async function addNoteViaTool(tools: Map<string, any>, note: string, severity?: string): Promise<any> {
  return tools.get("heads_up").execute("id", severity ? { note, severity } : { note });
}

/** Normalized left-click at row y of the receiving component. */
function clickEvent(y: number): Record<string, unknown> {
  return {
    type: "click",
    button: "left",
    x: 0,
    y,
    screenX: 0,
    screenY: 0,
    width: 60,
    height: 10,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

/**
 * Record notes through the heads_up tool (rendering each), then open the
 * popup via bare /ysk. customCalls[0] is the tally sidebar; the popup is the
 * most recent open.
 */
async function setupWithPopup(noteTexts: string[], severities?: string[]) {
  const session = await setup();
  for (const [index, text] of noteTexts.entries()) {
    await addNoteViaTool(session.tools, text, severities?.[index]);
    session.handlers.get("tool_execution_end")![0](toolEndEvent(`p${index}`), session.ctx);
  }
  await session.commands.get("ysk").handler("", session.ctx);
  return {
    ...session,
    sidebar: session.customCalls[0]!,
    popup: session.customCalls.at(-1)!,
  };
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

  it("session_start loads project config and keeps the UI quiet for an empty tally", async () => {
    const { ui } = await setup({ config: { reviewEvery: 2 } });
    expect(ui.custom).not.toHaveBeenCalled();
  });

  it("is headless-safe: no UI calls, review still runs", async () => {
    const { ui, registry, handlers, ctx } = await setup({ config: { reviewEvery: 1 }, hasUI: false });
    handlers.get("tool_execution_end")![0](toolEndEvent("a"), ctx);
    await flush();
    expect(registry.calls()).toHaveLength(1);
    expect(ui.setWidget).not.toHaveBeenCalled();
    expect(ui.custom).not.toHaveBeenCalled();
  });

  it("runs a background review after reviewEvery steps and surfaces notes on the sidebar", async () => {
    const { ui, customCalls, registry, handlers, ctx } = await setup({ config: { reviewEvery: 2 } });

    handlers.get("tool_execution_end")![0](toolEndEvent("a"), ctx);
    expect(registry.calls()).toHaveLength(0); // below threshold

    handlers.get("tool_execution_end")![0](toolEndEvent("b"), ctx);
    await flush();
    expect(registry.calls()).toHaveLength(1);
    expect(ui.custom).toHaveBeenCalledOnce();
    // Card frame + one body row per non-zero severity, priority order, theme
    // tokens applied, stretched to the render width (render(100) -> 100 cols:
    // title 12 chars -> 100 - 12 - 5 = 83 fill dashes, etc.).
    expect(renderOf(customCalls[0]!)).toBe(
      [
        `<border>╭─ <accent>✦ 2 heads-up<border> ${"─".repeat(83)}╮`,
        `<border>│ <error>■ 1 critical<border>${" ".repeat(84)} │`,
        `<border>│ <warning>■ 1 warning<border>${" ".repeat(85)} │`,
        `<border>╰${"─".repeat(98)}╯`,
      ].join("\n"),
    );

    // Counter reset: two more steps trigger exactly one more review.
    handlers.get("tool_execution_end")![0](toolEndEvent("c"), ctx);
    handlers.get("tool_execution_end")![0](toolEndEvent("d"), ctx);
    await flush();
    expect(registry.calls()).toHaveLength(2);
  });

  it("skips dismissed topics before notes reach the store", async () => {
    const { customCalls, handlers, ctx } = await setup({ config: { reviewEvery: 1, dismissedTopics: ["silent assumption"] } });
    handlers.get("tool_execution_end")![0](toolEndEvent("a"), ctx);
    await flush();
    const text = renderOf(customCalls[0]!);
    expect(text).toContain("1 head-up");
    expect(text).toContain("1 critical");
    expect(text).not.toContain("warning");
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
    expect(rejecting.ui.custom).not.toHaveBeenCalled(); // no notes, no sidebar

    const errored = await setup({
      config: { reviewEvery: 1 },
      outcome: { stopReason: "error", errorMessage: "auth missing" },
    });
    errored.handlers.get("tool_execution_end")![0](toolEndEvent("a"), errored.ctx);
    await flush();
    expect(errored.ui.custom).not.toHaveBeenCalled();
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
    // The late result belongs to a dead generation: never surfaced.
    expect(ui.custom).not.toHaveBeenCalled();
  });

  it("heads_up records through the store, re-renders, and dedupes", async () => {
    const { ui, customCalls, tools, handlers, ctx } = await setup();
    const result = await addNoteViaTool(tools, "Deployment gate is manual", "warning");
    expect(result.content[0].text).toContain("Recorded");
    expect(result.details).toMatchObject({ topic: "deployment gate is manual", severity: "warning", added: true });
    // The runtime fires tool_execution_end after the tool; the handler re-renders.
    handlers.get("tool_execution_end")![0](toolEndEvent("ysk-1"), ctx);
    expect(ui.custom).toHaveBeenCalledOnce();
    expect(renderOf(customCalls[0]!)).toContain("1 head-up");

    const duplicate = await addNoteViaTool(tools, "Deployment gate is manual\nrestated with a different body");
    expect(duplicate.details.added).toBe(false);
  });

  it("heads_up reports bad input as an isError result without throwing", async () => {
    const { tools } = await setup();
    const result = await tools.get("heads_up").execute("id", { note: "   " });
    expect(result.isError).toBe(true);
  });

  it("/ysk learn opens that note's popup while status opens nothing new", async () => {
    const { ctx, ui, commands, customCalls, tools, handlers } = await setup();
    await addNoteViaTool(tools, "Some assumption");
    handlers.get("tool_execution_end")![0](toolEndEvent("ysk-learn"), ctx);
    expect(ui.custom).toHaveBeenCalledTimes(1); // the tally sidebar

    await commands.get("ysk").handler("learn", ctx); // newest by default
    expect(ui.custom).toHaveBeenCalledTimes(2);
    expect(renderOf(customCalls[1]!)).toContain("Heads up · Some assumption");

    // learn <n> targets the 1-based note, not just the newest.
    const two = await setup();
    await addNoteViaTool(two.tools, "Older note");
    await addNoteViaTool(two.tools, "Newest note");
    two.handlers.get("tool_execution_end")![0](toolEndEvent("ysk-older"), two.ctx);
    await two.commands.get("ysk").handler("learn 1", two.ctx);
    expect(renderOf(two.customCalls[1]!)).toContain("Heads up · Older note");

    // /ysk status only reports: it never opens a popup.
    const opensBefore = ui.custom.mock.calls.length;
    await commands.get("ysk").handler("status", ctx);
    expect(ui.custom.mock.calls).toHaveLength(opensBefore);
  });

  it("headless /ysk does nothing UI-wise and does not throw", async () => {
    const { ctx, ui, commands, tools } = await setup({ hasUI: false });
    await addNoteViaTool(tools, "Some assumption");
    await expect(commands.get("ysk").handler("", ctx)).resolves.toBeUndefined();
    await expect(commands.get("ysk").handler("learn 1", ctx)).resolves.toBeUndefined();
    expect(ui.setWidget).not.toHaveBeenCalled();
    expect(ui.custom).not.toHaveBeenCalled();
    expect(ui.setEditorText).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it("popup '2' and /ysk chat fill the editor with the same text, never auto-sending", async () => {
    // Popup path: 1 pending -> detail popup, then the Chat action.
    const viaPopup = await setupWithPopup(["Deployment gate is manual\ndetail body"], ["warning"]);
    viaPopup.popup.component.handleInput!("2");
    expect(viaPopup.ui.setEditorText).toHaveBeenCalledOnce();
    const popupText = viaPopup.ui.setEditorText.mock.calls[0]![0] as string;

    // Command path: same note, /ysk chat.
    const viaCommand = await setup();
    await addNoteViaTool(viaCommand.tools, "Deployment gate is manual\ndetail body", "warning");
    viaCommand.handlers.get("tool_execution_end")![0](toolEndEvent("chat-note"), viaCommand.ctx);
    await viaCommand.commands.get("ysk").handler("chat", viaCommand.ctx);
    expect(viaCommand.ui.setEditorText).toHaveBeenCalledOnce();
    const commandText = viaCommand.ui.setEditorText.mock.calls[0]![0] as string;

    expect(popupText).toContain("Re: heads-up — please address");
    expect(popupText).toContain("Deployment gate is manual");
    expect(popupText).toContain("detail body");
    expect(commandText).toBe(popupText); // identical composition
    expect(viaPopup.sent).toHaveLength(0); // never auto-sends anywhere
    expect(viaCommand.sent).toHaveLength(0);
  });

  it("/ysk known persists the dismissal into the project config", async () => {
    const { ctx, commands, tools } = await setup();
    await addNoteViaTool(tools, "Deployment gate is manual");
    await commands.get("ysk").handler("known", ctx);
    expect(readProjectConfig().dismissedTopics).toContain("deployment gate is manual");
  });

  it("/ysk chat fills the editor, marks the note processed, and closes the emptied sidebar", async () => {
    const { ctx, ui, commands, customCalls, tools, sent, handlers } = await setup();
    await addNoteViaTool(tools, "Deployment gate is manual");
    handlers.get("tool_execution_end")![0](toolEndEvent("chat-note"), ctx);
    await commands.get("ysk").handler("chat", ctx);
    expect(ui.setEditorText).toHaveBeenCalledOnce();
    const text = ui.setEditorText.mock.calls[0]![0] as string;
    expect(text).toContain("Re: heads-up — please address");
    expect(text).toContain("Deployment gate is manual");
    expect(ui.notify).toHaveBeenCalledWith("Note copied to the prompt — marked as processed.", "info");
    expect(sent).toHaveLength(0);
    expect(customCalls[0]!.resolve).toHaveBeenCalledTimes(1); // processed last note -> sidebar closes
  });

  it("/ysk dismiss hides for the session without persisting", async () => {
    const { ctx, ui, commands, customCalls, tools, handlers } = await setup();
    await addNoteViaTool(tools, "Noisy note");
    handlers.get("tool_execution_end")![0](toolEndEvent("dismiss-note"), ctx);
    await commands.get("ysk").handler("dismiss", ctx);
    expect(customCalls[0]!.resolve).toHaveBeenCalledTimes(1); // sidebar closed with the emptied tally
    expect(readProjectConfig().dismissedTopics ?? []).toHaveLength(0);
  });

  it("/ysk status reports reviewer state through notifications", async () => {
    const { ctx, ui, commands, tools, handlers } = await setup({ config: { reviewEvery: 3 } });
    await addNoteViaTool(tools, "Pending note");
    handlers.get("tool_execution_end")![0](toolEndEvent("status-note"), ctx);
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
    expect(ui.custom).not.toHaveBeenCalled(); // the late result never surfaces
  });
});

// --- answer-completion presentation (T4) --------------------------------------

describe("you-should-know answer-completion presentation", () => {
  it("defers sidebar writes while the agent loop runs and flushes notes at agent_end", async () => {
    const { ui, customCalls, registry, handlers, ctx } = await setup({ config: { reviewEvery: 1 } });
    handlers.get("agent_start")![0]({ type: "agent_start" }, ctx);

    handlers.get("tool_execution_end")![0](toolEndEvent("a"), ctx);
    await flush();
    expect(registry.calls()).toHaveLength(1); // reviewer still runs mid-loop
    expect(ui.custom).not.toHaveBeenCalled(); // presentation deferred

    handlers.get("agent_end")![0]({ type: "agent_end", messages: [] }, ctx);
    expect(ui.custom).toHaveBeenCalledOnce(); // presented at completion
    expect(renderOf(customCalls[0]!)).toContain("2 heads-up");
  });

  it("renders immediately when the agent loop is idle", async () => {
    const { ui, customCalls, tools, handlers, ctx } = await setup();
    await addNoteViaTool(tools, "Idle note");
    handlers.get("tool_execution_end")![0](toolEndEvent("ysk-idle"), ctx);
    expect(ui.custom).toHaveBeenCalledOnce();
    expect(renderOf(customCalls[0]!)).toContain("1 head-up");
  });

  it("agent_settled is the safety net: refreshes the sidebar in place, idempotently", async () => {
    const { ui, customCalls, tools, handlers, ctx } = await setup();
    await addNoteViaTool(tools, "Settled note");
    handlers.get("tool_execution_end")![0](toolEndEvent("ysk-1"), ctx);
    expect(ui.custom).toHaveBeenCalledOnce();
    expect(renderOf(customCalls[0]!)).toContain("1 head-up");

    handlers.get("agent_start")![0]({ type: "agent_start" }, ctx);
    await addNoteViaTool(tools, "Second note");
    handlers.get("tool_execution_end")![0](toolEndEvent("ysk-settle"), ctx); // deferred: dirty
    expect(ui.custom).toHaveBeenCalledTimes(1);
    expect(renderOf(customCalls[0]!)).not.toContain("2 heads-up"); // snapshot not refreshed yet

    handlers.get("agent_settled")![0]({ type: "agent_settled", aborted: false }, ctx);
    expect(ui.custom).toHaveBeenCalledTimes(1); // refreshed in place, not reopened
    expect(renderOf(customCalls[0]!)).toContain("2 heads-up");
    const refreshes = customCalls[0]!.fakeTui.requestRender.mock.calls.length;

    handlers.get("agent_end")![0]({ type: "agent_end", messages: [] }, ctx);
    expect(ui.custom).toHaveBeenCalledTimes(1);
    expect(customCalls[0]!.fakeTui.requestRender.mock.calls.length).toBe(refreshes); // flag cleared: idempotent
  });

  it("defers dismissals mid-loop and flushes the emptied sidebar at agent_end", async () => {
    const { ui, customCalls, commands, tools, handlers, ctx } = await setup();
    await addNoteViaTool(tools, "Only note");
    handlers.get("tool_execution_end")![0](toolEndEvent("s1"), ctx);
    expect(ui.custom).toHaveBeenCalledTimes(1);

    handlers.get("agent_start")![0]({ type: "agent_start" }, ctx);
    await commands.get("ysk").handler("dismiss", ctx);
    expect(ui.custom).toHaveBeenCalledTimes(1); // sidebar update deferred
    expect(customCalls[0]!.resolve).not.toHaveBeenCalled(); // still open

    handlers.get("agent_end")![0]({ type: "agent_end", messages: [] }, ctx);
    expect(customCalls[0]!.resolve).toHaveBeenCalledTimes(1); // flushed: empty tally closes the sidebar
  });
});

// --- tally sidebar overlay (T2) ------------------------------------------------

describe("you-should-know tally sidebar overlay", () => {
  it("opens one non-capturing right-center overlay when notes are presented after agent_end, rendering the themed tally card", async () => {
    const { ui, customCalls, handlers, ctx } = await setup({ config: { reviewEvery: 1 } });
    handlers.get("agent_start")![0]({ type: "agent_start" }, ctx);
    handlers.get("tool_execution_end")![0](toolEndEvent("a"), ctx);
    await flush();

    handlers.get("agent_end")![0]({ type: "agent_end", messages: [] }, ctx);
    expect(ui.custom).toHaveBeenCalledOnce();
    const open = customCalls[0]!;
    expect(open.opts?.overlay).toBe(true);
    expect(open.opts?.overlayOptions).toEqual({
      anchor: "right-center",
      width: "100%",
      maxHeight: "80%",
      margin: 1,
      nonCapturing: true,
    });
    // Card frame + one body row per non-zero severity, priority order, theme
    // tokens applied, stretched to the render width (render(100) -> 100 cols:
    // title 12 chars -> 100 - 12 - 5 = 83 fill dashes, etc.).
    expect(open.component.render?.(100)).toEqual([
      `<border>╭─ <accent>✦ 2 heads-up<border> ${"─".repeat(83)}╮`,
      `<border>│ <error>■ 1 critical<border>${" ".repeat(84)} │`,
      `<border>│ <warning>■ 1 warning<border>${" ".repeat(85)} │`,
      `<border>╰${"─".repeat(98)}╯`,
    ]);
  });

  it("renders the card edge to edge: rules match each rendered width exactly", async () => {
    const { customCalls, handlers, ctx } = await setup({ config: { reviewEvery: 1 } });
    handlers.get("agent_start")![0]({ type: "agent_start" }, ctx);
    handlers.get("tool_execution_end")![0](toolEndEvent("a"), ctx);
    await flush();
    handlers.get("agent_end")![0]({ type: "agent_end", messages: [] }, ctx);
    const open = customCalls[0]!;

    // Visible columns = segment text lengths summed: strip the fake theme markup.
    const visible = (line: string): string => line.replace(/<[^>]+>/g, "");
    for (const width of [40, 100]) {
      const rows = open.component.render?.(width) ?? [];
      expect(rows.length).toBeGreaterThan(2); // top rule + body rows + bottom rule
      expect(visible(rows[0]!).length).toBe(width); // top rule spans the width
      expect(visible(rows.at(-1)!).length).toBe(width); // bottom rule too
    }
  });

  it("refreshes the open sidebar in place when another note arrives while idle", async () => {
    const { ui, customCalls, tools, handlers, ctx } = await setup();
    await addNoteViaTool(tools, "First note");
    handlers.get("tool_execution_end")![0](toolEndEvent("s1"), ctx);
    expect(customCalls).toHaveLength(1);
    const open = customCalls[0]!;
    expect(open.fakeTui.requestRender).not.toHaveBeenCalled(); // opening renders by itself

    await addNoteViaTool(tools, "Second note");
    handlers.get("tool_execution_end")![0](toolEndEvent("s2"), ctx);
    expect(ui.custom).toHaveBeenCalledOnce(); // no second overlay instance
    expect(open.fakeTui.requestRender).toHaveBeenCalledOnce(); // refreshed, not reopened
    expect(renderOf(open)).toContain("2 heads-up");
  });

  it("closes the sidebar via its done when the last note is dismissed and opens a fresh overlay for a later note", async () => {
    const { ctx, ui, commands, customCalls, tools, handlers } = await setup();
    await addNoteViaTool(tools, "Only note");
    handlers.get("tool_execution_end")![0](toolEndEvent("s1"), ctx);
    expect(customCalls).toHaveLength(1);
    const first = customCalls[0]!;

    await commands.get("ysk").handler("dismiss", ctx);
    expect(first.resolve).toHaveBeenCalledTimes(1); // done captured, invoked quiet
    expect(first.resolve).toHaveBeenCalledWith(undefined);

    await addNoteViaTool(tools, "Fresh note");
    handlers.get("tool_execution_end")![0](toolEndEvent("s2"), ctx);
    expect(ui.custom).toHaveBeenCalledTimes(2); // a NEW custom instance
    expect(customCalls[1]!.component).not.toBe(first.component);
  });

  it("defers the sidebar mid-loop: no custom open and no refresh until agent_end", async () => {
    const { ui, customCalls, registry, handlers, ctx } = await setup({ config: { reviewEvery: 1 } });
    handlers.get("agent_start")![0]({ type: "agent_start" }, ctx);
    handlers.get("tool_execution_end")![0](toolEndEvent("a"), ctx);
    await flush();
    expect(registry.calls()).toHaveLength(1); // the reviewer still ran mid-loop
    expect(ui.custom).not.toHaveBeenCalled(); // presentation deferred

    handlers.get("agent_end")![0]({ type: "agent_end", messages: [] }, ctx);
    expect(ui.custom).toHaveBeenCalledOnce(); // flushed at the loop boundary
  });

  it("closes an open sidebar exactly once via cleanup on session_shutdown; the next session opens fresh", async () => {
    const { ui, customCalls, tools, handlers, ctx } = await setup();
    await addNoteViaTool(tools, "Sticky note");
    handlers.get("tool_execution_end")![0](toolEndEvent("s1"), ctx);
    expect(customCalls).toHaveLength(1);
    const first = customCalls[0]!;

    handlers.get("session_shutdown")![0]({ type: "session_shutdown", reason: "quit" }, ctx);
    expect(first.resolve).toHaveBeenCalledTimes(1); // done-capture cleanup, exactly once

    await handlers.get("session_start")![0]({ type: "session_start", reason: "resume" }, ctx);
    await addNoteViaTool(tools, "Fresh session note");
    handlers.get("tool_execution_end")![0](toolEndEvent("s2"), ctx);
    expect(ui.custom).toHaveBeenCalledTimes(2); // state was cleared: a fresh open
  });

  it("headless mode never opens the sidebar overlay", async () => {
    const { ui, tools, handlers, ctx } = await setup({ hasUI: false });
    await addNoteViaTool(tools, "Headless note");
    handlers.get("tool_execution_end")![0](toolEndEvent("s"), ctx);
    await flush();
    expect(ui.custom).not.toHaveBeenCalled();
  });

  it("a stale session's overlay renders nothing and its mouse hook stays dead", async () => {
    const { customCalls, tools, handlers, ctx } = await setup();
    await addNoteViaTool(tools, "Guard note");
    handlers.get("tool_execution_end")![0](toolEndEvent("s1"), ctx);
    const open = customCalls[0]!;

    handlers.get("session_shutdown")![0]({ type: "session_shutdown", reason: "quit" }, ctx);
    // pi may still hold the overlay for a frame after disposal: a stale
    // generation must never repaint session state or open a popup.
    expect(open.component.render?.(100)).toEqual([]);
    expect(open.component.handleMouse?.({ type: "down" })).toBeUndefined();
  });

  it("rpc mode never opens the sidebar even with pending notes", async () => {
    const { ui, tools, handlers, ctx } = await setup({ ctxOverrides: { mode: "rpc" } });
    await addNoteViaTool(tools, "Rpc note");
    handlers.get("tool_execution_end")![0](toolEndEvent("rpc-1"), ctx);
    await flush();
    expect(ui.custom).not.toHaveBeenCalled();
  });
});

// --- note popup (T3) -----------------------------------------------------------

describe("you-should-know note popup", () => {
  it("bare /ysk opens a centered capturing popup: list rows for 2+ pending, detail rows for exactly 1", async () => {
    const { ui, popup } = await setupWithPopup(["Silent assumption", "Hidden decision"], ["warning", "critical"]);
    expect(ui.custom).toHaveBeenCalledTimes(2); // sidebar + popup
    expect(popup.opts?.overlay).toBe(true);
    expect(popup.opts?.overlayOptions).toEqual({ anchor: "center", width: "60%", maxHeight: "60%", margin: 1 });
    expect(popup.component.render?.(100)).toEqual([
      "<muted>Heads up",
      "<error>1. [critical] Hidden decision",
      "<warning>2. [warning] Silent assumption",
      "<muted>number to open · Esc to close",
    ]);

    const single = await setupWithPopup(["Only note"]);
    expect(single.popup.component.render?.(100)).toEqual([
      "<accent>Heads up · Only note",
      "<accent>",
      "<accent>Only note",
      "<accent>",
      "<muted>1: Understood",
      "<muted>2: Chat in main session",
      "<muted>0: Dismiss",
    ]);
  });

  it("list stage: pressing a note number switches to that note's detail rows (row 1 is the newest)", async () => {
    const { popup } = await setupWithPopup(["First note", "Second note"]);
    popup.component.handleInput!("1");
    const rows = popup.component.render?.(100) ?? [];
    expect(rows.join("\n")).toContain("Heads up · Second note"); // newest first
    expect(rows.join("\n")).not.toContain("number to open");
  });

  it("detail stage: '1' (Understood) marks processed, closes the popup, and refreshes the sidebar", async () => {
    const { ctx, ui, popup, sidebar } = await setupWithPopup(
      ["Silent assumption", "Hidden decision"],
      ["warning", "critical"],
    );
    popup.component.handleInput!("1"); // open note 1
    popup.component.handleInput!("1"); // Understood
    expect(popup.resolve).toHaveBeenCalledTimes(1); // popup closed
    expect(sidebar.resolve).not.toHaveBeenCalled(); // one note still pending
    expect(ui.setEditorText).not.toHaveBeenCalled(); // non-destructive: no editor fill
    expect(sidebar.fakeTui.requestRender).toHaveBeenCalled(); // sidebar refreshed in place
    expect(renderOf(sidebar)).toContain("1 head-up");
    void ctx;
  });

  it("detail stage: '2' (Chat) fills the editor, marks processed, and closes", async () => {
    const { popup, sidebar, ui } = await setupWithPopup(["Only note\ndetail body"], ["warning"]);
    popup.component.handleInput!("2");
    expect(ui.setEditorText).toHaveBeenCalledOnce();
    const text = ui.setEditorText.mock.calls[0]![0] as string;
    expect(text).toContain("Re: heads-up — please address");
    expect(text).toContain("Only note");
    expect(text).toContain("detail body");
    expect(popup.resolve).toHaveBeenCalledTimes(1);
    expect(sidebar.resolve).toHaveBeenCalledTimes(1); // last note processed -> sidebar closes
    expect(sidebar.fakeTui.requestRender).toHaveBeenCalled(); // editor repaint through the captured TUI
  });

  it("detail stage: '0' (Dismiss) hides the note for the session and closes the popup", async () => {
    const { popup, sidebar } = await setupWithPopup(["Noisy note"]);
    popup.component.handleInput!("0");
    expect(popup.resolve).toHaveBeenCalledTimes(1);
    expect(sidebar.resolve).toHaveBeenCalledTimes(1);
    expect(readProjectConfig().dismissedTopics ?? []).toHaveLength(0); // session-scoped, not persisted
  });

  it("Esc closes the popup without processing (kitty CSI-u and legacy forms)", async () => {
    const first = await setupWithPopup(["Pending note"]);
    first.popup.component.handleInput!("\x1b[27u"); // kitty CSI-u escape
    expect(first.popup.resolve).toHaveBeenCalledTimes(1);
    expect(first.sidebar.resolve).not.toHaveBeenCalled();
    expect(renderOf(first.sidebar)).toContain("1 head-up"); // note still pending

    // Legacy bare-ESC byte sequence: same behavior on a freshly opened popup.
    await first.commands.get("ysk").handler("", first.ctx);
    const reopened = first.customCalls.at(-1)!;
    reopened.component.handleInput!("\x1b");
    expect(reopened.resolve).toHaveBeenCalledTimes(1);
    expect(first.sidebar.resolve).not.toHaveBeenCalled();
    expect(renderOf(first.sidebar)).toContain("1 head-up");
  });

  it("handleMouse picks a list row and fires the trailing detail action rows", async () => {
    const { popup, ui } = await setupWithPopup(["Silent assumption", "Hidden decision"], ["warning", "critical"]);
    popup.component.handleMouse!(clickEvent(1)); // "1. [critical] Hidden decision" (newest first)
    expect(renderOf(popup)).toContain("Heads up · Hidden decision"); // switched to detail

    // Detail rows: header(0), blank(1), detail(2), blank(3), then the 3-row hint block.
    popup.component.handleMouse!(clickEvent(5)); // "2: Chat in main session"
    expect(ui.setEditorText).toHaveBeenCalledOnce();
    expect((ui.setEditorText.mock.calls[0]![0] as string)).toContain("Hidden decision");
    expect(popup.resolve).toHaveBeenCalledTimes(1); // chat closes the popup
  });

  it("a detail text row that literally starts '2: Chat' is never an action", async () => {
    const { popup, ui } = await setupWithPopup(["2: Chat would be a mistake here"]);
    const rows = popup.component.render?.(100) ?? [];
    const trickyAt = rows.findIndex((row, index) => index > 0 && row.includes("2: Chat would be a mistake"));
    expect(trickyAt).toBeGreaterThan(0);
    expect(trickyAt).toBeLessThan(rows.length - 3); // outside the trailing hint block

    popup.component.handleMouse!(clickEvent(trickyAt));
    expect(ui.setEditorText).not.toHaveBeenCalled(); // no action fired
    expect(popup.resolve).not.toHaveBeenCalled(); // popup stays open
  });

  it("processing notes shrinks the sidebar tally and closes it when the last one is processed", async () => {
    const { ctx, commands, sidebar, customCalls } = await setupWithPopup(
      ["Silent assumption", "Hidden decision"],
      ["warning", "critical"],
    );
    customCalls[1]!.component.handleInput!("1"); // detail: note 1
    customCalls[1]!.component.handleInput!("1"); // Understood
    expect(renderOf(sidebar)).toContain("1 head-up");
    expect(sidebar.resolve).not.toHaveBeenCalled();

    await commands.get("ysk").handler("", ctx); // reopen for the remaining note -> detail
    customCalls[2]!.component.handleInput!("1"); // Understood
    expect(sidebar.resolve).toHaveBeenCalledTimes(1); // empty tally -> sidebar done invoked
  });

  it("opening a popup closes the previous one first: exactly one popup at a time", async () => {
    const { ctx, commands, customCalls } = await setupWithPopup(["Only note"]);
    await commands.get("ysk").handler("", ctx);
    expect(customCalls[1]!.resolve).toHaveBeenCalledTimes(1); // first popup closed
    expect(customCalls[2]).toBeDefined(); // replacement popup is open
  });

  it("session_shutdown closes an open popup alongside the sidebar", async () => {
    const { ctx, handlers, popup, sidebar } = await setupWithPopup(["Only note"]);
    handlers.get("session_shutdown")![0]({ type: "session_shutdown", reason: "quit" }, ctx);
    expect(popup.resolve).toHaveBeenCalledTimes(1);
    expect(sidebar.resolve).toHaveBeenCalledTimes(1);
  });

  it("headless mode: /ysk never opens a popup", async () => {
    const { ctx, ui, commands, tools, handlers } = await setup({ hasUI: false });
    await addNoteViaTool(tools, "Headless note");
    handlers.get("tool_execution_end")![0](toolEndEvent("headless"), ctx);
    await commands.get("ysk").handler("", ctx);
    await commands.get("ysk").handler("learn 1", ctx);
    expect(ui.custom).not.toHaveBeenCalled();
  });

  it("/ysk status stays textual: no popup, no overlay change", async () => {
    const { ctx, ui, commands } = await setupWithPopup(["Only note"]);
    const opensBefore = ui.custom.mock.calls.length;
    await commands.get("ysk").handler("status", ctx);
    expect(ui.custom.mock.calls).toHaveLength(opensBefore);
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("pending notes: 1"), "info");
  });

  it("clicking a sidebar severity row opens the filtered popup; the header opens all", async () => {
    const { ctx, ui, customCalls, tools, handlers } = await setup();
    await addNoteViaTool(tools, "Warning one", "warning");
    handlers.get("tool_execution_end")![0](toolEndEvent("s1"), ctx);
    await addNoteViaTool(tools, "Warning two", "warning");
    handlers.get("tool_execution_end")![0](toolEndEvent("s2"), ctx);
    await addNoteViaTool(tools, "Critical note", "critical");
    handlers.get("tool_execution_end")![0](toolEndEvent("s3"), ctx);
    expect(ui.custom).toHaveBeenCalledTimes(1); // only the sidebar so far
    const sidebar = customCalls[0]!;

    // Header click -> all notes, list stage, newest first.
    sidebar.component.handleMouse!(clickEvent(0));
    expect(ui.custom).toHaveBeenCalledTimes(2);
    expect(customCalls[1]!.component.render?.(100)).toEqual([
      "<muted>Heads up",
      "<error>1. [critical] Critical note",
      "<warning>2. [warning] Warning two",
      "<warning>3. [warning] Warning one",
      "<muted>number to open · Esc to close",
    ]);

    // Severity row click -> exactly that severity; the previous popup closed first.
    sidebar.component.handleMouse!(clickEvent(2)); // "■ 2 warning"
    expect(customCalls[1]!.resolve).toHaveBeenCalledTimes(1);
    expect(customCalls[2]!.component.render?.(100)).toEqual([
      "<muted>Heads up",
      "<warning>1. [warning] Warning two",
      "<warning>2. [warning] Warning one",
      "<muted>number to open · Esc to close",
    ]);
  });

  it("a severity filter with exactly one match opens the detail stage directly", async () => {
    const { ctx, ui, customCalls, tools, handlers } = await setup();
    await addNoteViaTool(tools, "Lone warning", "warning");
    handlers.get("tool_execution_end")![0](toolEndEvent("s1"), ctx);
    await addNoteViaTool(tools, "A critical", "critical");
    handlers.get("tool_execution_end")![0](toolEndEvent("s2"), ctx);
    const sidebar = customCalls[0]!;

    sidebar.component.handleMouse!(clickEvent(2)); // "■ 1 warning"
    expect(ui.custom).toHaveBeenCalledTimes(2);
    expect(customCalls[1]!.component.render?.(100)).toEqual([
      "<warning>Heads up · Lone warning",
      "<accent>",
      "<accent>Lone warning",
      "<accent>",
      "<muted>1: Understood",
      "<muted>2: Chat in main session",
      "<muted>0: Dismiss",
    ]);
  });
});
