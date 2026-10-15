/**
 * Pure view models for the you-should-know sidebar + popup overlays.
 *
 * This module knows nothing about the terminal: every builder returns plain
 * structural rows that the TUI-facing caller (index.ts) colors with theme
 * tokens via `theme.fg()`. The severity -> theme-token mapping is exported so
 * the callers share one source of truth (info=accent, warning=warning,
 * critical=error; the pure "muted" pseudo-severity marks de-emphasized rows
 * such as headers and hints).
 *
 * Layout: a right-edge tally sidebar card (tallyBySeverity and
 * sidebarCardRows, hit-tested via severityAtSidebarCardRow) and a mid-size
 * popup with a list
 * stage (popupListRows, noteIndexAtPopupRow) and a detail stage
 * (popupDetailRows, popupActionAtRow). Both card surfaces share the
 * frameCardRows framer (the sidebar's rounded-card geometry); POPUP_ACTIONS
 * is the single source of truth for the detail-stage action keys and
 * labels.
 *
 * Contract: no terminal or theme imports, rows carry Severity | "muted"
 * tokens (card rows additionally carry "border" frame runs) for the caller
 * to theme via CardRow segments. The sidebar card truncates over-long text
 * (truncateLine); the popup stages instead WRAP (wrapLine) so the full note
 * brief is always visible — no ellipsis in any popup body row. The
 * hit-test helpers read the produced rows themselves — parsing each framed
 * row's body text (its middle segments joined) — so the rendered rows stay
 * the single source of truth for what is interactive.
 *
 * Width handling: we deliberately implement conservative CHARACTER-count
 * layout: every produced card row is at most `width` characters (sidebar
 * title/body truncation, popup wrapping). Glyph widths wider than one
 * terminal cell could still overflow, which is acceptable for the
 * plain-ASCII note text the reviewer prompt contract produces.
 */

import { type Note, type Severity } from "./notes.ts";

/** Theme token used per severity or card-frame segment; applied via theme.fg(). */
export type SeverityToken = "accent" | "warning" | "error" | "muted" | "border";

/** Pure severity/card-segment -> theme-token mapping (caller-side theming hook). */
export function severityColorToken(severity: Severity | SeverityToken): SeverityToken {
  if (severity === "warning") return "warning";
  if (severity === "critical") return "error";
  if (severity === "muted") return "muted";
  if (severity === "border") return "border";
  return "accent";
}

/** Pure severity -> display label used inside widget lines. */
export function severityLabel(severity: Severity): string {
  if (severity === "warning") return "warning";
  if (severity === "critical") return "critical";
  return "info";
}

/** One view-model row: its text plus the severity that should color it. */
export interface WidgetLine {
  severity: Severity | "muted";
  text: string;
}

/**
 * Truncate text to a conservative character count. The result is at most
 * `width` characters, with a trailing ellipsis marking the cut (except at
 * width 1, where there is no room for a marker). Invalid widths (non-finite
 * or < 1) leave the text untouched.
 */
export function truncateLine(text: string, width: number | undefined): string {
  if (!isUsableWidth(width)) return text;
  const bound = Math.floor(width);
  if (text.length <= bound) return text;
  return bound === 1 ? text.slice(0, 1) : `${text.slice(0, bound - 1)}…`;
}

/** True when the width is a usable truncation bound. */
function isUsableWidth(width: number | undefined): width is number {
  return typeof width === "number" && Number.isFinite(width) && width >= 1;
}

/** Title to display: the note title, falling back to its topic when blank. */
function displayTitle(note: Note): string {
  const title = typeof note.title === "string" ? note.title.trim() : "";
  return title.length > 0 ? title : note.topic;
}

// ---------------------------------------------------------------------------
// Sidebar + popup view models (ysk-sidebar). Pure: no terminal or theme
// imports; rows carry Severity | "muted" tokens (the sidebar card adds
// "border" frame runs), and rows pass through truncateLine at the caller's
// width. The row-hit helpers read the produced rows (segment tokens or row
// text) so the rows stay the single source of truth for what is interactive.
// ---------------------------------------------------------------------------

/** Per-severity pending-note counts backing the sidebar overlay. */
export interface SeverityTally {
  critical: number;
  warning: number;
  info: number;
}

/** What a sidebar row selects: the header covers all severities at once. */
export type SidebarHit = "all" | Severity | null;

/** One themed run of text inside a card row. */
export interface CardSegment {
  /** Theme token for this run: the row's severity, "muted", or "border" for frame runs. */
  token: Severity | "muted" | "border";
  /** Literal text; glyphs count as one cell each (the module's character convention). */
  text: string;
}

/** One card row: an ordered list of segments the caller renders left to right. */
export interface CardRow {
  segments: CardSegment[];
}

