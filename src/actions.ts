/**
 * /ysk command parsing and action routing for you-should-know.
 *
 * Parsing (`parseYskArgs`) and note selection (`resolveNote`) are pure.
 * `wireActions` registers the /ysk command and delegates every side effect
 * to injected dependencies (store, popup opening, note processing, editor
 * fill, persistence, rendering, notifications, status text), so the routing
 * logic is testable without a terminal or a session. The popup and
 * editor-fill adapters themselves are implemented in index.ts, not here.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatNotesForChat, type Note } from "./notes.ts";

/** The /ysk sub-actions. Unknown input falls back to "status". */
export type YskAction = "learn" | "known" | "chat" | "dismiss" | "status" | "popup";

export interface ParsedYskArgs {
  action: YskAction;
  /**
   * 1-based note index into the pending list (oldest = 1, matching the
   * widget's display order). Absent means "newest note".
   */
  index?: number;
  /** Set when the input was not understood; the handler surfaces it as a hint. */
  hint?: string;
}

const ACTIONS: readonly YskAction[] = ["learn", "known", "chat", "dismiss", "status", "popup"];

/**
 * Parse /ysk arguments, tolerantly:
 * - "" or whitespace -> popup (the all-notes popup is the /ysk default)
 * - a known action word -> that action
 * - a bare number -> shorthand for `learn <n>`
 * - anything else -> status with a hint
 * A second numeric token after the action is the note index; other extra
 * tokens are ignored rather than guessed at.
 */
export function parseYskArgs(raw: string): ParsedYskArgs {
  const tokens = (typeof raw === "string" ? raw : "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { action: "popup" };

  const [first, second] = tokens;
  const bareIndex = parseIndex(first);
  if (bareIndex !== undefined) return { action: "learn", index: bareIndex };

  if (!isAction(first)) {
    return { action: "status", hint: `Unknown action "${first}". Actions: ${ACTIONS.join(" · ")}` };
  }
  const parsed: ParsedYskArgs = { action: first };
  const index = parseIndex(second);
  if (index !== undefined) parsed.index = index;
  return parsed;
}

/**
 * Pick the note an action targets: the newest pending note by default, or
 * the given 1-based index (oldest = 1, matching the widget's display order).
 * Out-of-range, zero, negative, and fractional indexes return undefined.
 */
export function resolveNote(pending: Note[], index?: number): Note | undefined {
  const list = Array.isArray(pending) ? pending : [];
  if (list.length === 0) return undefined;
  if (index === undefined) return list[list.length - 1];
  if (!Number.isInteger(index) || index < 1 || index > list.length) return undefined;
  return list[index - 1];
}

/**
 * Side-effecting collaborators injected into the /ysk command handler.
 * Everything that touches a terminal, the session, or the filesystem is
 * injected so tests can drive the handler with plain fakes.
 */
export interface ActionDeps {
  /** NoteStore-compatible surface (pending list + dismissal methods). */
  store: {
    readonly pending: Note[];
    dismissSession(topic: string): boolean;
    dismissPermanently(topic: string): void;
    isDismissed(topic: string): boolean;
  };
  /**
   * Open the note popup: a single note opens its detail stage directly, the
   * { all: true } target opens the list of every pending note (implemented
   * in index.ts; no-op without a TUI).
   */
  openPopup: (target: Note | { all: true }) => void;
  /**
   * Mark one note processed for this session: it leaves the pending tally
   * (still reachable via /ysk status; permanent dismissal stays /ysk known).
   * Implemented in index.ts as dismissSession + sidebar refresh.
   */
  markProcessed: (note: Note) => void;
  /**
   * Fill the prompt editor with composed text; the user reviews and sends
   * it manually (implemented in index.ts; nothing is auto-sent).
   */
  fillEditor: (text: string) => void;
  /** Persist the permanently dismissed topics (saveDismissed adapter). */
  persist: () => void | Promise<void>;
  /** Refresh the HUD widget after dismissals. */
  rerender: () => void;
  /** User-visible command output (ctx.ui.notify adapter). */
  notify: (message: string, kind?: "info" | "warning" | "error") => void;
  /** Multi-line reviewer status text for the status action. */
  status: () => string;
}

/** Register the /ysk command. The handler only parses, resolves, and delegates. */
export function wireActions(pi: ExtensionAPI, deps: ActionDeps): void {
  pi.registerCommand("ysk", {
    description: "you-should-know: /ysk [learn|known|chat|dismiss|status|popup] [note#]",
    getArgumentCompletions: (prefix: string) =>
      ACTIONS.filter((action) => action.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args: string) => {
      const parsed = parseYskArgs(args);
      if (parsed.hint !== undefined) deps.notify(parsed.hint, "warning");

      if (parsed.action === "status") {
        deps.notify(deps.status(), "info");
        return;
      }

      const note = resolveNote(deps.store.pending, parsed.index);
      if (!note) {
        deps.notify(parsed.index !== undefined ? `No pending note #${parsed.index}.` : "No pending notes right now.", "warning");
        return;
      }

      switch (parsed.action) {
        case "popup":
          // Bare /ysk opens the all-notes popup; an index opens that note.
          deps.openPopup(parsed.index === undefined ? { all: true } : note);
          return;
        case "learn":
          deps.openPopup(note);
          return;
        case "known":
          deps.store.dismissPermanently(note.topic);
          await deps.persist();
          deps.rerender();
          deps.notify(`Knew this already — "${note.topic}" dismissed permanently.`, "info");
          return;
        case "chat":
          deps.fillEditor(`Re: heads-up — please address\n\n${formatNotesForChat([note])}`);
          deps.markProcessed(note);
          deps.notify("Note copied to the prompt — marked as processed.", "info");
          return;
        case "dismiss":
          deps.store.dismissSession(note.topic);
          deps.rerender();
          deps.notify(`Hidden for this session: "${note.topic}"`, "info");
          return;
      }
    },
  });
}

/** Non-negative integer or undefined; 0 is kept so resolveNote can reject it. */
function parseIndex(token: string | undefined): number | undefined {
  if (token === undefined || !/^\d+$/.test(token)) return undefined;
  const value = Number.parseInt(token, 10);
  return Number.isFinite(value) ? value : undefined;
}

function isAction(token: string): token is YskAction {
  return (ACTIONS as readonly string[]).includes(token);
}
