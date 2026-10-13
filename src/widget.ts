/**
 * Pure widget line-building for the you-should-know HUD.
 *
 * This module knows nothing about the terminal: `renderWidget` returns plain
 * strings and `widgetLines` returns structural rows that the TUI-facing
 * caller (index.ts) colors with theme tokens via `theme.fg()`. The severity
 * -> theme-token mapping is exported so the widget and its callers share one
 * source of truth (info=accent, warning=warning, critical=error).
 *
 * Width handling: pi's TUI measures display columns with visibleWidth()/
 * truncateToWidth() from @earendil-works/pi-tui, but pi-tui is a transitive
 * (undeclared) dependency of this package, so we deliberately implement
 * conservative CHARACTER-count truncation here instead of importing it.
 * Every produced line is at most `width` characters; glyph widths wider than
 * one cell could still overflow, which is acceptable for the plain-ASCII
 * note text the reviewer prompt contract produces.
 */

import { PENDING_CAP, type Note, type Severity } from "./notes.ts";

/** Theme token used per severity; applied by the caller via theme.fg(). */
export type SeverityToken = "accent" | "warning" | "error";

/** Pure severity -> theme-token mapping (caller-side theming hook). */
export function severityColorToken(severity: Severity): SeverityToken {
  if (severity === "warning") return "warning";
  if (severity === "critical") return "error";
  return "accent";
}

/** Pure severity -> display label used inside widget lines. */
export function severityLabel(severity: Severity): string {
  if (severity === "warning") return "warning";
  if (severity === "critical") return "critical";
  return "info";
}

/** Options for widget rendering. */
export interface WidgetOptions {
  /** Truncate every line to this many characters. No truncation when absent. */
  width?: number;
  /** How many notes to show before the "+N more" line. Defaults to PENDING_CAP. */
  maxNotes?: number;
}

/** One widget row: its text plus the severity that should color it. */
export interface WidgetLine {
  severity: Severity;
  text: string;
}

/** Fixed action hint shown under the pending notes. */
export const ACTION_HINT = "Actions: /ysk learn · known · chat · dismiss";

/**
 * Build the structural widget rows: one per shown note, then a "+N more"
 * line when notes were hidden by the cap, then the action hint. The hint
 * and the "more" row appear only when notes exist; hidden callers passing
 * [] get an empty array.
 */
export function widgetLines(notes: Note[], options: WidgetOptions = {}): WidgetLine[] {
  const list = Array.isArray(notes) ? notes : [];
  if (list.length === 0) return [];

  const maxNotes = resolveMaxNotes(options.maxNotes);
  const rows: WidgetLine[] = [];
  for (const item of list.slice(0, maxNotes)) {
    rows.push({ severity: item.severity, text: `[${severityLabel(item.severity)}] ${displayTitle(item)}` });
  }
  const hidden = list.length - rows.length;
  if (hidden > 0) rows.push({ severity: "info", text: `+${hidden} more` });
  rows.push({ severity: "info", text: ACTION_HINT });
  return rows.map((row) => ({ severity: row.severity, text: truncateLine(row.text, options.width) }));
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
  if (typeof width !== "number" || !Number.isFinite(width) || width < 1) return text;
  const bound = Math.floor(width);
  if (text.length <= bound) return text;
  return bound === 1 ? text.slice(0, 1) : `${text.slice(0, bound - 1)}…`;
}

/** Title to display: the note title, falling back to its topic when blank. */
function displayTitle(note: Note): string {
  const title = typeof note.title === "string" ? note.title.trim() : "";
  return title.length > 0 ? title : note.topic;
}

function resolveMaxNotes(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return PENDING_CAP;
  return Math.floor(value);
}
