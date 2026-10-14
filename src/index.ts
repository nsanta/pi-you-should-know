/**
 * you-should-know — pi extension wiring.
 *
 * A quiet background reviewer: every `reviewEvery` completed tool steps it
 * sends a bounded transcript digest to a nested model call
 * (ctx.modelRegistry.streamSimple) and surfaces findings as non-blocking
 * notes through two overlays: a right-edge tally sidebar (always mirroring
 * the pending store) and a centered popup (note list/detail with 1/2/0
 * actions). Notes become visible only when the chat answer completes: while
 * the agent loop is active (agent_start..agent_end) every sidebar write is
 * deferred behind a dirty flag and flushed on agent_end / agent_settled, so
 * mid-task tool rounds never leak notes. Core logic (step counting,
 * reviewing, the note store) runs in every mode; only sidebar, popup,
 * editor-fill, and notification touches are guarded behind ctx.hasUI /
 * ctx.mode === "tui".
 *
 * Failure policy: quiet by design. A broken reviewer, a missing model, or an
 * overlay hiccup must never throw into the runtime; /ysk status is the
 * user-visible window into reviewer state.
 */

import { join } from "node:path";
import type {
  AgentEndEvent,
  AgentSettledEvent,
  AgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  SessionShutdownEvent,
  ToolExecutionEndEvent,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { DEFAULT_REVIEW_EVERY, loadConfig, saveDismissed, type YskConfig } from "./config.ts";
import { wireActions } from "./actions.ts";
import { formatNotesForChat, NoteStore, type Note, type Severity } from "./notes.ts";
import { buildDigest, runReviewer, type ReviewerRequest } from "./reviewer.ts";
import { StepCounter } from "./steps.ts";
import { registerHeadsUpTool } from "./tool.ts";
import {
  POPUP_ACTIONS,
  noteIndexAtPopupRow,
  popupActionAtRow,
  popupDetailRows,
  popupListRows,
  severityAtSidebarRow,
  severityColorToken,
  sidebarRows,
  type WidgetLine,
} from "./widget.ts";

const USER_CONFIG_PATH = "~/.pi/agent/you-should-know.json";
/** Column width of the tally sidebar overlay; rows are truncated to this. */
const SIDEBAR_WIDTH = 26;
/** Popup rows truncate to the overlay's 60% width, never below this. */
const POPUP_WIDTH_MIN = 40;
/** Popup overlay width as a fraction of the terminal width. */
const POPUP_WIDTH_RATIO = 0.6;

/**
 * The streamSimple adapter surface, derived structurally from the installed
 * ExtensionContext so this file never imports transitive packages directly.
 */
type StreamSimpleFn = ExtensionContext["modelRegistry"]["streamSimple"];
type ReviewerModel = Parameters<StreamSimpleFn>[0];
type SimpleStreamOptions = Parameters<StreamSimpleFn>[2];

/**
 * The subset of pi's OverlayHandle the overlays keep. Structurally derived so
 * tests can pass minimal fakes; only matchesKey is imported from pi-tui.
 */
interface OverlayHandleLike {
  hide(): void;
  setHidden(hidden: boolean): void;
  focus(): void;
  unfocus(): void;
  getBounds(): { row: number; col: number; width: number; height: number } | undefined;
}

/** What a popup shows: every pending note, one severity's notes, or one note. */
type PopupTarget = Note | { all: true } | { severity: Severity };

/** Popup component state: the list stage or the detail stage. */
type PopupStage = { kind: "list"; notes: Note[] } | { kind: "detail"; note: Note };

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
  // Answer-completion presentation: while an agent loop is running, sidebar
  // writes are deferred (renderDirty) and flushed at the loop boundary, so
  // notes only surface when the chat answer completes. Session-scoped; reset
  // on session_start/session_shutdown.
  let agentActive = false;
  let renderDirty = false;
  // Tally sidebar overlay state (session-scoped). sidebarDone is pi's own
  // done callback captured inside the custom() factory: resolving it closes
  // and disposes the overlay, so the empty-snapshot path closes through pi
  // instead of tearing UI down by hand. sidebarHandle is the overlay handle;
  // sessionTui is the live TUI captured by the overlay factories (preferred
  // repaint target for editor fills); sidebarSnapshot is the immutable row
  // list every sidebar frame renders from.
  let sidebarDone: ((value: unknown) => void) | null = null;
  let sidebarHandle: OverlayHandleLike | null = null;
  let sessionTui: { requestRender: (force?: boolean) => void } | null = null;
  let sidebarSnapshot: WidgetLine[] = [];
  // Note popup overlay state (session-scoped, same done-capture pattern).
  // One popup at a time: opening a new one closes the previous first.
  let popupDone: ((value: unknown) => void) | null = null;
  let popupHandle: OverlayHandleLike | null = null;

  // Persistence of permanent dismissals flows through the /ysk ActionDeps
  // (`persist` below), the single write path; no store-level callback.
  const store = new NoteStore();

  // --- gated overlay rendering ---------------------------------------------

  /**
   * Dirty-aware render entry point. While the agent loop is active every
   * render request (reviewer note arrival, heads_up additions, dismissals,
   * /ysk actions) only marks the sidebar dirty; the loop-boundary handlers
   * flush it. When idle, renders behave exactly as before: immediate write.
   */
  function requestRender(ctx: ExtensionContext | null): void {
    if (agentActive) {
      renderDirty = true;
      return;
    }
    writeSidebar(ctx);
  }

  // --- tally sidebar overlay ------------------------------------------------

  /**
   * Sidebar writer: snapshot the pending-note tally, then open, refresh, or
   * close the right-edge overlay so it always mirrors the store. Lives on the
   * same gated render path as the popup opens (idle requestRender +
   * loop-boundary flush), so mid-loop arrivals stay deferred behind the dirty
   * flag. Strictly TUI: headless and RPC contexts never touch the overlay.
   * The snapshot is taken before any UI touch and every sidebar frame
   * renders from it, so a frame redraw can never leak newer store state.
   */
  function writeSidebar(ctx: ExtensionContext | null): void {
    if (!ctx) return;
    try {
      if (!ctx.hasUI || ctx.mode !== "tui") return;
      sidebarSnapshot = sidebarRows(store.pending, { width: SIDEBAR_WIDTH });
      if (sidebarSnapshot.length === 0) {
        // Empty tally and an open overlay: close it through pi's own done
        // (resolved + disposed by pi) and drop the handle so nothing stale
        // can touch the UI. Do not call custom() again until a new note lands.
        if (sidebarDone !== null) {
          const finish = sidebarDone;
          sidebarDone = null;
          sidebarHandle = null;
          try {
            finish(undefined);
          } catch {
            // quiet: overlay disposal is best-effort
          }
        }
        return;
      }
      if (sidebarDone !== null) {
        // Already open: the component re-renders every frame from the fresh
        // snapshot; just ask its TUI to repaint.
        sessionTui?.requestRender();
        return;
      }
      openSidebar(ctx);
    } catch {
      // sidebar failures must never crash the session
    }
  }

  /**
   * Open the sidebar as a non-capturing right-center overlay. TUI-only: the
   * open path refuses headless and RPC contexts even if called directly. The
   * custom() promise is fire-and-forget with a quiet catch; done is captured
   * inside the factory so the empty-snapshot path can close the overlay
   * through pi later. Every deferred callback is generation-guarded: a stale
   * session must not open, repaint, or capture UI state.
   */
  function openSidebar(ctx: ExtensionContext): void {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    const gen = generation;
    void ctx.ui.custom(
      (tui, theme, _keybindings, done) => {
        sessionTui = tui; // plain assignment FIRST: capture even if the rest fails
        sidebarDone = done; // pi's own resolve: the close path hands it back
        return {
          render: () => {
            if (gen !== generation) return []; // stale generation renders nothing
            // Frames redraw constantly: render only from the snapshot.
            return sidebarSnapshot.map((row) => theme.fg(severityColorToken(row.severity), row.text));
          },
          invalidate: () => {},
          handleMouse: (event) => {
            if (gen !== generation) return undefined;
            if (event?.type !== "click" || event.button !== "left") return undefined;
            // Click routing: row text decides what a click selects. The
            // overlay is nonCapturing, so opening the popup never steals
            // focus from the editor beforehand — the popup captures its own.
            const hit = severityAtSidebarRow(sidebarSnapshot, event.y);
            if (hit === null) return undefined;
            openPopup(hit === "all" ? { all: true } : { severity: hit });
            return { handled: true };
          },
        };
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "right-center",
          width: SIDEBAR_WIDTH,
          maxHeight: "80%",
          margin: 1,
          nonCapturing: true,
        },
        onHandle: (handle) => {
          if (gen !== generation) return; // stale generation must not capture the handle
          sidebarHandle = handle;
        },
      },
    ).catch(() => {
      // quiet: a failed overlay open must never crash the session
    });
  }

  /**
   * Close any open sidebar overlay and clear every sidebar surface state.
   * Used at session boundaries (session_start replacement, session_shutdown):
   * the captured done is invoked quiet so pi disposes the overlay, and the
   * next session reopens on demand.
   */
  function resetSidebar(): void {
    const finish = sidebarDone;
    sidebarDone = null;
    sidebarHandle = null;
    sessionTui = null;
    sidebarSnapshot = [];
    if (!finish) return;
    try {
      finish(undefined);
    } catch {
      // quiet: overlay disposal at a session boundary is best-effort
    }
  }

  // --- note popup overlay ---------------------------------------------------

  /**
   * Close any open popup via its captured done and clear the popup state.
   * The done-capture pattern is the single close path: pi disposes the
   * overlay when the custom() promise resolves, so nothing is torn down by
   * hand. Safe to call when nothing is open.
   */
  function closePopup(): void {
    const finish = popupDone;
    popupDone = null;
    popupHandle = null;
    if (!finish) return;
    try {
      finish(undefined);
    } catch {
      // quiet: popup disposal is best-effort
    }
  }

  /** Row width for popup renders: the overlay's 60% width, never below 40. */
  function popupRowWidth(viewportWidth: number | undefined): number {
    const usable =
      typeof viewportWidth === "number" && Number.isFinite(viewportWidth)
        ? Math.floor(viewportWidth * POPUP_WIDTH_RATIO)
        : POPUP_WIDTH_MIN;
    return Math.max(POPUP_WIDTH_MIN, usable);
  }

  /**
   * Open the note popup as a capturing centered overlay. TUI-only: headless
   * and RPC contexts never open anything. One popup at a time — an open
   * popup is closed through its captured done first. Target notes: { all }
   * or { severity } filter the pending store, a single Note targets itself.
   * The list stage is NEWEST FIRST (store order reversed); exactly one
   * match skips the list and opens the detail stage directly. The notes are
   * snapshotted up front (never re-read from the live store while the popup
   * is open), and every frame renders from that snapshot.
   */
  function openPopup(target: PopupTarget): void {
    const ctx = ctxRef;
    if (!ctx || !ctx.hasUI || ctx.mode !== "tui") return;
    closePopup(); // exactly one popup at a time

    const matches =
      (target as { all?: true }).all === true
        ? store.pending
        : "topic" in (target as Note)
          ? [target as Note]
          : store.pending.filter((note) => note.severity === (target as { severity: Severity }).severity);
    // List stage reads newest first; a single note is unaffected by the flip.
    const notes = [...matches].reverse();
    if (notes.length === 0) return;
    let stage: PopupStage =
      notes.length > 1 ? { kind: "list", notes } : { kind: "detail", note: notes[0]! };
    let popupRows: WidgetLine[] = []; // rows of the most recent frame, for mouse hit-testing

    /** Rows of the current stage at the given width (render's single source). */
    const currentRows = (width: number | undefined): WidgetLine[] =>
      stage.kind === "list"
        ? popupListRows(stage.notes, { width: popupRowWidth(width) })
        : popupDetailRows(stage.note, { width: popupRowWidth(width) });

    const gen = generation;
    void ctx.ui.custom(
      (tui, theme, _keybindings, done) => {
        sessionTui = tui; // plain assignment FIRST: capture even if the rest fails
        popupDone = done; // pi's own resolve: the close path hands it back
        return {
          render: (width?: number) => {
            if (gen !== generation) return []; // stale generation renders nothing
            // Frames redraw constantly: recompute rows from the snapshot stage.
            popupRows = currentRows(width);
            return popupRows.map((row) => theme.fg(severityColorToken(row.severity), row.text));
          },
          handleInput: (data: string) => {
            if (gen !== generation) return;
            if (matchesKey(data, "escape")) {
              closePopup(); // Esc: close without processing anything
              return;
            }
            if (stage.kind === "list") {
              // Digits 1..9 pick the row they name (noteIndexAtPopupRow semantics).
              if (!/^[1-9]$/.test(data)) return;
              const picked = stage.notes[Number(data) - 1];
              if (!picked) return;
              stage = { kind: "detail", note: picked };
              sessionTui?.requestRender();
              return;
            }
            const action = POPUP_ACTIONS.find((entry) => entry.key === data)?.action;
            if (!action) return;
            const note = stage.note;
            if (action === "understood") {
              store.dismissSession(note.topic);
              requestRender(ctxRef); // refresh (or close) the sidebar tally
              closePopup();
            } else if (action === "chat") {
              fillEditor(composedNoteText(note)); // prompt fill only: never sends
              markProcessed(note);
              closePopup();
            } else {
              store.dismissSession(note.topic);
              requestRender(ctxRef);
              closePopup();
            }
          },
          handleMouse: (event) => {
            if (gen !== generation) return undefined;
            if (event?.type !== "click" || event.button !== "left") return undefined;
            // Hit-test against the rows pi actually rendered; if no frame has
            // been drawn yet, derive them from the event's own width.
            if (popupRows.length === 0) popupRows = currentRows(event?.width);
            if (stage.kind === "list") {
              const index = noteIndexAtPopupRow(popupRows, event.y);
              const picked = index === null ? undefined : stage.notes[index - 1];
              if (!picked) return undefined;
              stage = { kind: "detail", note: picked };
              sessionTui?.requestRender();
              return { handled: true };
            }
            // popupActionAtRow's positional guard keeps the hit on the
            // trailing hint block only; detail text can never fire an action.
            const action = popupActionAtRow(popupRows, event.y);
            if (action === null) return undefined;
            const note = stage.note;
            if (action === "understood" || action === "dismiss") {
              store.dismissSession(note.topic);
              requestRender(ctxRef);
            } else {
              fillEditor(composedNoteText(note));
              markProcessed(note);
            }
            closePopup();
            return { handled: true };
          },
          invalidate: () => {},
        };
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "60%",
          maxHeight: "60%",
          margin: 1,
        },
        onHandle: (handle) => {
          if (gen !== generation) return; // stale generation must not capture the handle
          popupHandle = handle;
        },
      },
    ).catch(() => {
      // quiet: a failed popup open must never crash the session
    });
  }

  // --- session lifecycle ---------------------------------------------------

  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => initSession(ctx));

  async function initSession(ctx: ExtensionContext): Promise<void> {
    const gen = ++generation;
    ctxRef = ctx;
    inFlight = false;
    currentController = null;
    agentActive = false;
    renderDirty = false;
    resetSidebar(); // close the replaced session's overlays; the new one reopens on demand
    closePopup();
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
    requestRender(ctx);
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
    agentActive = false;
    renderDirty = false;
    resetSidebar();
    closePopup();
    ctxRef = null;
  });

  // --- answer-completion boundary (agent loop gating) -----------------------

  pi.on("agent_start", (_event: AgentStartEvent, _ctx: ExtensionContext) => {
    agentActive = true;
  });

  pi.on("agent_end", (_event: AgentEndEvent, ctx: ExtensionContext) => {
    agentActive = false;
    flushDirtyRender(ctx);
  });

  pi.on("agent_settled", (_event: AgentSettledEvent, ctx: ExtensionContext) => {
    // Safety net: also fires for aborted/errored loops that never reach a
    // clean agent_end, so the dirty flag can never wedge the sidebar. The
    // flag clears before writing, keeping the agent_end pair idempotent.
    agentActive = false;
    flushDirtyRender(ctx);
  });

  /** Flush one deferred sidebar write: clear the dirty flag first, then write. */
  function flushDirtyRender(ctx: ExtensionContext): void {
    if (!renderDirty) return;
    renderDirty = false;
    writeSidebar(ctx);
  }

  // --- review cadence ------------------------------------------------------

  pi.on("tool_execution_end", (event: ToolExecutionEndEvent, ctx: ExtensionContext) => {
    try {
      if (!event || typeof event !== "object") return;
      counter.recordStep();
      requestRender(ctx); // keeps the overlays fresh after heads_up and store changes
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
      requestRender(ctx);
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
   * Composed chat framing for one note, shared by the popup '2' (Chat)
   * action and /ysk chat: the text lands in the editor for manual review and
   * sending.
   */
  function composedNoteText(note: Note): string {
    return `Re: heads-up — please address\n\n${formatNotesForChat([note])}`;
  }

  /**
   * Fill the prompt editor with the given text. hasUI-guarded and quiet on
   * failure; nothing is ever auto-sent — the user reviews and sends.
   */
  function fillEditor(text: string): void {
    const ctx = ctxRef;
    if (!ctx || !ctx.hasUI) return;
    try {
      ctx.ui.setEditorText(text);
      // setEditorText only mutates editor state; ask the TUI captured by the
      // overlay factories for the repaint so the text is visible immediately.
      // Upstream gap tracked in earendil-works/pi#5620 (setEditorText does
      // not re-render outside the input loop); if that fix lands, the
      // requestRender here becomes redundant but harmless.
      sessionTui?.requestRender();
    } catch {
      // editor fill is best-effort and must never crash the session
    }
  }

  /**
   * Mark one note processed for this session: it leaves the pending tally
   * (dismissSession), and the sidebar refreshes on the next gated render.
   * Not permanent — /ysk known remains the permanent-dismissal path.
   */
  function markProcessed(note: Note): void {
    store.dismissSession(note.topic);
    requestRender(ctxRef);
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
    openPopup,
    markProcessed,
    fillEditor,
    persist: () => persistDismissed(store.dismissedTopics),
    rerender: () => requestRender(ctxRef),
    notify,
    status: statusText,
  });
}