/** Action named by a popup detail-stage hint entry. */
export type PopupAction = "understood" | "chat" | "dismiss" | null;

/** One actionable detail-stage entry: key, action name, and hint label. */
export interface PopupActionEntry {
  /** The key (and hint-row prefix digit) that triggers the action. */
  key: string;
  action: Exclude<PopupAction, null>;
  label: string;
}

/**
 * Detail-stage actions; single source of truth for the popup's keys, hint
 * rows, and hit-testing (index.ts never hardcodes them).
 */
export const POPUP_ACTIONS: readonly PopupActionEntry[] = [
  { key: "1", action: "understood", label: "Understood" },
  { key: "2", action: "chat", label: "Chat in main session" },
  { key: "0", action: "dismiss", label: "Dismiss" },
];

/** Prefix of the sidebar total headline. */
const SIDEBAR_HEADER_PREFIX = "✦ ";
/** Prefix of a sidebar per-severity count row. */
const SIDEBAR_ROW_PREFIX = "■ ";
/** Sidebar row order: highest priority severity first. */
const SIDEBAR_SEVERITY_ORDER = ["critical", "warning", "info"] as const;
/** Hint of the popup list stage. */
const POPUP_LIST_HINT = "number to open · Esc to close";
/** Title of every framed popup card (both stages). */
const POPUP_CARD_TITLE = "✦ Heads up";

/**
 * Detail-stage hint block: one muted row per action so every action is its
 * own click target. Rows derive from POPUP_ACTIONS so the action map stays
 * authoritative; popupActionAtRow parses these rows. The framer emits fresh
 * CardRow copies, so the shared line objects are never handed to callers.
 */
const POPUP_HINT_ROWS: readonly WidgetLine[] = POPUP_ACTIONS.map((entry) => ({
  severity: "muted",
  text: `${entry.key}: ${entry.label}`,
}));

/**
 * Count pending notes per severity. Non-array input counts as empty so a
 * broken caller degrades to a zeroed tally instead of throwing.
 */
export function tallyBySeverity(notes: Note[]): SeverityTally {
  const tally: SeverityTally = { critical: 0, warning: 0, info: 0 };
  const list = Array.isArray(notes) ? notes : [];
  for (const note of list) {
    const severity = (note as Note | undefined)?.severity;
    if (severity === "critical" || severity === "warning" || severity === "info") tally[severity] += 1;
  }
  return tally;
}

/** The card frame width: finite numbers floor to an integer; anything else degenerates to 0. */
function cardWidth(width: number | undefined): number {
  return typeof width === "number" && Number.isFinite(width) ? Math.floor(width) : 0;
}

/**
 * Frame plain rows into the gentle-pi-style rounded card shared by the
 * sidebar and the popups: a top rule "╭─ <title> ─…╮" (frame in the
 * "border" token, title in "info"/accent, truncated to width − 5 characters
 * with the fill dashes clamped at 0), one body row per input row as
 * "│ <text> <pad>│" carrying the row's own token, with the text truncated
 * to width − 4 (truncateLine semantics) and the padding clamped so every
 * row is exactly `width` columns, and a closing "╰──…╯". Widths below 5
 * degenerate to bare clamped rules (the gentle-pi cardTop narrow branches:
 * the title and body cannot fit and drop). Callers that must never
 * truncate (the popups) wrap their rows with wrapLine at width − 4 first,
 * which makes the truncation a no-op.
 */
export function frameCardRows(rows: WidgetLine[], title: string, options: { width: number }): CardRow[] {
  const width = cardWidth(options?.width);
  const body: WidgetLine[] = Array.isArray(rows) ? rows : [];
  const heading = typeof title === "string" ? title : "";

  if (width < 5) {
    // Degenerate frame, mirroring gentle-pi cardTop's narrow branches: the
    // title and body cannot fit, so only clamped bare rules render.
    const dashes = "─".repeat(Math.max(0, width - 2));
    const top = width === 1 ? "╭" : `╭${dashes}╮`;
    const bottom = width === 1 ? "╰" : `╰${dashes}╯`;
    return [
      { segments: [{ token: "border", text: top }] },
      { segments: [{ token: "border", text: bottom }] },
    ];
  }

  const framedTitle = truncateLine(heading, width - 5);
  const card: CardRow[] = [
    {
      segments: [
        { token: "border", text: "╭─ " },
        { token: "info", text: framedTitle },
        { token: "border", text: ` ${"─".repeat(Math.max(0, width - framedTitle.length - 5))}╮` },
      ],
    },
  ];
  for (const row of body) {
    const text = truncateLine(row.text, width - 4);
    const padding = " ".repeat(Math.max(0, width - 4 - text.length));
    card.push({
      segments: [
        { token: "border", text: "│ " },
        { token: row.severity, text },
        { token: "border", text: `${padding} │` },
      ],
    });
  }
  card.push({ segments: [{ token: "border", text: `╰${"─".repeat(Math.max(0, width - 2))}╯` }] });
  return card;
}

