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
  const ui = {
    notify: vi.fn(),
    setWidget: vi.fn(),
    custom: vi.fn(async (..._args: unknown[]) => undefined),
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
  return { ctx, ui };
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
  const { ctx, ui } = mockCtx(registry, { hasUI: options.hasUI ?? true, ...options.ctxOverrides });
  youShouldKnowExtension(pi as never);
  await handlers.get("session_start")![0]({ type: "session_start", reason: "startup" }, ctx);
  return { registry, ctx, ui, sent, tools, commands, handlers };
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

// --- tests -------------------------------------------------------------------

describe("you-should-know wiring", () => {
  it("registers the heads_up tool, the /ysk command, and lifecycle handlers", async () => {
    const { tools, commands, handlers } = await setup();
    expect(tools.get("heads_up")?.parameters).toBeDefined();
    expect(commands.get("ysk")?.handler).toBeTypeOf("function");
    for (const event of ["session_start", "session_shutdown", "tool_execution_end"]) {
      expect(handlers.get(event)?.length).toBe(1);
    }
  });

  it("session_start loads project config and clears the widget baseline", async () => {
    const { ui } = await setup({ config: { reviewEvery: 2 } });
    expect(ui.setWidget).toHaveBeenCalledWith("ysk", undefined, { placement: "aboveEditor" });
  });

  it("is headless-safe: no widget or overlay calls, review still runs", async () => {
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

  it("/ysk learn opens the overlay only with a TUI-capable context", async () => {
    const { ctx, ui, commands, tools } = await setup();
    await addNoteViaTool(tools, "Some assumption");
    await commands.get("ysk").handler("learn", ctx);
    expect(ui.custom).toHaveBeenCalledOnce();
    expect(ui.custom.mock.calls[0]![1]).toMatchObject({ overlay: true });

    const headless = await setup({ hasUI: false });
    await addNoteViaTool(headless.tools, "Another assumption");
    await headless.commands.get("ysk").handler("learn", headless.ctx);
    expect(headless.ui.custom).not.toHaveBeenCalled();
  });

  it("learn overlay closes on ESC in legacy and kitty keyboard encodings", async () => {
    const { ctx, ui, commands, tools } = await setup();
    await addNoteViaTool(tools, "Some assumption");
    await commands.get("ysk").handler("learn", ctx);

    type OverlayFactory = (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: () => void,
    ) => { handleInput: (data: string) => void };
    const factory = ui.custom.mock.calls[0]![0] as OverlayFactory;

    // Legacy ESC byte and kitty-protocol CSI-u sequence must both close.
    for (const esc of ["\x1b", "\x1b[27u"]) {
      let closed = false;
      const component = factory(undefined, ctx.ui.theme, undefined, () => {
        closed = true;
      });
      component.handleInput(esc);
      expect(closed, `ESC sequence ${JSON.stringify(esc)} must close the overlay`).toBe(true);
    }

    // Regular keys must not close the overlay.
    let stayedOpen = true;
    const component = factory(undefined, ctx.ui.theme, undefined, () => {
      stayedOpen = false;
    });
    component.handleInput("x");
    expect(stayedOpen).toBe(true);
  });

  it("/ysk known persists the dismissal into the project config", async () => {
    const { ctx, commands, tools } = await setup();
    await addNoteViaTool(tools, "Deployment gate is manual");
    await commands.get("ysk").handler("known", ctx);
    expect(readProjectConfig().dismissedTopics).toContain("deployment gate is manual");
  });

  it("/ysk chat frames the note for the main session", async () => {
    const { ctx, commands, tools, sent } = await setup();
    await addNoteViaTool(tools, "Deployment gate is manual");
    await commands.get("ysk").handler("chat", ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Re: heads-up — please address");
    expect(sent[0]).toContain("Deployment gate is manual");
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
});
