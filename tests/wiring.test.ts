import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import youShouldKnowExtension, { flushPendingNoteWrites } from "../src/index.ts";

// --- fixtures --------------------------------------------------------------

const FIXTURES = mkdtempSync(join(tmpdir(), "ysk-wiring-"));
const CWD = join(FIXTURES, "ws");
const PROJECT_CONFIG = join(CWD, ".pi", "you-should-know.json");
const PROJECT_NOTES = join(CWD, ".pi", "you-should-know-notes.json");
afterAll(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
});

function writeProjectConfig(config: Record<string, unknown>): void {
  mkdirSync(join(CWD, ".pi"), { recursive: true });
  writeFileSync(PROJECT_CONFIG, JSON.stringify(config), "utf8");
}

/**
 * Seed the per-project pending-notes state file. An array seeds
 * `{ notes: [...] }`; a string seeds raw file content (corrupt fixtures).
 */
function writePendingNotes(notes: unknown[] | string): void {
  mkdirSync(join(CWD, ".pi"), { recursive: true });
  const text = typeof notes === "string" ? notes : JSON.stringify({ notes });
  writeFileSync(PROJECT_NOTES, text, "utf8");
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
    notes?: unknown[] | string;
    hasUI?: boolean;
    outcome?: StreamOutcome;
    ctxOverrides?: Record<string, unknown>;
    /** Factory override env; defaults to a fixture HOME so relay dirs never touch the real agent home. */
    env?: NodeJS.ProcessEnv;
    /** Factory override relay dir (injected tmp dir for relay tests). */
    relayDir?: string;
  } = {},
) {
  writeProjectConfig(options.config ?? {});
  // Deterministic baseline: a previous test's fire-and-forget notes write
  // may still be in flight, so drain the serialized write chain (a blind
  // timeout cannot) before removing the state file — otherwise the stale
  // write would land after the removal and leak notes into this session's
  // restore.
  await flushPendingNoteWrites();
  if (options.notes === undefined) rmSync(PROJECT_NOTES, { force: true });
  else writePendingNotes(options.notes);
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
  youShouldKnowExtension(pi as never, {
    env: options.env ?? { HOME: FIXTURES },
    ...(options.relayDir !== undefined ? { relayDir: options.relayDir } : {}),
  });
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

// --- gentle-pi experimental fullscreen rail fixtures (T9) ---------------------

const GENTLE_STATE = Symbol.for("gentle-pi.experimental-sidebar.state");
const GENTLE_CACHE = Symbol.for("gentle-pi.experimental-sidebar.cache");

/** The planted gentle-pi sidebar state + invalidation cache on a fake TUI. */
interface PlantedRail {
  state: { active: boolean; ownsHost: ReturnType<typeof vi.fn>; parts: Map<string, any> };
  cache: { revision: number };
}

/** The subset of the widget/rail component surface the rail tests drive. */
interface RailSurface {
  render?: (width?: number) => string[];
  digest?: () => string;
  handleMouse?: (event: unknown) => unknown;
  invalidate?: () => void;
  dispose?: () => void;
}

/**
 * Plant a gentle-pi experimental sidebar (state + cache behind the two
 * Symbol.for keys) on the fake TUI's terminal, exactly as the real shell
 * stores them.
 */
function plantGentleRail(fakeTui: Record<string, unknown>): PlantedRail {
  const rail: PlantedRail = {
    state: { active: false, ownsHost: vi.fn(() => false), parts: new Map() },
    cache: { revision: 0 },
  };
  fakeTui.terminal = { [GENTLE_STATE]: rail.state, [GENTLE_CACHE]: rail.cache };
  return rail;
}

/** The you-should-know widget factory recorded by setWidget, invoked against the planted TUI. */
function invokeWidget(session: Awaited<ReturnType<typeof setup>>, rail: PlantedRail): { component: RailSurface; part: RailSurface } {
  const call = session.ui.setWidget.mock.calls.find((entry) => entry[0] === "you-should-know");
  if (!call) throw new Error("you-should-know widget was not registered");
  const component = (call[1] as (tui: unknown, theme: unknown) => RailSurface)(session.fakeOverlayTui, fakeTheme);
  const part = rail.state.parts.get("ysk");
  if (!part) throw new Error("ysk rail part was not registered");
  return { component, part };
}

const RAIL_NOTES = [
  { topic: "silent assumption", severity: "warning", title: "Silent assumption", detail: "detail a" },
  { topic: "hidden decision", severity: "critical", title: "Hidden decision", detail: "detail b" },
];

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
    expect(renderOf(customCalls[1]!)).toContain("✦ Heads up"); // the framed card title
    expect(renderOf(customCalls[1]!)).toContain("Some assumption"); // the severity title row

    // learn <n> targets the 1-based note, not just the newest.
    const two = await setup();
    await addNoteViaTool(two.tools, "Older note");
    await addNoteViaTool(two.tools, "Newest note");
    two.handlers.get("tool_execution_end")![0](toolEndEvent("ysk-older"), two.ctx);
    await two.commands.get("ysk").handler("learn 1", two.ctx);
    expect(renderOf(two.customCalls[1]!)).toContain("Older note");

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
      width: "30%",
      minWidth: 24,
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

// --- gentle-pi experimental fullscreen rail (T9) --------------------------------

describe("you-should-know gentle-pi fullscreen rail", () => {
  it("session_start registers a widget whose factory docks a ysk part into the planted rail", async () => {
    const session = await setup({ notes: RAIL_NOTES });
    const rail = plantGentleRail(session.fakeOverlayTui);
    const { component } = invokeWidget(session, rail);
    // Regular-mode presence stays empty: the overlay is the non-rail surface.
    expect(component.render?.(100)).toEqual([]);
    expect(rail.state.parts.get("ysk")).toBeDefined();
  });

  it("the ysk part renders the exact themed heads-up card at rail width 48, newest first", async () => {
    const session = await setup({ notes: RAIL_NOTES });
    const rail = plantGentleRail(session.fakeOverlayTui);
    const { part } = invokeWidget(session, rail);
    // Newest first: the critical "Hidden decision" (added last in the seed) leads.
    expect(part.render?.(48)).toEqual([
      `<border>╭─ <accent>✦ Heads up · 2<border> ${"─".repeat(29)}╮`,
      `<border>│ <error>■ Hidden decision<border>${" ".repeat(27)} │`,
      `<border>│ <warning>■ Silent assumption<border>${" ".repeat(25)} │`,
      `<border>╰${"─".repeat(46)}╯`,
    ]);
    // Cheap memo key for gentle-pi's section cache: the oldest-first snapshot.
    expect(part.digest?.()).toBe(JSON.stringify(RAIL_NOTES));
  });

  it("clicking a note row opens that note's detail popup directly", async () => {
    const session = await setup({ notes: RAIL_NOTES });
    const rail = plantGentleRail(session.fakeOverlayTui);
    const { part } = invokeWidget(session, rail);
    part.render?.(48);
    const opens = session.ui.custom.mock.calls.length;
    expect(part.handleMouse?.(clickEvent(1))).toEqual({ handled: true }); // row 1 -> first rendered note
    expect(session.ui.custom.mock.calls.length).toBe(opens + 1);
    const popup = session.customCalls.at(-1)!;
    const rows = popup.component.render?.(100) ?? [];
    expect(rows.join("\n")).toContain("Hidden decision"); // a Note target skips the list stage
    expect(rows.join("\n")).toContain("detail b");
  });

  it("a click on a wrapped continuation row does nothing; the group's first row still opens", async () => {
    const session = await setup({
      notes: [{ topic: "wrap topic", severity: "info", title: "A very long title that must wrap across several rail rows", detail: "d" }],
    });
    const rail = plantGentleRail(session.fakeOverlayTui);
    const { part } = invokeWidget(session, rail);
    part.render?.(48);
    const opens = session.ui.custom.mock.calls.length;
    expect(part.handleMouse?.(clickEvent(2))).toBeUndefined(); // "several rail rows" continuation
    expect(session.ui.custom.mock.calls.length).toBe(opens); // no popup
    expect(part.handleMouse?.(clickEvent(1))).toEqual({ handled: true }); // first row opens
    expect(session.ui.custom.mock.calls.length).toBe(opens + 1);
  });

  it("changing notes (tool add) bumps the rail cache revision so the rail re-renders", async () => {
    const session = await setup({ notes: RAIL_NOTES });
    const rail = plantGentleRail(session.fakeOverlayTui);
    invokeWidget(session, rail);
    const before = rail.cache.revision;
    await addNoteViaTool(session.tools, "Fresh rail note", "info");
    session.handlers.get("tool_execution_end")![0](toolEndEvent("rail-1"), session.ctx);
    expect(rail.cache.revision).toBeGreaterThan(before);
  });

  it("the tally overlay paints nothing while the gentle rail owns the host, and returns on mode switch", async () => {
    const session = await setup({ notes: RAIL_NOTES });
    const rail = plantGentleRail(session.fakeOverlayTui);
    invokeWidget(session, rail);
    const sidebar = session.customCalls[0]!;
    expect(renderOf(sidebar)).toContain("2 heads-up"); // fallback renders normally while inactive

    rail.state.active = true;
    rail.state.ownsHost = vi.fn(() => true);
    expect(sidebar.component.render?.(100)).toEqual([]); // suppressed: the rail paints the card

    // active but NOT owning the host (e.g. narrow mode): the overlay shows again.
    rail.state.ownsHost = vi.fn(() => false);
    expect(renderOf(sidebar)).toContain("2 heads-up");

    rail.state.ownsHost = vi.fn(() => true);
    rail.state.active = false;
    expect(renderOf(sidebar)).toContain("2 heads-up"); // mode switch needs no reopen logic
  });

  it("dispose removes only its own ysk part", async () => {
    const session = await setup({ notes: RAIL_NOTES });
    const rail = plantGentleRail(session.fakeOverlayTui);
    const { component, part } = invokeWidget(session, rail);
    expect(rail.state.parts.get("ysk")).toBe(part);

    // Someone else owns the slot now: our dispose must not delete theirs.
    const replacement: RailSurface = { render: () => [] };
    rail.state.parts.set("ysk", replacement);
    component.dispose?.();
    expect(rail.state.parts.get("ysk")).toBe(replacement);

    // A fresh factory re-registers, and its own dispose removes the part.
    const fresh = invokeWidget(session, rail);
    expect(rail.state.parts.get("ysk")).toBe(fresh.part);
    fresh.component.dispose?.();
    expect(rail.state.parts.has("ysk")).toBe(false);
  });

  it("without a gentle rail state no part registers and the fallback overlay renders the card normally", async () => {
    const session = await setup({ notes: RAIL_NOTES }); // no terminal planted: no rail symbols
    const call = session.ui.setWidget.mock.calls.find((entry) => entry[0] === "you-should-know");
    expect(call).toBeDefined();
    const component = (call![1] as (tui: unknown, theme: unknown) => RailSurface)(session.fakeOverlayTui, fakeTheme);
    expect(component.render?.(100)).toEqual([]); // the widget paints nothing without a rail
    expect(renderOf(session.customCalls[0]!)).toContain("2 heads-up"); // regression: the fallback card
  });
});

// --- note popup (T3) -----------------------------------------------------------

describe("you-should-know note popup", () => {
  it("bare /ysk opens a centered capturing popup: framed list rows for 2+ pending, detail rows for exactly 1", async () => {
    const { ui, popup } = await setupWithPopup(["Silent assumption", "Hidden decision"], ["warning", "critical"]);
    expect(ui.custom).toHaveBeenCalledTimes(2); // sidebar + popup
    expect(popup.opts?.overlay).toBe(true);
    expect(popup.opts?.overlayOptions).toEqual({ anchor: "center", width: "80%", maxHeight: "80%", margin: 1 });
    // render(100): the overlay's resolved width is 100 cols. Card title
    // "✦ Heads up" is 10 chars -> top-rule fill = 100 - 10 - 5 = 85 dashes;
    // each body row pads to 100 - 4 - <text length> spaces.
    expect(popup.component.render?.(100)).toEqual([
      `<border>╭─ <accent>✦ Heads up<border> ${"─".repeat(85)}╮`,
      // "1. [critical] Hidden decision" = 29 chars -> pad = 100 - 4 - 29 = 67
      `<border>│ <error>1. [critical] Hidden decision<border>${" ".repeat(67)} │`,
      // "2. [warning] Silent assumption" = 30 chars -> pad = 100 - 4 - 30 = 66
      `<border>│ <warning>2. [warning] Silent assumption<border>${" ".repeat(66)} │`,
      // hint = 29 chars -> pad = 100 - 4 - 29 = 67
      `<border>│ <muted>number to open · Esc to close<border>${" ".repeat(67)} │`,
      `<border>╰${"─".repeat(98)}╯`,
    ]);

    const single = await setupWithPopup(["Only note"]);
    expect(single.popup.component.render?.(100)).toEqual([
      `<border>╭─ <accent>✦ Heads up<border> ${"─".repeat(85)}╮`,
      // title row "Only note" = 9 chars -> pad = 100 - 4 - 9 = 87; info severity -> accent
      `<border>│ <accent>Only note<border>${" ".repeat(87)} │`,
      `<border>│ <accent><border>${" ".repeat(96)} │`, // blank row: pad = 100 - 4 - 0
      `<border>│ <accent>Only note<border>${" ".repeat(87)} │`, // detail = the full note text
      `<border>│ <accent><border>${" ".repeat(96)} │`,
      // "1: Understood" = 13 -> pad 83; "2: Chat in main session" = 23 -> 73; "0: Dismiss" = 10 -> 86
      `<border>│ <muted>1: Understood<border>${" ".repeat(83)} │`,
      `<border>│ <muted>2: Chat in main session<border>${" ".repeat(73)} │`,
      `<border>│ <muted>0: Dismiss<border>${" ".repeat(86)} │`,
      `<border>╰${"─".repeat(98)}╯`,
    ]);
  });

  it("list stage: pressing a note number switches to that note's detail rows (row 1 is the newest)", async () => {
    const { popup } = await setupWithPopup(["First note", "Second note"]);
    popup.component.handleInput!("1");
    const rows = popup.component.render?.(100) ?? [];
    expect(rows.join("\n")).toContain("✦ Heads up"); // framed card title
    expect(rows.join("\n")).toContain("Second note"); // newest first: the body title row
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

  it("handleMouse picks a list row and fires the hint rows above the bottom rule", async () => {
    const { popup, ui } = await setupWithPopup(["Silent assumption", "Hidden decision"], ["warning", "critical"]);
    popup.component.handleMouse!(clickEvent(1)); // first framed body row: "1. [critical] Hidden decision"
    expect(renderOf(popup)).toContain("✦ Heads up"); // switched to the framed detail card
    expect(renderOf(popup)).toContain("Hidden decision");

    // Framed detail rows: top(0), title(1), blank(2), detail(3), blank(4),
    // hints(5-7), bottom rule(8) — the hint block sits just above the rule.
    popup.component.handleMouse!(clickEvent(6)); // "2: Chat in main session"
    expect(ui.setEditorText).toHaveBeenCalledOnce();
    expect((ui.setEditorText.mock.calls[0]![0] as string)).toContain("Hidden decision");
    expect(popup.resolve).toHaveBeenCalledTimes(1); // chat closes the popup
  });

  it("clicking a wrapped list entry's FIRST row still opens its detail", async () => {
    const longTitle = "Assumption that stretches across several wrapped popup rows at click width";
    // Newest first: the long note is added LAST, so it renders as list row 1.
    const { popup } = await setupWithPopup(["Short note", longTitle]);
    // Its text wraps at the click rebuild width (60 cols, no render has run
    // yet): row 1 is only its first wrapped fragment, and hitting it must
    // still open the detail stage.
    popup.component.handleMouse!(clickEvent(1));
    const rows = popup.component.render?.(100) ?? [];
    expect(rows.join("\n")).toContain("Assumption that stretches");
    expect(rows.join("\n")).not.toContain("number to open"); // detail stage, not the list
  });

  it("a detail row that literally starts '2: Chat' is never an action", async () => {
    const { popup, ui } = await setupWithPopup(["2: Chat would be a mistake here"]);
    const rows = popup.component.render?.(100) ?? [];
    // The text appears on the severity title row AND the detail body row; the
    // actionable block is the 3 hint rows just above the bottom rule, so both
    // occurrences sit outside it and must stay inert.
    const trickyAts = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.includes("2: Chat would be a mistake"))
      .map(({ index }) => index);
    expect(trickyAts.length).toBe(2);
    for (const at of trickyAts) {
      expect(at).toBeLessThan(rows.length - 1 - 3); // outside the framed actionable block
      popup.component.handleMouse!(clickEvent(at));
      expect(ui.setEditorText).not.toHaveBeenCalled(); // no action fired
      expect(popup.resolve).not.toHaveBeenCalled(); // popup stays open
    }
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

    // Header click -> all notes, list stage, newest first. render(100):
    // card title 10 chars -> fill 85; body pads = 100 - 4 - <text length>.
    sidebar.component.handleMouse!(clickEvent(0));
    expect(ui.custom).toHaveBeenCalledTimes(2);
    expect(customCalls[1]!.component.render?.(100)).toEqual([
      `<border>╭─ <accent>✦ Heads up<border> ${"─".repeat(85)}╮`,
      // "1. [critical] Critical note" = 27 chars -> pad = 100 - 4 - 27 = 69
      `<border>│ <error>1. [critical] Critical note<border>${" ".repeat(69)} │`,
      // "2. [warning] Warning two" = 24 chars -> pad = 100 - 4 - 24 = 72
      `<border>│ <warning>2. [warning] Warning two<border>${" ".repeat(72)} │`,
      `<border>│ <warning>3. [warning] Warning one<border>${" ".repeat(72)} │`,
      // hint = 29 chars -> pad = 100 - 4 - 29 = 67
      `<border>│ <muted>number to open · Esc to close<border>${" ".repeat(67)} │`,
      `<border>╰${"─".repeat(98)}╯`,
    ]);

    // Severity row click -> exactly that severity; the previous popup closed first.
    sidebar.component.handleMouse!(clickEvent(2)); // "■ 2 warning"
    expect(customCalls[1]!.resolve).toHaveBeenCalledTimes(1);
    expect(customCalls[2]!.component.render?.(100)).toEqual([
      `<border>╭─ <accent>✦ Heads up<border> ${"─".repeat(85)}╮`,
      `<border>│ <warning>1. [warning] Warning two<border>${" ".repeat(72)} │`,
      `<border>│ <warning>2. [warning] Warning one<border>${" ".repeat(72)} │`,
      `<border>│ <muted>number to open · Esc to close<border>${" ".repeat(67)} │`,
      `<border>╰${"─".repeat(98)}╯`,
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
    // Framed detail card at render width 100: title 10 -> fill 85; body pads
    // = 100 - 4 - <text length> ("Lone warning" = 12 -> 84; blanks -> 96;
    // hint rows 13/23/10 -> 83/73/86).
    expect(customCalls[1]!.component.render?.(100)).toEqual([
      `<border>╭─ <accent>✦ Heads up<border> ${"─".repeat(85)}╮`,
      `<border>│ <warning>Lone warning<border>${" ".repeat(84)} │`,
      `<border>│ <accent><border>${" ".repeat(96)} │`,
      `<border>│ <accent>Lone warning<border>${" ".repeat(84)} │`,
      `<border>│ <accent><border>${" ".repeat(96)} │`,
      `<border>│ <muted>1: Understood<border>${" ".repeat(83)} │`,
      `<border>│ <muted>2: Chat in main session<border>${" ".repeat(73)} │`,
      `<border>│ <muted>0: Dismiss<border>${" ".repeat(86)} │`,
      `<border>╰${"─".repeat(98)}╯`,
    ]);
  });
});

// --- pending-note persistence (T8) ----------------------------------------------

describe("you-should-know pending-note persistence", () => {
  const PERSISTED_NOTES = [
    { topic: "silent assumption", severity: "warning", title: "Silent assumption", detail: "detail a" },
    { topic: "hidden decision", severity: "critical", title: "Hidden decision", detail: "detail b" },
  ];

  it("restores seeded pending notes into the sidebar tally on session_start", async () => {
    const { ui, customCalls } = await setup({ notes: PERSISTED_NOTES });
    expect(ui.custom).toHaveBeenCalledOnce(); // the tally opens with the restored notes
    const text = renderOf(customCalls[0]!);
    expect(text).toContain("2 heads-up");
    expect(text).toContain("1 critical");
    expect(text).toContain("1 warning");
  });

  it("filters permanently dismissed topics out of the restore", async () => {
    const { ui, customCalls } = await setup({
      config: { dismissedTopics: ["hidden decision"] },
      notes: PERSISTED_NOTES,
    });
    expect(ui.custom).toHaveBeenCalledOnce();
    const text = renderOf(customCalls[0]!);
    expect(text).toContain("1 head-up");
    expect(text).toContain("1 warning");
    expect(text).not.toContain("critical");
  });

  it("restores live seeded notes even when the project config lists dismissed topics (load-before-mutate)", async () => {
    // Regression pin for the confirmed initSession race: the reseed's
    // persistPending writes used to be enqueued BEFORE the state-file read
    // and could win it, so the restore saw an empty file and wiped the
    // persisted notes. Dismissed topics that match nothing must never stop
    // the live notes from being restored.
    const { ui, customCalls } = await setup({
      config: { dismissedTopics: ["unrelated topic", "another mismatch"] },
      notes: PERSISTED_NOTES,
    });
    expect(ui.custom).toHaveBeenCalledOnce();
    const text = renderOf(customCalls[0]!);
    expect(text).toContain("2 heads-up");
    expect(text).toContain("1 critical");
    expect(text).toContain("1 warning");
  });

  it("degrades a corrupt notes file to an empty tally without breaking session_start", async () => {
    const { ui, customCalls, tools, handlers, ctx } = await setup({ notes: "{ not json" });
    expect(ui.custom).not.toHaveBeenCalled(); // nothing restored, nothing shown

    // The extension keeps working normally afterwards.
    await addNoteViaTool(tools, "Fresh note");
    handlers.get("tool_execution_end")![0](toolEndEvent("corrupt-1"), ctx);
    expect(ui.custom).toHaveBeenCalledOnce();
    expect(renderOf(customCalls[0]!)).toContain("1 head-up");
  });

  it("processing a note (Understood) rewrites the file without it", async () => {
    const { ctx, commands, customCalls } = await setup({ notes: PERSISTED_NOTES });
    await commands.get("ysk").handler("", ctx); // popup over all notes, newest first
    customCalls[1]!.component.handleInput!("1"); // detail: "Hidden decision"
    customCalls[1]!.component.handleInput!("1"); // Understood
    await flushPendingNoteWrites(); // the rewrite flows through the serialized chain
    const onDisk = JSON.parse(readFileSync(PROJECT_NOTES, "utf8")) as { notes: Array<{ topic: string }> };
    expect(onDisk.notes.map((note) => note.topic)).toEqual(["silent assumption"]);
  });

  it("stays quiet when the notes file is absent: nothing is written for a fresh project", async () => {
    const { ui } = await setup();
    expect(ui.custom).not.toHaveBeenCalled();
    // Assert absence only after every write enqueued by session_start has
    // landed — a fresh project must not create the file at all.
    await flushPendingNoteWrites();
    expect(existsSync(PROJECT_NOTES)).toBe(false);
  });
});

// --- subagent relay (ysk-subagent-relay) -----------------------------------------

describe("you-should-know subagent relay", () => {
  const mkdtemp = (): string => mkdtempSync(join(tmpdir(), "ysk-relay-wiring-"));

  /** Poll a condition with a bounded deadline so async relay I/O stays out of assertions. */
  async function waitFor(condition: () => boolean | Promise<boolean>, description: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await condition(), `timed out waiting for ${description}`).toBe(true);
  }

  async function statusText(session: Awaited<ReturnType<typeof setup>>): Promise<string> {
    await session.commands.get("ysk").handler("status", session.ctx);
    return session.ui.notify.mock.calls.at(-1)![0] as string;
  }

  it("child mode: a background review is relayed as JSONL into the injected relay dir", async () => {
    const relayDir = mkdtemp();
    try {
      const session = await setup({
        config: { reviewEvery: 1 },
        env: { GENTLE_PI_AGENTS_CHILD: "1", HOME: FIXTURES },
        relayDir,
      });
      session.handlers.get("tool_execution_end")![0](toolEndEvent("child-1"), session.ctx);
      await waitFor(
        () => existsSync(relayDir) && readdirSync(relayDir).filter((name) => name.endsWith(".jsonl")).length > 0,
        "the child's relay file",
      );
      const [fileName] = readdirSync(relayDir).filter((name) => name.endsWith(".jsonl"));
      const lines = readFileSync(join(relayDir, fileName!), "utf8").trimEnd().split("\n");
      expect(lines).toHaveLength(2); // one per reviewer note (REVIEW_NOTES)
      const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(parsed.map((entry) => entry.id)).toEqual([`${fileName!.replace(/\.jsonl$/, "")}:1`, `${fileName!.replace(/\.jsonl$/, "")}:2`]);
      expect(parsed[0]).toMatchObject({
        v: 1,
        sessionId: fileName!.replace(/\.jsonl$/, ""),
        note: { topic: "silent assumption", severity: "warning", title: "Silent assumption" },
      });
      expect(parsed[0]!.cwd).toBe(CWD); // the child's cwd rides along for the parent's display
      // /ysk status reports the file the child writes to.
      expect(await statusText(session)).toContain(`subagent relay: writing to ${relayDir}/`);
    } finally {
      rmSync(relayDir, { recursive: true, force: true });
    }
  });

  it("parent mode: a seeded relay line is ingested into the store and marked subagent", async () => {
    const relayDir = mkdtemp();
    try {
      const line = {
        v: 1,
        id: "child-session:1",
        ts: Date.now(),
        cwd: "/tmp/child-cwd",
        sessionId: "child-session",
        note: { topic: "relayed finding", severity: "critical", title: "Relayed finding", detail: "from the child" },
      };
      mkdirSync(relayDir, { recursive: true });
      writeFileSync(join(relayDir, "child-session.jsonl"), `${JSON.stringify(line)}\n`, "utf8");
      const session = await setup({ env: { HOME: FIXTURES }, relayDir });

      // The watcher's fire-and-forget start() scans the dir; wait for the store.
      await waitFor(async () => {
        await session.commands.get("ysk").handler("status", session.ctx);
        return (session.ui.notify.mock.calls.at(-1)![0] as string).includes("pending notes: 1");
      }, "the relayed note to reach the store");

      const status = await statusText(session);
      expect(status).toContain("pending notes: 1");
      expect(status).toContain("subagent relay: on · ingested 1 notes");

      // The sidebar shows the dedicated subagent pool row...
      expect(session.customCalls.length).toBeGreaterThan(0);
      expect(renderOf(session.customCalls[0]!)).toContain("■ 1 subagent");

      // ...and the popup marks the note's subagent origin.
      await session.commands.get("ysk").handler("", session.ctx); // 1 note -> detail stage
      const popup = session.customCalls.at(-1)!;
      expect(renderOf(popup)).toContain("via subagent · child-cwd");
    } finally {
      rmSync(relayDir, { recursive: true, force: true });
    }
  });

  it("session_shutdown closes an active watcher quiet; a second session_start works", async () => {
    const relayDir = mkdtemp();
    try {
      const line = {
        v: 1,
        id: "child-session:1",
        ts: Date.now(),
        cwd: "/tmp/child-cwd",
        sessionId: "child-session",
        note: { topic: "relayed finding", severity: "critical", title: "Relayed finding", detail: "" },
      };
      mkdirSync(relayDir, { recursive: true });
      writeFileSync(join(relayDir, "child-session.jsonl"), `${JSON.stringify(line)}\n`, "utf8");
      const session = await setup({ env: { HOME: FIXTURES }, relayDir });
      await waitFor(async () => {
        await session.commands.get("ysk").handler("status", session.ctx);
        return (session.ui.notify.mock.calls.at(-1)![0] as string).includes("pending notes: 1");
      }, "the relayed note to reach the store");

      expect(() => session.handlers.get("session_shutdown")![0]({ type: "session_shutdown", reason: "quit" }, session.ctx)).not.toThrow();

      // A second session over the same relay dir starts cleanly; the seeded
      // line is still inside the age window, and the store dedupes its topic.
      await session.handlers.get("session_start")![0]({ type: "session_start", reason: "resume" }, session.ctx);
      const statusSecond = await statusText(session);
      expect(statusSecond).toContain("pending notes: 1");
      expect(statusSecond).toContain("subagent relay: on");
    } finally {
      rmSync(relayDir, { recursive: true, force: true });
    }
  });
});