/**
 * Greedy word wrap on spaces: fit as many whole words per row as `width`
 * allows. A single word longer than `width` is hard-broken at exactly
 * `width` characters — no ellipsis, nothing lost (concatenating the rows
 * reproduces the words). Runs of spaces collapse to single separators and
 * the ends trim, so empty text wraps to [""] (one empty row). Widths below
 * 2 (including invalid ones) degenerate to 1-character rows. The popup
 * builders wrap at the card's inner width (width − 4) so the full text
 * survives framing without truncation.
 */
export function wrapLine(text: string, width: number): string[] {
  const bound = typeof width === "number" && Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const source = typeof text === "string" ? text : "";
  const lines: string[] = [];
  let current = "";
  for (const rawWord of source.split(" ")) {
    let word = rawWord;
    if (word.length === 0) continue; // collapse space runs and trim the ends
    if (current.length > 0 && current.length + 1 + word.length <= bound) {
      current = `${current} ${word}`;
      continue;
    }
    if (current.length > 0) {
      lines.push(current);
      current = "";
    }
    while (word.length > bound) {
      // Hard-break over-long words: exact-width chunks, nothing dropped.
      lines.push(word.slice(0, bound));
      word = word.slice(bound);
    }
    current = word;
  }
  if (current.length > 0 || lines.length === 0) lines.push(current);
  return lines;
}

/**
 * Sidebar card rows: the gentle-pi-style rounded card framing the pending
 * tally, built through the shared frameCardRows framer. The top rule reads
 * "╭─ ✦ <total> heads-up ─…╮" (frame in the "border" token, title in
 * "info"/accent; singular "head-up" when total is 1), one body row per
 * non-zero severity in priority order (critical, warning, info) as
 * "│ ■ <count> <label> …│", then "╰──…╯". Truncation and padding are the
 * framer's (title to width − 5, body to width − 4, both clamped); widths
 * below 5 degenerate to bare clamped rules. No notes, or unusable notes
 * input, means no sidebar: [].
 */
export function sidebarCardRows(notes: Note[], options: { width: number }): CardRow[] {
  const tally = tallyBySeverity(notes);
  const total = tally.critical + tally.warning + tally.info;
  if (total === 0) return [];

  const body: WidgetLine[] = [];
  for (const severity of SIDEBAR_SEVERITY_ORDER) {
    const count = tally[severity];
    if (count > 0) body.push({ severity, text: `${SIDEBAR_ROW_PREFIX}${count} ${severityLabel(severity)}` });
  }
  const unit = total === 1 ? "head-up" : "heads-up";
  return frameCardRows(body, `${SIDEBAR_HEADER_PREFIX}${total} ${unit}`, { width: cardWidth(options?.width) });
}

/**
 * Resolve a 0-based component-local sidebar card line index to what it
 * selects: the top rule covers all severities ("all"), a body row its
 * middle segment's severity (info/warning/critical), and the bottom rule,
 * non-integer indices, and anything out of range select nothing (null).
 */
export function severityAtSidebarCardRow(rows: CardRow[], y: number): SidebarHit {
  if (!Array.isArray(rows) || rows.length === 0 || !Number.isInteger(y) || y < 0 || y >= rows.length) return null;
  if (y === 0) return "all";
  if (y === rows.length - 1) return null; // the bottom rule never selects
  const token = rows[y]!.segments[1]?.token;
  return token === "critical" || token === "warning" || token === "info" ? token : null;
}

/**
 * Popup list-stage rows, framed as a "✦ Heads up" card: one numbered row
 * per note in array order (newest-first is the caller's job) as
 * "<i>. [<label>] <title>" colored with the note's severity, wrapped with
 * wrapLine at the card's inner width (width − 4) so long titles continue on
 * severity-colored unprefixed rows instead of truncating, then the muted
 * navigation hint. Empty or unusable notes, or a width too small to frame
 * (< 5), mean no popup: []. The width is required in practice: callers
 * must pass the overlay's resolved width.
 */
