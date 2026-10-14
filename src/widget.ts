/**
 * Pure widget line-building for the you-should-know HUD.
 *
 * This module knows nothing about the terminal: `renderWidget` returns plain
 * strings and `widgetLines` returns structural rows that the TUI-facing
 * caller (index.ts) colors with theme tokens via `theme.fg()`. The severity
 * -> theme-token mapping is exported so the widget and its callers share one
 * source of truth (info=accent, warning=warning, critical=error; the pure
 * "muted" pseudo-severity marks de-emphasized rows such as the collapsed
 * "+N more" line).
 *
 * Layout: the widget is a two-state interactive band. Collapsed (default) it
 * shows the newest note as a one-to-two-row summary ("✦ Heads up · …"), an
 * optional muted "+N more · /ysk" row when older notes are pending, and the
 * collapsed action hint. Expanded (`expanded: true`) it renders the newest
 * note only: summary ("Heads up · …"), blank row, title, one row per detail
 * line, blank row, and the expanded action hint. `KEY_ACTIONS` is the single
 * source of truth for the action key labels so index.ts never hardcodes them.
 *
 * Sidebar/popup view models: the ysk-sidebar builders extend this module with
 * pure view models for the right-edge sidebar overlay (tallyBySeverity and
 * sidebarRows, hit-tested via severityAtSidebarRow) and the mid-size popup's
 * list stage (popupListRows, noteIndexAtPopupRow) and detail stage
 * (popupDetailRows, popupActionAtRow). They follow the same contract as the
 * band: no terminal or theme imports, rows carry Severity | "muted" tokens
 * for the caller to theme, and every row passes through truncateLine at the
 * caller's width. The hit-test helpers parse the produced row text (the
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

/**
 * Action key labels per widget state; single source of truth for index.ts.
 * @deprecatedSuperseded by sidebar/popup builders (T3 removes)
 */
export const KEY_ACTIONS = {
  collapsed: { learn: "1", known: "2", dismiss: "0" },
  expanded: { understood: "1", chat: "2", dismiss: "0" },
} as const;

/** Prefix of the collapsed summary headline. */
const COLLAPSED_PREFIX = "✦ Heads up · ";
/** Prefix of the expanded summary headline. */
const EXPANDED_PREFIX = "Heads up · ";

/** Hints derive their digits from KEY_ACTIONS so the map stays authoritative. */
const COLLAPSED_HINT = `${KEY_ACTIONS.collapsed.learn}: Learn more  ${KEY_ACTIONS.collapsed.known}: Knew this already  ${KEY_ACTIONS.collapsed.dismiss}: Dismiss`;
const EXPANDED_HINT = `${KEY_ACTIONS.expanded.understood}: Understood  ${KEY_ACTIONS.expanded.chat}: Chat in main session  ${KEY_ACTIONS.expanded.dismiss}: Dismiss`;

/** Options for widget rendering. */
export interface WidgetOptions {
  /** Truncate every line to this many characters. No truncation when absent. */
  width?: number;
  /**
   * Render the expanded single-note view instead of the collapsed band. Defaults to false.
   * @deprecatedSuperseded by sidebar/popup builders (T3 removes)
   */
  expanded?: boolean;
}

/** One widget row: its text plus the severity that should color it. */
export interface WidgetLine {
  severity: Severity | "muted";
  text: string;
}

/**
 * Build the structural widget rows for the current widget state. Collapsed
 * (default): the newest note's summary, an optional muted "+N more · /ysk"
 * row when older notes are pending, then the collapsed hint. Expanded: the
 * newest note only (summary, blank, title, one row per detail line, blank,
 * expanded hint). Hidden callers passing [] get an empty array.
 *
 * @deprecatedSuperseded by sidebar/popup builders (T3 removes)
 */
export function widgetLines(notes: Note[], options: WidgetOptions = {}): WidgetLine[] {
  const list = Array.isArray(notes) ? notes : [];
  if (list.length === 0) return [];

  const newest = list[list.length - 1]!;
  const rows =
    options.expanded === true
      ? expandedRows(newest, options.width)
      : collapsedRows(newest, list.length - 1, options.width);
  return rows.map((row) => ({ severity: row.severity, text: truncateLine(row.text, options.width) }));
}

/** Collapsed band rows: newest-note summary, optional "+N more", hint. */
function collapsedRows(note: Note, olderCount: number, width: number | undefined): WidgetLine[] {
  const rows = summaryRows(note, COLLAPSED_PREFIX, width);
  if (olderCount > 0) rows.push({ severity: "muted", text: `+${olderCount} more · /ysk` });
  rows.push({ severity: "info", text: COLLAPSED_HINT });
  return rows;
}

