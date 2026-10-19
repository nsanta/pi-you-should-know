/**
 * you-should-know — pi extension wiring.
 *
 * A quiet background reviewer: every `reviewEvery` completed tool steps it
 * sends a bounded transcript digest to a nested model call
 * (ctx.modelRegistry.streamSimple) and surfaces findings as non-blocking
 * notes through two overlays: a right-edge tally sidebar card (always
 * mirroring the pending store) and a centered popup (note list/detail with
 * 1/2/0 actions). Notes become visible only when the chat answer completes:
 * while the agent loop is active (agent_start..agent_end) every sidebar write is
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
import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
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
import {
  DEFAULT_RELAY_MAX_AGE_HOURS,
  DEFAULT_REVIEW_EVERY,
  loadConfig,
  loadPendingNotes,
  pruneSessionNotes,
  saveDismissed,
  savePendingNotes,
  type YskConfig,
} from "./config.ts";
import { wireActions } from "./actions.ts";
import { formatNotesForChat, NoteStore, type Note, type Severity } from "./notes.ts";
import { buildDigest, runReviewer, type ReviewerRequest } from "./reviewer.ts";
import { StepCounter } from "./steps.ts";
import { registerHeadsUpTool } from "./tool.ts";
import { RelayWatcher, RelayWriter, isSubagentChild, relayDirFor } from "./relay.ts";
import {
  POPUP_ACTIONS,
  noteIndexAtPopupRow,
  popupActionAtRow,
  popupDetailRows,
  popupListRows,
  railHeadsUpRows,
  severityAtSidebarCardRow,
  severityColorToken,
  sidebarCardRows,
  type CardRow,
} from "./widget.ts";

const USER_CONFIG_PATH = "~/.pi/agent/you-should-know.json";

/** Project .pi subdirectory holding one pending-notes file per session. */
const NOTES_DIR_NAME = "you-should-know-notes";

/** Legacy (pre-per-session) global pending-notes filename, adopted once then deleted. */
const LEGACY_NOTES_FILENAME = "you-should-know-notes.json";

// --- gentle-pi experimental fullscreen rail integration (best-effort) --------

/**
 * Gentle-pi's experimental fullscreen shell exposes a right-hand rail on the
 * TUI's terminal object behind Symbol.for keys. These two string keys are the
 * ONLY contract this extension relies on: they are never imported from
 * gentle-pi, and any other internal (state shape, parts map, cache field) is
 * read defensively so a gentle-pi internals change degrades silently to the
 * regular tally overlay instead of throwing into the runtime.
 */
const GENTLE_RAIL_STATE = Symbol.for("gentle-pi.experimental-sidebar.state");
/** Cache symbol whose `revision` counter invalidates the whole gentle rail. */
const GENTLE_RAIL_CACHE = Symbol.for("gentle-pi.experimental-sidebar.cache");

/** The key this extension registers its rail part under. */
const RAIL_PART_KEY = "ysk";

/** The widget key this extension registers (factory registration + teardown). */
const RAIL_WIDGET_KEY = "you-should-know";

/** Structural view of one rail part; only these members are ever touched. */
interface GentleRailComponent {
  render: (width?: number) => string[];
  digest?: () => string;
  handleMouse?: (event: GentleMouseEvent) => unknown;
  invalidate?: () => void;
  dispose?: () => void;
}

/** Structural view of gentle-pi's experimental sidebar state on tui.terminal. */
interface GentleRailStateLike {
  active?: boolean;
  ownsHost?: () => boolean;
  parts?: Map<string, GentleRailComponent>;
}

/** The mouse event shape the rail part's hit-testing needs. */
interface GentleMouseEvent {
  type?: unknown;
  button?: unknown;
  y?: unknown;
}