export function popupListRows(notes: Note[], options?: { width: number }): CardRow[] {
  const list = Array.isArray(notes) ? notes : [];
  const width = cardWidth(options?.width);
  if (list.length === 0 || width < 5) return [];

  const inner = width - 4; // the frame eats "│ " + " │"
  const body: WidgetLine[] = [];
  list.forEach((note, index) => {
    if (note === null || typeof note !== "object") return; // skip garbage; numbering stays array-aligned
    const line = `${index + 1}. [${severityLabel(note.severity)}] ${displayTitle(note)}`;
    body.push(...wrappedLines({ severity: note.severity, text: line }, inner));
  });
  body.push(...wrappedLines({ severity: "muted", text: POPUP_LIST_HINT }, inner));
  return frameCardRows(body, POPUP_CARD_TITLE, { width });
}

/**
 * Resolve a 0-based popup list card-row index to the 1-based note index
 * shown on that row. Recognition parses the framed row's body text (its
 * middle segments joined) for a "<i>. " prefix, so framing cannot desync
 * hit-testing from row text: continuation rows, the hint, both frame rules,
 * and anything out of range select no note (null).
 */
export function noteIndexAtPopupRow(rows: CardRow[], y: number): number | null {
  const match = /^(\d+)\.\s/.exec(cardBodyText(rowAt(rows, y)));
  return match ? Number(match[1]) : null;
}

/**
 * Detail-stage popup rows for one note, framed as a "✦ Heads up" card: the
 * full display title as its own row colored with the note's severity
 * (wrapped, never truncated), a blank info row, one info row per detail
 * line (split on newlines and trimmed; wholly blank details are omitted,
 * blank lines inside a detail are kept as paragraph separators), a blank
 * row, and the muted action-hint block (one row per POPUP_ACTIONS entry so
 * each action is its own click target; long hint rows wrap like any body
 * row). Null/non-object notes or an unframeable width (< 5) produce [].
 */
export function popupDetailRows(note: Note, options?: { width: number }): CardRow[] {
  if (note === null || typeof note !== "object") return [];
  const width = cardWidth(options?.width);
  if (width < 5) return [];

  const inner = width - 4; // the frame eats "│ " + " │"
  // The full display title wraps (never truncates), keeping the note's severity.
  const body: WidgetLine[] = [...wrappedLines({ severity: note.severity, text: displayTitle(note) }, inner)];
  body.push({ severity: "info", text: "" });
  const detail = typeof note.detail === "string" ? note.detail.trim() : "";
  if (detail.length > 0) {
    for (const line of detail.split("\n")) {
      body.push(...wrappedLines({ severity: "info", text: line.trim() }, inner));
    }
  }
  body.push({ severity: "info", text: "" });
  for (const hint of POPUP_HINT_ROWS) body.push(...wrappedLines(hint, inner));
  return frameCardRows(body, POPUP_CARD_TITLE, { width });
}

/**
 * Resolve a 0-based popup detail card-row index to the action whose hint
 * row sits there, by parsing the framed row's body text (its middle
 * segments joined) for a "<key>: <label>" prefix, so the hint text stays
 * the single source of truth for the key -> action mapping (1 ->
 * understood, 2 -> chat, 0 -> dismiss).
 *
 * POSITIONAL GUARD: the actionable block is the POPUP_ACTIONS.length rows
 * immediately ABOVE the bottom rule (block start = rows.length − 1 −
 * POPUP_ACTIONS.length). The bottom rule itself, everything above and
 * before the block, and anything out of range return null — so a detail
 * line that merely starts "2: Chat …" can never trigger an action.
 */
export function popupActionAtRow(rows: CardRow[], y: number): PopupAction {
  if (!Array.isArray(rows) || !Number.isInteger(y) || y < 0 || y >= rows.length) return null;
  const blockStart = rows.length - 1 - POPUP_ACTIONS.length;
  if (y < blockStart || y > rows.length - 2) return null; // only the hint rows above the bottom rule hit
  const entry = /^(\d+):\s+/.exec(cardBodyText(rows[y]));
  if (!entry) return null;
  const action = POPUP_ACTIONS.find((candidate) => candidate.key === entry[1])?.action;
  return action ?? null;
}

/** The selected card row, or undefined when rows/y are unusable. */
function rowAt(rows: CardRow[], y: number): CardRow | undefined {
  if (!Array.isArray(rows) || !Number.isInteger(y) || y < 0 || y >= rows.length) return undefined;
  return rows[y];
}

/** Body text of a framed card row: its middle segments joined (frame runs dropped). */
function cardBodyText(row: CardRow | undefined): string {
  if (!row || !Array.isArray(row.segments)) return "";
  return row.segments
    .slice(1, -1)
    .map((segment) => segment.text)
    .join("");
}

/** Wrap one widget line into inner-width lines that all keep the line's severity token. */
function wrappedLines(line: WidgetLine, innerWidth: number): WidgetLine[] {
  return wrapLine(line.text, innerWidth).map((text) => ({ severity: line.severity, text }));
}