/** Expanded rows for a single note: summary, blank, title, detail, blank, hint. */
function expandedRows(note: Note, width: number | undefined): WidgetLine[] {
  const rows = summaryRows(note, EXPANDED_PREFIX, width);
  rows.push({ severity: "info", text: "" });
  rows.push({ severity: note.severity, text: displayTitle(note) });
  const detail = typeof note.detail === "string" ? note.detail.trim() : "";
  if (detail.length > 0) {
    for (const line of detail.split("\n")) rows.push({ severity: "info", text: line.trim() });
  }
  rows.push({ severity: "info", text: "" });
  rows.push({ severity: "info", text: EXPANDED_HINT });
  return rows;
}

/** Summary headline rows, colored with the note's own severity. */
function summaryRows(note: Note, prefix: string, width: number | undefined): WidgetLine[] {
  return wrapSummary(displayTitle(note), prefix, width).map((text) => ({
    severity: note.severity,
    text,
  }));
}

/**
 * Render the widget to plain strings (no theme colors). Pair with
 * widgetLines + severityColorToken when the caller wants themed output.
 */
export function renderWidget(notes: Note[], options: WidgetOptions = {}): string[] {
  return widgetLines(notes, options).map((row) => row.text);
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

/**
 * Wrap a summary headline into at most two rows at the given width: the
 * prefix occupies the first row, words break only on spaces (never mid-word),
 * and a remainder that cannot fit is cut with an ellipsis. Without a usable
 * width the summary stays a single row (the caller skips truncation too).
 */
function wrapSummary(summary: string, prefix: string, width: number | undefined): string[] {
  if (!isUsableWidth(width)) return [`${prefix}${summary}`];
  const bound = Math.floor(width);
  const words = summary.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [prefix.trimEnd()];

  const firstEnd = fillWords(words, 0, Math.max(1, bound - prefix.length));
  const rows = [prefix + words.slice(0, firstEnd).join(" ")];
  if (firstEnd < words.length) {
    const secondEnd = fillWords(words, firstEnd, bound);
    const rest = words.slice(firstEnd, secondEnd).join(" ");
    const overflow = words.slice(secondEnd).join(" ");
    rows.push(overflow.length > 0 ? truncateLine(`${rest} ${overflow}`, bound) : rest);
  }
  return rows;
}

/**
 * Greedily consume words from `start` while they fit into `budget`. The
 * first word is always placed (a too-long word is truncated by the final
 * width pass instead of vanishing).
 */
function fillWords(words: string[], start: number, budget: number): number {
  let used = 0;
  let index = start;
  while (index < words.length) {
    const next = index === start ? words[index]!.length : used + 1 + words[index]!.length;
    if (index !== start && next > budget) break;
    used = next;
    index += 1;
  }
  return index;
}

/** Title to display: the note title, falling back to its topic when blank. */
function displayTitle(note: Note): string {
  const title = typeof note.title === "string" ? note.title.trim() : "";
  return title.length > 0 ? title : note.topic;
}

// ---------------------------------------------------------------------------
// Sidebar + popup view models (ysk-sidebar). Pure like the band builders: no
// terminal or theme imports; rows carry the same Severity | "muted" tokens,
// and every row passes through truncateLine at the caller's width. The
// row-hit helpers parse the produced row text so row text stays the single
// source of truth for what is interactive.
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
 * own click target. Digits derive from KEY_ACTIONS so the key map stays
 * authoritative; popupActionAtRow parses these rows. Shared row objects are
 * safe: truncateAll always emits fresh copies.
 */
const POPUP_HINT_ROWS: readonly WidgetLine[] = [
  { severity: "muted", text: `${KEY_ACTIONS.expanded.understood}: Understood` },
  { severity: "muted", text: `${KEY_ACTIONS.expanded.chat}: Chat in main session` },
  { severity: "muted", text: `${KEY_ACTIONS.expanded.dismiss}: Dismiss` },
];

/** Map a detail hint label's leading word to its popup action name. */
const POPUP_ACTION_BY_LABEL: Record<string, Exclude<PopupAction, null>> = {
  understood: "understood",
  chat: "chat",
  dismiss: "dismiss",
};

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
 * digits derive from the expanded band's KEY_ACTIONS labels so the key map
 * stays the single source of truth.
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
 * sits at that index, by parsing the row's "<key>: <label>" prefix, so the
 * hint text stays the single source of truth for the key -> action mapping
 * (1 -> understood, 2 -> chat, 0 -> dismiss). The header, blank rows,
 * detail rows, and anything out of range select no action (null). The hint
 * is the three-row block popupDetailRows emits: one independently
 * actionable row per action.
 */
export function popupActionAtRow(rows: WidgetLine[], y: number): PopupAction {
  const row = rowAt(rows, y);
  const entry = row ? /^(\d+):\s+(.+)$/.exec(row.text) : null;
  if (!entry) return null;
  const label = entry[2]!.trim().split(/\s+/)[0]!.toLowerCase();
  return POPUP_ACTION_BY_LABEL[label] ?? null;
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