/**
 * Read gentle-pi's experimental sidebar state from a TUI, quietly. This is a
 * best-effort integration with gentle-pi's EXPERIMENTAL sidebar internals:
 * the Symbol.for keys above are the only contract, and every access is guarded
 * so an absent state (plain pi, other runtimes) or changed internals simply
 * return null and the extension degrades to its own overlay. Never throws.
 */
function gentleRailState(tui: unknown): GentleRailStateLike | null {
  try {
    const terminal = (tui as { terminal?: unknown } | null | undefined)?.terminal;
    if (terminal === null || typeof terminal !== "object") return null;
    const state = (terminal as Record<symbol, unknown>)[GENTLE_RAIL_STATE];
    if (state === null || typeof state !== "object") return null;
    if (!((state as GentleRailStateLike).parts instanceof Map)) return null;
    return state as GentleRailStateLike;
  } catch {
    return null;
  }
}

/**
 * Bump gentle-pi's rail cache revision so the whole rail re-renders on the
 * next frame. Quiet no-op when the cache symbol is absent or reshaped: note
 * changes must re-render the rail even between digest revalidations, but a
 * missing cache only costs freshness, never correctness. Never throws.
 */
function gentleRailInvalidate(tui: unknown): void {
  try {
    const terminal = (tui as { terminal?: unknown } | null | undefined)?.terminal;
    if (terminal === null || typeof terminal !== "object") return;
    const cache = (terminal as Record<symbol, unknown>)[GENTLE_RAIL_CACHE];
    if (cache === null || typeof cache !== "object") return;
    const revision = (cache as { revision?: unknown }).revision;
    if (typeof revision !== "number") return;
    (cache as { revision: number }).revision = revision + 1;
  } catch {
    // quiet: rail invalidation is best-effort
  }
}

/**
 * True when gentle-pi's fullscreen rail is active AND owns the host surface
 * (fullscreen mode) for this TUI — the condition under which the tally
 * overlay must paint nothing, because the rail renders the card instead.
 * Anything absent, reshaped, or throwing reads as "not owning": the overlay
 * keeps painting and the fallback stays intact. Never throws.
 */
function gentleRailOwnsHost(tui: unknown): boolean {
  const state = gentleRailState(tui);
  if (state === null || state.active !== true) return false;
  try {
    return state.ownsHost?.() === true;
  } catch {
    return false;
  }
}

/** Pending notes newest first (the popup list's and rail card's display order). */
function newestFirst(notes: Note[]): Note[] {
  return [...notes].reverse();
}

/**
 * Fallback row width for sidebar frames rendered without a width (tests, odd
 * terminals) — not the overlay size: the compact right-edge overlay resolves
 * to 30% of the terminal (min 24) and every frame renders at the width
 * pi-tui hands it.
 */
const SIDEBAR_FALLBACK_WIDTH = 26;
/**
 * Fallback row width for popup frames rendered without a width (tests, odd
 * terminals) — not the overlay size: the popup overlay spans 80% of the
 * terminal and every frame renders at the width pi-tui hands it.
 */
const POPUP_WIDTH_MIN = 40;

/**
 * Serialized write chain for the per-session pending-notes file. Every
 * pending-note mutation funnels its save through this chain, so writes from
 * concurrent fire-and-forget flows land strictly in mutation order and the
 * most recent pending list is always what reaches the disk — an older write
 * can never land last and wipe newer state. initSession reads the file
 * before its first store mutation, so no chain write can race that read.
 * Failures are swallowed per link; the chain itself never rejects.
 */
let notesWriteChain: Promise<void> = Promise.resolve();

/**
 * Sanitize a raw session id into a safe pending-notes filename stem: only
 * [A-Za-z0-9._-] survive, every other character becomes "_", and the result
 * is capped at 120 characters. Returns undefined for an absent, empty, or
 * blank id — persistence is disabled for such a session (no restore, no
 * writes; this should never happen in practice). Assumption: distinct ids
 * may sanitize to the same filename only when they differ outside the kept
 * charset or beyond 120 chars — impossible for pi's UUID session ids
 * (hex + dashes are sanitize-injective), accepted for hostile input.
 */
