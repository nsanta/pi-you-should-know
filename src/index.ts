/**
 * you-should-know — pi extension wiring.
 *
 * A quiet background reviewer: every `reviewEvery` completed tool steps it
 * sends a bounded transcript digest to a nested model call
 * (ctx.modelRegistry.streamSimple) and surfaces findings as non-blocking
 * HUD notes above the prompt. Core logic (step counting, reviewing, the
 * note store) runs in every mode; only widget/overlay/notification touches
 * are guarded behind ctx.hasUI / ctx.mode === "tui".
 *
 * Failure policy: quiet by design. A broken reviewer, a missing model, or a
 * widget hiccup must never throw into the runtime; /ysk status is the
 * user-visible window into reviewer state.
 */

import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  SessionShutdownEvent,
  ToolExecutionEndEvent,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { DEFAULT_REVIEW_EVERY, loadConfig, saveDismissed, type YskConfig } from "./config.ts";
import { wireActions } from "./actions.ts";
import { formatNotesForChat, NoteStore, type Note } from "./notes.ts";
import { buildDigest, runReviewer, type ReviewerRequest } from "./reviewer.ts";
import { StepCounter } from "./steps.ts";
import { registerHeadsUpTool } from "./tool.ts";
import { KEY_ACTIONS, severityColorToken, severityLabel, truncateLine, widgetLines } from "./widget.ts";

const WIDGET_ID = "ysk";
const USER_CONFIG_PATH = "~/.pi/agent/you-should-know.json";
const DEFAULT_WIDGET_WIDTH = 100;

/**
 * The streamSimple adapter surface, derived structurally from the installed
 * ExtensionContext so this file never imports transitive packages directly.
 */
type StreamSimpleFn = ExtensionContext["modelRegistry"]["streamSimple"];
type ReviewerModel = Parameters<StreamSimpleFn>[0];
type SimpleStreamOptions = Parameters<StreamSimpleFn>[2];

