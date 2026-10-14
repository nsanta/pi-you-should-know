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
 * Layout: a right-edge tally sidebar (tallyBySeverity and sidebarRows,
 * hit-tested via severityAtSidebarRow) and a mid-size popup with a list
 * stage (popupListRows, noteIndexAtPopupRow) and a detail stage
 * (popupDetailRows, popupActionAtRow). POPUP_ACTIONS is the single source of
 * truth for the detail-stage action keys and labels.
 *
 * Contract: no terminal or theme imports, rows carry Severity | "muted"
 * tokens for the caller to theme, and every row passes through truncateLine
 * at the caller's width. The hit-test helpers parse the produced row text (the
 * "<i>. " list prefix, each detail hint row's "<key>: <label>" prefix) so
 * row text stays the single source of truth for what is interactive.
 *
 * Width handling: we deliberately implement conservative CHARACTER-count
 * truncation: every produced line is at most `width` characters. Glyph
 * widths wider than one terminal cell could still overflow, which is
 * acceptable for the plain-ASCII note text the reviewer prompt contract
 * produces.
 */

import { type Note, type Severity } from "./notes.ts";

/** Theme token used per severity; applied by the caller via theme.fg(). */
export type SeverityToken = "accent" | "warning" | "error" | "muted";

/** Pure severity -> theme-token mapping (caller-side theming hook). */
export function severityColorToken(severity: Severity | "muted"): SeverityToken {
  if (severity === "warning") return "warning";
  if (severity === "critical") return "error";
  if (severity === "muted") return "muted";
  return "accent";
}

/** Pure severity -> display label used inside widget lines. */
export function severityLabel(severity: Severity): string {
  if (severity === "warning") return "warning";
  if (severity === "critical") return "critical";
  return "info";
}