function sanitizeSessionId(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const sanitized = raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return sanitized.length > 0 ? sanitized : undefined;
}

/**
 * Best-effort regular-file check, quiet: any fs error (missing path,
 * permission, dangling link) reads as "absent". Never throws.
 */
async function notesFileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Test-isolation drain for the serialized pending-notes write chain:
 * resolves once every write enqueued so far has settled, in chain order.
 * Each link swallows its own failures, so this never rejects. The extension
 * never calls this at runtime; wiring tests use it to observe the notes
 * file only after its writes have actually landed.
 */
export async function flushPendingNoteWrites(): Promise<void> {
  await notesWriteChain;
}

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

/** What a popup shows: every pending note, one severity's notes, the subagent pool, or one note. */
type PopupTarget = Note | { all: true } | { severity: Severity } | { subagent: true };

/** Popup component state: the list stage or the detail stage. */
type PopupStage = { kind: "list"; notes: Note[] } | { kind: "detail"; note: Note };

/** Default export: the extension factory (sync; no heavy work, no I/O). */
export default function youShouldKnowExtension(
  pi: ExtensionAPI,
  overrides: { env?: NodeJS.ProcessEnv; relayDir?: string } = {},
): void {
  // Relay environment: tests inject a fake env (and a tmp relay dir) so the
  // real process env and agent home are never touched.
  const relayEnv = overrides.env ?? process.env;

  // --- session state -------------------------------------------------------
  // One store/counter per extension runtime. The store instance stays stable
  // so the tool and command registrations keep working across session
  // replacement; its contents are reset on every session_start.
  let ctxRef: ExtensionContext | null = null;
    let sessionConfig: YskConfig = {
      reviewEvery: DEFAULT_REVIEW_EVERY,
      subagentRelay: true,
      subagentRelayMaxAgeHours: DEFAULT_RELAY_MAX_AGE_HOURS,
      dismissedTopics: [],
    };
  let projectConfigPath: string | undefined;
  let projectNotesPath: string | undefined;
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
  // Subagent relay endpoints (session-scoped). Exactly one is live at a
  // time: the child writer when this process is a gentle-pi subagent, the
  // parent watcher otherwise — both null while the relay is disabled or no
  // session has started. The writer is captured by the store's onAdd hook
  // below, so session replacement swaps it by reassigning this field.
  let relayWriter: RelayWriter | null = null;
  let relayWatcher: RelayWatcher | null = null;
  // Tally sidebar overlay state (session-scoped). sidebarDone is pi's own
  // done callback captured inside the custom() factory: resolving it closes
  // and disposes the overlay, so the empty-snapshot path closes through pi
  // instead of tearing UI down by hand. sidebarHandle is the overlay handle;
  // sessionTui is the live TUI captured by the overlay factories (preferred
  // repaint target for editor fills); sidebarNotes is the immutable note
  // snapshot every sidebar frame renders from.
  let sidebarDone: ((value: unknown) => void) | null = null;
  let sidebarHandle: OverlayHandleLike | null = null;
  let sessionTui: { requestRender: (force?: boolean) => void } | null = null;
  let sidebarNotes: Note[] = [];
  // Gentle-pi fullscreen-rail state (session-scoped). The widget factory
  // captures the TUI whose gentle rail hosts the "ysk" part and flags the
  // connection, so note changes can bump the rail's cache revision. Both stay
  // unset until pi actually invokes the factory (and reset at session ends).
  let railTui: unknown = null;
  let railHostConnected = false;
  // Note popup overlay state (session-scoped, same done-capture pattern).
  // One popup at a time: opening a new one closes the previous first.
  let popupDone: ((value: unknown) => void) | null = null;
  let popupHandle: OverlayHandleLike | null = null;

  // Persistence is injected, not owned by the store: pending-note writes
  // funnel through persistNotes below (one serialized chain), while the
  // permanent-dismissal list flows through the /ysk ActionDeps (`persist`
  // below), the single dismissed write path. onAdd mirrors every real add
  // into the relay writer (when this process is a subagent child); the hook
  // lives on the factory-scoped store so it survives session replacement.
  const store = new NoteStore({
    persistPending: (notes) => persistNotes(notes),
    onAdd: (note) => {
      relayWriter?.enqueue(note);
    },
  });

  // --- gated overlay rendering ---------------------------------------------

  /**
   * Dirty-aware render entry point. While the agent loop is active every
   * render request (reviewer note arrival, heads_up additions, dismissals,
   * /ysk actions) only marks the sidebar dirty; the loop-boundary handlers
   * flush it. When idle, renders behave exactly as before: immediate write.
   * Either way the gentle fullscreen rail (when connected) is invalidated so
   * the docked card tracks note changes even between digest revalidations.
   */
  function requestRender(ctx: ExtensionContext | null): void {
    if (agentActive) {
      renderDirty = true;
      return;
    }
    writeSidebar(ctx);
    invalidateRail();
  }

  /**
   * Bump the gentle rail's cache revision so a registered "ysk" part
   * repaints on the next frame. Quiet no-op until the widget factory has
   * connected to a gentle rail (and entirely without one). Best-effort:
   * failures are swallowed and never reach the runtime.
   */
  function invalidateRail(): void {
    if (!railHostConnected) return;
    try {
      gentleRailInvalidate(railTui);
    } catch {
      // quiet: rail invalidation must never reach the runtime
    }
  }

  // --- tally sidebar overlay ------------------------------------------------

  /**
   * Sidebar writer: snapshot the pending notes, then open, refresh, or close
   * the right-edge overlay so it always mirrors the store. Lives on the
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
      const previous = sidebarNotes;
      sidebarNotes = [...store.pending];
      // A changed snapshot must re-render the gentle rail even between
      // digest revalidations; reference equality is enough (notes are
      // immutable, and store.pending returns a fresh defensive copy).
      if (previous.length !== sidebarNotes.length || previous.some((note, index) => note !== sidebarNotes[index])) {
        invalidateRail();
      }
      if (sidebarNotes.length === 0) {
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
   * Open the sidebar as a non-capturing right-center overlay spanning 30% of
   * the terminal (minWidth 24; pi-tui resolves the percentage against the
   * terminal and calls render with the resolved width, so every frame
   * rebuilds the card at that width). This overlay is the FALLBACK surface:
   * when gentle-pi's fullscreen rail is active and owns the host, the render
   * paints nothing (the rail renders the card instead) — the overlay stays
   * open so a mode switch back needs no reopen logic. TUI-only: the open path
   * refuses headless and RPC contexts even if called directly. The custom()
   * promise is fire-and-forget with a quiet catch; done is captured inside
   * the factory so the empty-snapshot path can close the overlay through pi
   * later. Every deferred callback is generation-guarded: a stale session
   * must not open, repaint, or capture UI state.
   */
  function openSidebar(ctx: ExtensionContext): void {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    const gen = generation;
    // Rows of the most recent frame, for mouse hit-testing (the popup's
    // popupRows pattern).
    let sidebarFrameRows: CardRow[] = [];

    /** Card rows of the current frame at the given width (render's single source). */
    const frameRows = (width: number | undefined): CardRow[] =>
      sidebarCardRows(sidebarNotes, { width: sidebarRowWidth(width) });

    void ctx.ui.custom(
      (tui, theme, _keybindings, done) => {
        sessionTui = tui; // plain assignment FIRST: capture even if the rest fails
        sidebarDone = done; // pi's own resolve: the close path hands it back
        return {
          render: (width?: number) => {
            if (gen !== generation) return []; // stale generation renders nothing
            // Fullscreen-rail mode: the gentle rail paints the card, so the
            // overlay stays open but paints nothing (never the card twice).
            if (gentleRailOwnsHost(tui)) return [];
            // Frames redraw constantly: rebuild the card at the render width
            // from the notes snapshot.
            sidebarFrameRows = frameRows(width);
            return sidebarFrameRows.map((row) =>
              row.segments.map((segment) => theme.fg(severityColorToken(segment.token), segment.text)).join(""),
            );
          },
          invalidate: () => {},
          handleMouse: (event) => {
            if (gen !== generation) return undefined;
            if (gentleRailOwnsHost(tui)) return undefined; // invisible card: never clickable
            if (event?.type !== "click" || event.button !== "left") return undefined;
            // Hit-test against the rows pi actually rendered; if no frame
            // has been drawn yet, derive them from the event's own width.
            if (sidebarFrameRows.length === 0) sidebarFrameRows = frameRows(event?.width);
            // Click routing: the card rows decide what a click selects
            // (title -> all, a body row's middle segment -> its severity,
            // the pool row -> the subagent filter). The overlay is
            // nonCapturing, so opening the popup never steals focus from
            // the editor beforehand — the popup captures its own.
            const hit = severityAtSidebarCardRow(sidebarFrameRows, event.y);
            if (hit === null) return undefined;
            openPopup(hit === "all" ? { all: true } : hit === "subagent" ? { subagent: true } : { severity: hit });
            return { handled: true };
          },
        };
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "right-center",
          width: "30%",
          minWidth: 24,
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
    sidebarNotes = [];
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

  /**
   * Row width for popup frames: render receives the overlay's resolved
   * width from pi-tui (the "80%" overlay option resolved against the
   * terminal, clamped to the margins), so no re-ratio is applied here.
   * Finite widths floor to at least 1; anything else falls back to
   * POPUP_WIDTH_MIN (tests, odd terminals).
   */
  function popupRowWidth(viewportWidth: number | undefined): number {
    return typeof viewportWidth === "number" && Number.isFinite(viewportWidth)
      ? Math.max(1, Math.floor(viewportWidth))
      : POPUP_WIDTH_MIN;
  }

  /**
   * Row width for sidebar frames: render receives the overlay's resolved
   * width from pi-tui (the "30%" overlay option resolved against the
   * terminal, minWidth 24, clamped to the margins). Finite widths floor to
   * at least 1; anything else falls back to SIDEBAR_FALLBACK_WIDTH (tests,
   * odd terminals).
   */
  function sidebarRowWidth(viewportWidth: number | undefined): number {
    return typeof viewportWidth === "number" && Number.isFinite(viewportWidth)
      ? Math.max(1, Math.floor(viewportWidth))
      : SIDEBAR_FALLBACK_WIDTH;
  }

  /**
   * Open the note popup as a capturing centered overlay (width and
   * maxHeight 80%; pi-tui resolves the percentage and hands the resolved
   * width to every render). TUI-only: headless
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
          : (target as { subagent?: true }).subagent === true
            ? store.pending.filter((note) => note.origin?.via === "subagent")
            : store.pending.filter((note) => note.severity === (target as { severity: Severity }).severity);
    // List stage reads newest first; a single note is unaffected by the flip.
    const notes = [...matches].reverse();
    if (notes.length === 0) return;
    let stage: PopupStage =
      notes.length > 1 ? { kind: "list", notes } : { kind: "detail", note: notes[0]! };
    let popupRows: CardRow[] = []; // rows of the most recent frame, for mouse hit-testing

    /** Framed rows of the current stage at the given width (render's single source). */
    const currentRows = (width: number | undefined): CardRow[] =>
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
            // Same segment mapping as the sidebar render: the framer owns the
            // frame, each segment carries the token to theme it with.
            return popupRows.map((row) =>
              row.segments.map((segment) => theme.fg(severityColorToken(segment.token), segment.text)).join(""),
            );
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
          width: "80%",
          maxHeight: "80%",
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

  /**
   * Register the you-should-know widget (TUI-only). The widget's regular-mode
   * presence is deliberately empty (render: () => []) — the tally overlay
   * stays the visible surface outside the fullscreen shell. Its job is to
   * host the "ysk" part in gentle-pi's experimental fullscreen rail when the
   * live TUI carries the rail state: the part renders the per-note heads-up
   * card (newest first), reports a cheap digest for the rail's section
   * cache, and routes row clicks to the note popup (a Note target opens the
   * detail stage directly). Without a rail state no part registers and the
   * widget paints nothing: best-effort and quiet, with every gentle-pi
   * internals change degrading silently to the overlay.
   */
  function registerRailWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    try {
      ctx.ui.setWidget(RAIL_WIDGET_KEY, (tui, theme) => {
        const railState = gentleRailState(tui);
        const gen = generation;
        // The most recent rail frame (rows, note mapping, and the notes they
        // were built from), for mouse hit-testing — the overlays' frameRows
        // pattern.
        let railFrameRows: CardRow[] = [];
        let railNoteAtRow: (number | null)[] = [];
        let railFrameNotes: Note[] = [];
        const railPart: GentleRailComponent | null =
          railState === null
            ? null
            : {
                render: (width?: number) => {
                  if (gen !== generation) return []; // stale session renders nothing
                  railFrameNotes = newestFirst(sidebarNotes);
                  const built = railHeadsUpRows(railFrameNotes, { width: sidebarRowWidth(width) });
                  railFrameRows = built.rows;
                  railNoteAtRow = built.noteAtRow;
                  return built.rows.map((row) =>
                    row.segments.map((segment) => theme.fg(severityColorToken(segment.token), segment.text)).join(""),
                  );
                },
                // Cheap memo key for gentle-pi's section cache: the raw
                // oldest-first snapshot; any content change revalidates.
                digest: () => JSON.stringify(sidebarNotes),
                handleMouse: (event) => {
                  if (gen !== generation) return undefined;
                  if (event?.type !== "click" || event.button !== "left") return undefined;
                  // Hit-test against the rows the part actually rendered;
                  // before the first render there is nothing to hit.
                  const hit =
                    typeof event?.y === "number" && Number.isInteger(event.y) ? railNoteAtRow[event.y] : undefined;
                  const note = typeof hit === "number" ? railFrameNotes[hit] : undefined;
                  if (!note) return undefined;
                  openPopup(note);
                  return { handled: true };
                },
                invalidate: () => {},
                dispose: () => disposeRailPart(railPart),
              };
        const disposeRailPart = (part: GentleRailComponent | null): void => {
          const parts = railState?.parts;
          if (part === null || !(parts instanceof Map)) return;
          try {
            // Guard: only remove the slot when it is still ours — a replaced
            // registration (or a squatter) must never be deleted by proxy.
            if (parts.get(RAIL_PART_KEY) === part) parts.delete(RAIL_PART_KEY);
          } catch {
            // quiet: part disposal is best-effort
          }
        };
        if (railState !== null && railPart !== null && railState.parts instanceof Map) {
          railTui = tui; // remember the TUI whose rail hosts us, for invalidation
          railHostConnected = true;
          try {
            railState.parts.set(RAIL_PART_KEY, railPart);
          } catch {
            // quiet: part registration is best-effort
          }
        }
        return {
          // Regular-mode presence stays empty on purpose: outside the
          // fullscreen rail the tally overlay is the visible surface.
          render: () => [],
          invalidate: () => {},
          dispose: () => disposeRailPart(railPart),
        };
      });
    } catch {
      // quiet: widget registration must never crash the session
    }
  }

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
    // Replace the widget for the new session; forget the old rail connection
    // until pi invokes the fresh factory (which re-registers the "ysk" part).
    railHostConnected = false;
    railTui = null;
    registerRailWidget(ctx);
    counter = new StepCounter();
    const cwd = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
    try {
      projectConfigPath = join(cwd, ".pi", "you-should-know.json");
      sessionConfig = await loadConfig(projectConfigPath, USER_CONFIG_PATH);
    } catch {
      sessionConfig = {
        reviewEvery: DEFAULT_REVIEW_EVERY,
        subagentRelay: true,
        subagentRelayMaxAgeHours: DEFAULT_RELAY_MAX_AGE_HOURS,
        dismissedTopics: [],
      };
    }

    // Per-session notes path (T10): one file per session id under
    // .pi/you-should-know-notes/, resolved with the same defensive
    // sessionManager accessor pattern the relay wiring uses. An absent or
    // empty session id disables persistence for the session: projectNotesPath
    // stays undefined, so nothing is restored and nothing is ever written
    // (memory-only tally; this should never happen in practice).
    const sessionId = sanitizeSessionId(
      sessionManagerValue(
        () => ctx.sessionManager.getSessionId(),
        () => "", // no usable id: sanitize maps "" to persistence disabled below
      ),
    );
    const notesDir = join(cwd, ".pi", NOTES_DIR_NAME);
    projectNotesPath = sessionId === undefined ? undefined : join(notesDir, `${sessionId}.json`);

    // Retention first: prune stale session files BEFORE the restore read,
    // never touching this session's own file (keepPath). Quiet best-effort,
    // and skipped entirely when persistence is disabled. Generation-checked
    // after the await so a replaced session stops here.
    if (projectNotesPath !== undefined) {
      await pruneSessionNotes(notesDir, { keepPath: projectNotesPath });
      if (gen !== generation) return; // session replaced or shut down while pruning
    }

    // Restore BEFORE any store mutation (T8 invariant, unchanged): the read
    // happens before clearPending/reseed/replacePending can fire
    // persistPending writes, so a chain write can never race ahead of the
    // read and the chain's FIFO order makes the final restore write
    // authoritative.
    //
    // Migration (adopt-once): when this session has no notes file yet but
    // the legacy pre-per-session global file exists, read the legacy file
    // instead and delete it afterwards, so exactly the first session to
    // start after this upgrade inherits the old notes (its own reseed then
    // writes them into the session file) and they never leak into other
    // sessions. Concurrent starts may race on the delete — tolerated.
    let persisted: Note[] = [];
    if (projectNotesPath !== undefined) {
      const legacyPath = join(cwd, ".pi", LEGACY_NOTES_FILENAME);
      if (!(await notesFileExists(projectNotesPath)) && (await notesFileExists(legacyPath))) {
        persisted = await loadPendingNotes(legacyPath);
        try {
          await rm(legacyPath, { force: true });
        } catch {
          // quiet: legacy removal is best-effort; the adoption still applies
        }
      } else {
        persisted = await loadPendingNotes(projectNotesPath);
      }
    }
    if (gen !== generation) return; // session replaced or shut down while loading

    // Reset pending for the new session, keeping permanent dismissals
    // authoritative from config (idempotent re-seed, no config writes), then
    // restore the persisted notes minus topics this session already
    // dismisses permanently, so the tally survives restarts. Notes removed
    // from the pending store are simply absent from the session's file and
    // never resurrect.
    store.clearPending();
    for (const topic of sessionConfig.dismissedTopics) {
      if (!store.isDismissed(topic)) store.dismissPermanently(topic);
    }
    store.replacePending(persisted.filter((note) => !store.isDismissed(note.topic)));
    setupRelay(ctx);
    requestRender(ctx);
  }

  /** Best-effort sessionManager read: a missing/throwing manager falls back. */
  function sessionManagerValue(read: () => string | undefined, fallback: () => string): string {
    try {
      const value = read();
      return typeof value === "string" && value.length > 0 ? value : fallback();
    } catch {
      return fallback();
    }
  }

  /**
   * (Re)arm the subagent relay for this session. Exactly one endpoint lives
   * at a time: a gentle-pi subagent child gets a RelayWriter (its real adds
   * mirror out through the store's onAdd hook), everyone else gets a
   * RelayWatcher ingesting child notes into the store; the relay off switch
   * arms neither. Called on every session_start AFTER the pending reseed so
   * ingested adds can never race the restore's clear-then-replace pair, and
   * it tears down the replaced session's watcher first. Every failure stays
   * quiet: a broken relay must never break session_start.
   */
  function setupRelay(ctx: ExtensionContext): void {
    try {
      relayWatcher?.close(); // session replacement: stop the previous watcher first
    } catch {
      // quiet: teardown is best-effort
    }
    relayWatcher = null;
    relayWriter = null;
    if (!sessionConfig.subagentRelay) return;
    const dir = overrides.relayDir ?? relayDirFor(relayEnv);
    if (isSubagentChild(relayEnv)) {
      const sessionId = sessionManagerValue(
        () => ctx.sessionManager.getSessionId(),
        () => randomUUID(),
      );
      const cwd = sessionManagerValue(
        () => ctx.sessionManager.getCwd(),
        () => (typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd()),
      );
      relayWriter = new RelayWriter({ dir, sessionId, cwd });
    } else {
      const gen = generation;
      relayWatcher = new RelayWatcher({
        dir,
        maxAgeMs: sessionConfig.subagentRelayMaxAgeHours * 3600 * 1000,
        ingest: (note) => {
          try {
            // Generation guard: a watcher outliving its session never
            // touches the new session's store (close() makes this rare).
            if (gen !== generation || !ctxRef) return;
            if (store.isDismissed(note.topic)) return;
            store.add(note);
            requestRender(ctxRef);
          } catch {
            // quiet: ingest is best-effort and must never reach the runtime
          }
        },
      });
      void relayWatcher.start(); // fire-and-forget: the initial scan lands when it lands
    }
  }

  pi.on("session_shutdown", (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
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
    // Drop the widget (its dispose removes the rail part) so a dead session
    // never keeps a rail slot. TUI-guarded like every other UI touch, and
    // quiet beside the relay teardown below.
    railHostConnected = false;
    railTui = null;
    try {
      if (ctx?.hasUI && ctx.mode === "tui") ctx.ui.setWidget(RAIL_WIDGET_KEY, undefined);
    } catch {
      // quiet: widget teardown at a session boundary is best-effort
    }
    try {
      relayWatcher?.close(); // stop event-triggered rescans; scanNow dies with the watcher reference
    } catch {
      // quiet: watcher teardown is best-effort
    }
    relayWatcher = null;
    relayWriter = null;
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

  /**
   * Persist the current pending notes to this session's state file
   * (.pi/you-should-know-notes/<session-id>.json). Every write funnels
   * through the shared notesWriteChain so mutations (notably session_start's
   * clear-then-restore pair) can never reorder on disk, and every failure
   * is swallowed: persistence is best-effort and must never reach the
   * runtime. No-op until session_start has resolved a per-session path —
   * an absent session id keeps the session memory-only.
   */
  function persistNotes(notes: Note[]): void {
    const path = projectNotesPath;
    if (!path) return;
    notesWriteChain = notesWriteChain
      .then(() => savePendingNotes(path, notes))
      .catch(() => {
        // quiet: a failed notes write must never crash the session
      });
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
      relayStatusLine(),
    ].join("\n");
  }

  /**
   * The relay's one-line /ysk status: what the child writes to, what the
   * parent has ingested, or "off". Failures stay quiet per the module style.
   */
  function relayStatusLine(): string {
    try {
      if (relayWriter !== null) {
        return `subagent relay: writing to ${relayWriter.file}`;
      }
      if (relayWatcher !== null) {
        return `subagent relay: on · ingested ${relayWatcher.stats().ingested} notes`;
      }
    } catch {
      // quiet: status must never throw
    }
    return "subagent relay: off";
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