/** Default export: the extension factory (sync; no heavy work, no I/O). */
export default function youShouldKnowExtension(pi: ExtensionAPI): void {
  // --- session state -------------------------------------------------------
  // One store/counter per extension runtime. The store instance stays stable
  // so the tool and command registrations keep working across session
  // replacement; its contents are reset on every session_start.
  let ctxRef: ExtensionContext | null = null;
  let sessionConfig: YskConfig = { reviewEvery: DEFAULT_REVIEW_EVERY, dismissedTopics: [] };
  let projectConfigPath: string | undefined;
  let counter = new StepCounter();
  // Bumped on session_start and session_shutdown; async work captures the
  // value at start and stops touching shared state when it no longer matches.
  let generation = 0;
  let inFlight = false;
  let currentController: AbortController | null = null;
  // Key-layer state: which pending note is expanded (its topic), plus the
  // terminal-input unsubscribe handle for the current session.
  let expandedTopic: string | null = null;
  let unsubscribeInput: (() => void) | null = null;

  // Persistence of permanent dismissals flows through the /ysk ActionDeps
  // (`persist` below), the single write path; no store-level callback.
  const store = new NoteStore();

  // --- widget --------------------------------------------------------------

  function renderWidget(ctx: ExtensionContext | null): void {
    if (!ctx) return;
    try {
      if (!ctx.hasUI) return;
      const pending = store.pending;
      const newest = pending.length > 0 ? pending[pending.length - 1] : undefined;
      // Expansion is only valid while the newest pending note is still the
      // expanded one: a newer note arriving or the target disappearing
      // silently resets to the collapsed band.
      if (expandedTopic !== null && newest?.topic !== expandedTopic) expandedTopic = null;
      const expanded = newest !== undefined && newest.topic === expandedTopic;
      const lines =
        newest === undefined
          ? undefined
          : widgetLines(pending, { width: DEFAULT_WIDGET_WIDTH, expanded }).map((row) =>
              ctx.ui.theme.fg(severityColorToken(row.severity), row.text),
            );
      ctx.ui.setWidget(WIDGET_ID, lines, { placement: "aboveEditor" });
    } catch {
      // widget failures must never crash the session
    }
  }

  // --- session lifecycle ---------------------------------------------------

  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => initSession(ctx));

  async function initSession(ctx: ExtensionContext): Promise<void> {
    const gen = ++generation;
    ctxRef = ctx;
    inFlight = false;
    currentController = null;
    counter = new StepCounter();
    try {
      const cwd = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
      projectConfigPath = join(cwd, ".pi", "you-should-know.json");
      sessionConfig = await loadConfig(projectConfigPath, USER_CONFIG_PATH);
    } catch {
      sessionConfig = { reviewEvery: DEFAULT_REVIEW_EVERY, dismissedTopics: [] };
    }
    if (gen !== generation) return; // session replaced or shut down while loading

    // v1: session-only notes — clear pending, keep permanent dismissals
    // authoritative from config (idempotent re-seed, no config writes).
    store.clearPending();
    for (const topic of sessionConfig.dismissedTopics) {
      if (!store.isDismissed(topic)) store.dismissPermanently(topic);
    }
    expandedTopic = null; // a fresh session starts with the collapsed band
    subscribeTerminalInput(ctx);
    renderWidget(ctx);
  }

  pi.on("session_shutdown", (_event: SessionShutdownEvent, _ctx: ExtensionContext) => {
    generation += 1; // invalidate in-flight fire-and-forget work
    try {
      currentController?.abort();
    } catch {
      // abort is best-effort; the generation guard already discards results
    }
    currentController = null;
    inFlight = false;
    unsubscribeTerminalInput();
    ctxRef = null;
  });

  // --- terminal-input key layer (TUI-only) ----------------------------------

  /** Detach the current session's terminal-input handler, if any. */
  function unsubscribeTerminalInput(): void {
    const unsubscribe = unsubscribeInput;
    unsubscribeInput = null;
    if (!unsubscribe) return;
    try {
      unsubscribe();
    } catch {
      // quiet: a stale unsubscribe must never crash the session
    }
  }

  /**
   * Subscribe the number-key handler for one session. TUI-only: headless and
   * RPC contexts never subscribe, so the keys stay untouched. Called on every
   * session_start after the previous session's handler was detached.
   */
  function subscribeTerminalInput(ctx: ExtensionContext): void {
    unsubscribeTerminalInput();
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    try {
      unsubscribeInput = ctx.ui.onTerminalInput(handleTerminalInput) ?? null;
    } catch {
      unsubscribeInput = null; // quiet: input interception is best-effort
    }
  }

  /**
   * Number-key actions on the NEWEST pending note while the band is shown.
   * Collapsed: 1 expands, 2 dismisses permanently, 0 dismisses for the
   * session. Expanded: 1 acknowledges (collapse, note stays pending), 2
   * fills the editor with the composed explanation, 0 dismisses + collapses.
   * Everything else — multi-character chunks, pastes, unknown keys, no
   * pending notes, non-TUI contexts — returns undefined so the key reaches
   * the editor untouched. Key labels come from KEY_ACTIONS, never literals.
   */
  function handleTerminalInput(data: string): { consume: boolean } | undefined {
    const ctx = ctxRef;
    if (!ctx || !ctx.hasUI || ctx.mode !== "tui") return undefined;
    if (typeof data !== "string" || data.length !== 1) return undefined; // paste/multi-byte chunk
    const pending = store.pending;
    const newest = pending.length > 0 ? pending[pending.length - 1] : undefined;
    if (!newest) return undefined; // nothing shown: keys are the editor's
    const expanded = expandedTopic !== null && newest.topic === expandedTopic;

    if (data === (expanded ? KEY_ACTIONS.expanded.dismiss : KEY_ACTIONS.collapsed.dismiss)) {
      expandedTopic = null;
      store.dismissSession(newest.topic);
      renderWidget(ctx);
      return { consume: true };
    }
    if (data === (expanded ? KEY_ACTIONS.expanded.understood : KEY_ACTIONS.collapsed.learn)) {
      // Expand acts on the newest note; "understood" collapses without
      // dismissing (non-destructive acknowledgment).
      expandedTopic = expanded ? null : newest.topic;
      renderWidget(ctx);
      return { consume: true };
    }
    if (data === (expanded ? KEY_ACTIONS.expanded.chat : KEY_ACTIONS.collapsed.known)) {
      if (expanded) {
        fillEditor(newest); // prompt fill only: never sends, never dismisses
      } else {
        store.dismissPermanently(newest.topic);
        void persistDismissed(store.dismissedTopics);
        renderWidget(ctx);
      }
      return { consume: true };
    }
    return undefined;
  }

  /** Fill the prompt editor with the chat-composed explanation (TUI-only). */
  function fillEditor(note: Note): void {
    const ctx = ctxRef;
    if (!ctx || !ctx.hasUI) return;
    try {
      ctx.ui.setEditorText(`Re: heads-up — please address\n\n${formatNotesForChat([note])}`);
    } catch {
      // editor fill is best-effort and must never crash the session
    }
  }

  // --- review cadence ------------------------------------------------------

  pi.on("tool_execution_end", (event: ToolExecutionEndEvent, ctx: ExtensionContext) => {
    try {
      if (!event || typeof event !== "object") return;
      counter.recordStep();
      renderWidget(ctx); // keeps the HUD fresh after heads_up and store changes
      maybeStartReview(ctx);
    } catch {
      // never throw into the runtime
    }
  });

  function maybeStartReview(ctx: ExtensionContext): void {
    if (inFlight || !counter.shouldReview(sessionConfig.reviewEvery)) return;
    inFlight = true;
    counter.markReviewed();
    const gen = generation;
    const controller = new AbortController();
    currentController = controller;
    // FIRE-AND-FORGET: never awaited by the event handler; the generation
    // guard discards results from replaced sessions, and every failure is
    // swallowed (quiet failure by design).
    void runBackgroundReview(ctx, gen, controller);
  }

  async function runBackgroundReview(ctx: ExtensionContext, gen: number, controller: AbortController): Promise<void> {
    try {
      const digest = buildDigest(ctx.sessionManager.getBranch());
      const notes = await runReviewer(digest, {
        stream: (request: ReviewerRequest) => streamReviewer(ctx, request, controller.signal),
        skipTopic: (topic) => store.isDismissed(topic),
      });
      if (gen !== generation) return; // session replaced mid-review
      for (const note of notes) store.add(note);
      renderWidget(ctx);
    } catch {
      // Quiet failure by design: reviewer/model problems never reach the runtime.
    } finally {
      if (gen === generation) {
        inFlight = false;
        if (currentController === controller) currentController = null;
      }
    }
  }

  /**
   * The streamSimple adapter: turns the reviewer's injected stream boundary
   * into a real nested model call through the session's ModelRegistry.
   *
   * Model resolution order: config.model ("provider/model-id" via
   * registry.find, or a bare model id matched across all known models),
   * then the session's current model. Without any model the returned
   * promise rejects and the caller fails quiet.
   */
  async function streamReviewer(
    ctx: ExtensionContext,
    request: ReviewerRequest,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const registry = ctx.modelRegistry;
    const model = resolveReviewerModel(registry, sessionConfig.model, ctx.model);
    if (!model) throw new Error("you-should-know: no model available for the reviewer");
    const options: SimpleStreamOptions = signal ? { signal } : undefined;
    const stream = registry.streamSimple(model, request, options);
    const final = await stream.result();
    if (final.stopReason === "error" || final.errorMessage !== undefined) {
      throw new Error(final.errorMessage ?? "you-should-know: reviewer stream failed");
    }
    let text = "";
    for (const part of final.content) {
      if (part && part.type === "text") text += part.text;
    }
    return text;
  }

  function resolveReviewerModel(
    registry: ExtensionContext["modelRegistry"],
    override: string | undefined,
    sessionModel: ExtensionContext["model"],
  ): ReviewerModel | undefined {
    if (typeof override === "string" && override.trim().length > 0) {
      const slash = override.indexOf("/");
      if (slash > 0) {
        const found = registry.find(override.slice(0, slash), override.slice(slash + 1));
        if (found) return found;
      } else {
        const bare = registry.getAll().find((candidate) => candidate.id === override);
        if (bare) return bare;
      }
    }
    return sessionModel ?? undefined;
  }

  // --- /ysk action adapters (all side effects live here) -------------------

  function notify(message: string, kind: "info" | "warning" | "error" = "info"): void {
    const ctx = ctxRef;
    if (!ctx || !ctx.hasUI) return;
    try {
      ctx.ui.notify(message, kind);
    } catch {
      // notifications must never crash the session
    }
  }

  /**
   * Learn-more overlay: full note detail above the editor (TUI-only per the
   * overlay contract; ESC closes). Headless and RPC modes skip it.
   */
  async function showOverlay(note: Note): Promise<void> {
    const ctx = ctxRef;
    if (!ctx || !ctx.hasUI || ctx.mode !== "tui") return;
    try {
      await ctx.ui.custom<void>(
        (_tui, theme, _keybindings, done) => {
          const title = note.title.trim().length > 0 ? note.title.trim() : note.topic;
          const detailLines =
            typeof note.detail === "string" && note.detail.trim().length > 0 ? note.detail.trim().split("\n") : [];
          const lines = [
            theme.fg("muted", "you-should-know"),
            theme.fg(severityColorToken(note.severity), `[${severityLabel(note.severity)}] ${title}`),
            "",
            ...detailLines,
            "",
            theme.fg("muted", "ESC to close"),
          ].map((line) => truncateLine(line, DEFAULT_WIDGET_WIDTH));
          return {
            render: () => lines,
            invalidate: () => {},
            handleInput: (data: string) => {
              // matchesKey normalizes ESC across legacy (\x1b), kitty
              // keyboard protocol (\x1b[27u), and modifyOtherKeys encodings;
              // a raw byte comparison only sees the legacy form. Ctrl+C is
              // handled too so the focused overlay cannot trap it.
              if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done(undefined);
            },
          };
        },
        { overlay: true },
      );
    } catch {
      // overlay failures are quiet by design
    }
  }

  function sendChat(text: string): void {
    try {
      pi.sendUserMessage(text);
    } catch {
      // quiet: e.g. sendUserMessage unsupported in the current mode
    }
  }

  function persistDismissed(topics: string[]): Promise<void> {
    const path = projectConfigPath;
    if (!path) return Promise.resolve();
    return saveDismissed(path, topics).catch(() => {
      // persistence is best-effort; dismissal still applies to this session
    });
  }

  function statusText(): string {
    return [
      "you-should-know status",
      `review cadence: every ${sessionConfig.reviewEvery} tool steps · steps since last review: ${counter.steps}`,
      `review in flight: ${inFlight ? "yes" : "no"}`,
      `pending notes: ${store.pending.length}`,
      `dismissed topics (permanent): ${store.dismissedTopics.length}`,
    ].join("\n");
  }

  // --- registrations ---------------------------------------------------------

  registerHeadsUpTool(pi, store);

  wireActions(pi, {
    store,
    showOverlay,
    sendChat,
    persist: () => persistDismissed(store.dismissedTopics),
    rerender: () => renderWidget(ctxRef),
    notify,
    status: statusText,
  });
}