/** Options for view-model rendering. */
export interface WidgetOptions {
  /** Truncate every line to this many characters. No truncation when absent. */
  width?: number;
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
// imports; rows carry the same Severity | "muted" tokens, and every row
// passes through truncateLine at the caller's width. The row-hit helpers
// parse the produced row text so row text stays the single source of truth
// for what is interactive.
// ---------------------------------------------------------------------------

/** Per-severity pending-note counts backing the sidebar overlay. */
export interface SeverityTally {
  critical: number;
  warning: number;
  info: number;
}

/** What a sidebar row selects: the header covers all severities at once. */
export type SidebarHit = "all" | Severity | null;

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

/**
 * Detail-stage hint block: one muted row per action so every action is its
 * own click target. Rows derive from POPUP_ACTIONS so the action map stays
 * authoritative; popupActionAtRow parses these rows. Shared row objects are
 * safe: truncateAll always emits fresh copies.
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

/**
 * Sidebar overlay rows: an accent total header ("✦ <total> heads-up", or
 * "head-up" in the singular) followed by one row per non-zero severity in
 * priority order (critical, warning, info) as "■ <count> <label>". No notes
 * means no sidebar: [].
 */
export function sidebarRows(notes: Note[], options: WidgetOptions = {}): WidgetLine[] {
  const tally = tallyBySeverity(notes);
  const total = tally.critical + tally.warning + tally.info;
  if (total === 0) return [];

  const unit = total === 1 ? "head-up" : "heads-up";
  const rows: WidgetLine[] = [{ severity: "info", text: `${SIDEBAR_HEADER_PREFIX}${total} ${unit}` }];
  for (const severity of SIDEBAR_SEVERITY_ORDER) {
    const count = tally[severity];
    if (count > 0) rows.push({ severity, text: `${SIDEBAR_ROW_PREFIX}${count} ${severityLabel(severity)}` });
  }
  return truncateAll(rows, options.width);
}

/**
 * Resolve a 0-based component-local sidebar line index to what it selects:
 * the header row covers all severities ("all"), a count row its severity,
 * and anything out of range selects nothing (null).
 */
export function severityAtSidebarRow(rows: WidgetLine[], y: number): SidebarHit {
  const row = rowAt(rows, y);
  if (!row) return null;
  if (y === 0) return "all";
  const severity = row.severity;
  return severity === "muted" ? null : severity;
}

/**
 * Popup list-stage rows: a muted "Heads up" header, one row per note in
 * array order (newest-first is the caller's job) as "<i>. [<label>] <title>"
 * colored with the note's severity, then a muted navigation hint. No notes
 * means no popup: [].
 */
export function popupListRows(notes: Note[], options: WidgetOptions = {}): WidgetLine[] {
  const list = Array.isArray(notes) ? notes : [];
  if (list.length === 0) return [];

  const rows: WidgetLine[] = [{ severity: "muted", text: "Heads up" }];
  list.forEach((note, index) => {
    rows.push({
      severity: note.severity,
      text: `${index + 1}. [${severityLabel(note.severity)}] ${displayTitle(note)}`,
    });
  });
  rows.push({ severity: "muted", text: POPUP_LIST_HINT });
  return truncateAll(rows, options.width);
}

/**
 * Resolve a 0-based popup list line index to the 1-based note index shown on
 * that row. The header, the hint, and anything out of range select no note
 * (null). Numbered rows are recognized by their "<i>. " prefix so layout
 * tweaks cannot desync hit-testing from row text.
 */
export function noteIndexAtPopupRow(rows: WidgetLine[], y: number): number | null {
  const match = /^(\d+)\.\s/.exec(rowAt(rows, y)?.text ?? "");
  return match ? Number(match[1]) : null;
}

/**
 * Detail-stage popup rows for one note: a severity-colored "Heads up ·
 * <title>" header, a blank row, one info row per detail line (omitted when
 * the detail is blank), a blank row, and a muted three-row action hint
 * block (one row per action, so each action is its own click target). Hint
 * rows derive from the exported POPUP_ACTIONS so the action map stays the
 * single source of truth.
 */
export function popupDetailRows(note: Note, options: WidgetOptions = {}): WidgetLine[] {
  if (note === null || typeof note !== "object") return [];
  const rows: WidgetLine[] = [{ severity: note.severity, text: `Heads up · ${displayTitle(note)}` }];
  rows.push({ severity: "info", text: "" });
  const detail = typeof note.detail === "string" ? note.detail.trim() : "";
  if (detail.length > 0) {
    for (const line of detail.split("\n")) rows.push({ severity: "info", text: line.trim() });
  }
  rows.push({ severity: "info", text: "" });
  rows.push(...POPUP_HINT_ROWS);
  return truncateAll(rows, options.width);
}

/**
 * Resolve a 0-based popup detail line index to the action whose hint row
 * sits there, by parsing the row's "<key>: <label>" prefix, so the hint
 * text stays the single source of truth for the key -> action mapping
 * (1 -> understood, 2 -> chat, 0 -> dismiss).
 *
 * POSITIONAL GUARD: only the trailing hint block (the last
 * POPUP_ACTIONS.length rows, exactly the block popupDetailRows emits) is
 * actionable. The header, blank rows, detail text, and anything out of
 * range return null — so a detail line that merely starts "2: Chat …" can
 * never trigger an action.
 */
export function popupActionAtRow(rows: WidgetLine[], y: number): PopupAction {
  if (!Array.isArray(rows) || !Number.isInteger(y) || y < 0 || y >= rows.length) return null;
  if (y < rows.length - POPUP_ACTIONS.length) return null; // only the trailing hint block hits
  const entry = /^(\d+):\s+/.exec(rows[y]!.text);
  if (!entry) return null;
  const action = POPUP_ACTIONS.find((candidate) => candidate.key === entry[1])?.action;
  return action ?? null;
}

/** The selected row, or undefined when rows/y are unusable. */
function rowAt(rows: WidgetLine[], y: number): WidgetLine | undefined {
  if (!Array.isArray(rows) || !Number.isInteger(y) || y < 0 || y >= rows.length) return undefined;
  return rows[y];
}

/** Apply the module's width truncation to every row, preserving tokens. */
function truncateAll(rows: WidgetLine[], width: number | undefined): WidgetLine[] {
  return rows.map((row) => ({ severity: row.severity, text: truncateLine(row.text, width) }));
}
