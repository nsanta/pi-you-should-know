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
 * Width handling: pi's TUI measures display columns with visibleWidth()/
 * truncateToWidth() from @earendil-works/pi-tui. pi-tui is a declared
 * dependency of this package, but it is used only for input key matching in
 * index.ts, not width measurement, so we deliberately implement conservative
 * CHARACTER-count truncation here instead of importing its measuring helpers:
 * every produced line is at most `width` characters; glyph widths wider than
 * one cell could still overflow, which is acceptable for the plain-ASCII
 * note text the reviewer prompt contract produces.
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

/** Action key labels per widget state; single source of truth for index.ts. */
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
  /** Render the expanded single-note view instead of the collapsed band. Defaults to false. */
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
