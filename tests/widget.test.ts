import { describe, expect, it } from "vitest";
import {
  KEY_ACTIONS,
  noteIndexAtPopupRow,
  popupActionAtRow,
  popupDetailRows,
  popupListRows,
  renderWidget,
  severityAtSidebarRow,
  severityColorToken,
  severityLabel,
  sidebarRows,
  tallyBySeverity,
  widgetLines,
} from "../src/widget.ts";
import type { Note } from "../src/notes.ts";

function note(overrides: Partial<Note> = {}): Note {
  return { topic: "topic", severity: "info", title: "A title", detail: "Some detail", ...overrides };
}

const COLLAPSED_HINT = "1: Learn more  2: Knew this already  0: Dismiss";
const EXPANDED_HINT = "1: Understood  2: Chat in main session  0: Dismiss";

describe("severity mappings", () => {
  it("maps severity -> theme token (info=accent, warning=warning, critical=error)", () => {
    expect(severityColorToken("info")).toBe("accent");
    expect(severityColorToken("warning")).toBe("warning");
    expect(severityColorToken("critical")).toBe("error");
  });

  it("maps the muted pseudo-severity -> muted token", () => {
    expect(severityColorToken("muted")).toBe("muted");
  });

  it("maps severity -> display label", () => {
    expect(severityLabel("info")).toBe("info");
    expect(severityLabel("warning")).toBe("warning");
    expect(severityLabel("critical")).toBe("critical");
  });
});

describe("KEY_ACTIONS", () => {
  it("is the single source of truth for the collapsed and expanded key labels", () => {
    expect(KEY_ACTIONS).toEqual({
      collapsed: { learn: "1", known: "2", dismiss: "0" },
      expanded: { understood: "1", chat: "2", dismiss: "0" },
    });
  });
});

describe("collapsed widget (default)", () => {
  it("returns an empty array when there are no notes", () => {
    expect(widgetLines([])).toEqual([]);
    expect(renderWidget([])).toEqual([]);
  });

  it("shows the newest note summary with its severity, then the collapsed hint", () => {
    const rows = widgetLines([note({ severity: "warning", title: "Silent assumption" })]);
    expect(rows).toEqual([
      { severity: "warning", text: "✦ Heads up · Silent assumption" },
      { severity: "info", text: COLLAPSED_HINT },
    ]);
  });

  it("colors the summary row with the newest note's severity token", () => {
    const rows = widgetLines([note({ title: "Old" }), note({ severity: "critical", title: "New" })]);
    expect(rows[0]).toEqual({ severity: "critical", text: "✦ Heads up · New" });
    expect(severityColorToken(rows[0]!.severity)).toBe("error");
  });

  it("shows +N more · /ysk with a muted token when older notes are pending", () => {
    const rows = widgetLines([note({ title: "A" }), note({ title: "B" }), note({ title: "C" })]);
    expect(rows).toHaveLength(3); // summary + +N more + hint
    expect(rows[1]).toEqual({ severity: "muted", text: "+2 more · /ysk" });
  });

  it("omits the +N more row when only one note is pending", () => {
    const rows = widgetLines([note()]);
    expect(rows.some((row) => row.text.startsWith("+"))).toBe(false);
  });

  it("falls back to the topic when the title is blank", () => {
    const rows = widgetLines([note({ title: "   ", topic: "silent assumption" })]);
    expect(rows[0]!.text).toBe("✦ Heads up · silent assumption");
  });

  it("wraps a long summary to at most two rows without cutting mid-word", () => {
    const title = "deployment gate stays manual until the rollback script exists";
    const rows = widgetLines([note({ title })], { width: 40 });
    expect(rows).toHaveLength(3); // 2 summary rows + hint
    expect(rows[0]).toEqual({
      severity: "info",
      text: "✦ Heads up · deployment gate stays",
    });
    expect(rows[1]!.text).toBe("manual until the rollback script exists");
    expect(rows[2]!.text).toBe("1: Learn more  2: Knew this already  0:…"); // hint truncates at width
  });
});

describe("expanded widget", () => {
  it("shows summary, blank, title, per-line detail, blank, expanded hint", () => {
    const rows = widgetLines(
      [note({ severity: "warning", title: "Silent assumption", detail: "line one\nline two" })],
      { expanded: true },
    );
    expect(rows).toEqual([
      { severity: "warning", text: "Heads up · Silent assumption" },
      { severity: "info", text: "" },
      { severity: "warning", text: "Silent assumption" },
      { severity: "info", text: "line one" },
      { severity: "info", text: "line two" },
      { severity: "info", text: "" },
      { severity: "info", text: EXPANDED_HINT },
    ]);
  });

  it("renders only the newest note and ignores older pending notes entirely", () => {
    const rows = widgetLines(
      [note({ title: "Old note", detail: "old detail" }), note({ title: "New note", detail: "new detail" })],
      { expanded: true },
    );
    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("New note");
    expect(text).toContain("new detail");
    expect(text).not.toContain("Old note");
    expect(text).not.toContain("+1 more");
  });

  it("emits no detail rows when the detail is missing or blank", () => {
    const rows = widgetLines([note({ title: "T", detail: "   " })], { expanded: true });
    expect(rows.map((row) => row.text)).toEqual(["Heads up · T", "", "T", "", EXPANDED_HINT]);
  });

  it("falls back to the topic for summary and title when the title is blank", () => {
    const rows = widgetLines([note({ title: "  ", topic: "topic fallback" })], { expanded: true });
    expect(rows[0]!.text).toBe("Heads up · topic fallback");
    expect(rows[2]!.text).toBe("topic fallback");
  });
});

describe("widget width safety", () => {
  it("truncates every row to the requested width in both states", () => {
    const wide = note({ title: "x".repeat(300), detail: "y".repeat(300) });
    const width = 40;
    for (const options of [{ width }, { width, expanded: true }] as const) {
      const lines = renderWidget([wide], options);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(width);
    }
  });

  it("wraps to two rows and marks the overflow tail with an ellipsis", () => {
    const title = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor";
    const rows = widgetLines([note({ title })], { width: 30 });
    expect(rows).toHaveLength(3); // 2 summary rows + hint
    expect(rows[0]!.text).toBe("✦ Heads up · lorem ipsum dolor");
    expect(rows[1]!.text).toBe("sit amet consectetur adipisci…");
  });

  it("marks truncation instead of cutting silently", () => {
    const lines = renderWidget([note({ title: "y".repeat(100) })], { width: 20 });
    expect(lines[0]!.length).toBe(20);
    expect(lines[0]!.endsWith("…")).toBe(true);
  });

  it("leaves rows untouched when no width is given", () => {
    const title = "z".repeat(150);
    const rows = widgetLines([note({ title })]);
    expect(rows[0]).toEqual({ severity: "info", text: `✦ Heads up · ${title}` });
  });

  it("ignores invalid widths", () => {
    const rows = widgetLines([note({ title: "w".repeat(50) })], { width: 0 });
    expect(rows[0]!.text.length).toBeGreaterThan(10);
  });
});

describe("tallyBySeverity", () => {
  it("returns zeros for empty or invalid input", () => {
    expect(tallyBySeverity([])).toEqual({ critical: 0, warning: 0, info: 0 });
    expect(tallyBySeverity(undefined as unknown as Note[])).toEqual({ critical: 0, warning: 0, info: 0 });
    expect(tallyBySeverity("notes" as unknown as Note[])).toEqual({ critical: 0, warning: 0, info: 0 });
  });

  it("counts pending notes per severity", () => {
    const notes = [note({ severity: "critical" }), note(), note({ severity: "warning" }), note()];
    expect(tallyBySeverity(notes)).toEqual({ critical: 1, warning: 1, info: 2 });
  });
});

describe("sidebarRows", () => {
  it("returns [] when there are no notes", () => {
    expect(sidebarRows([])).toEqual([]);
  });

  it("uses the singular head-up label when exactly one note is pending", () => {
    expect(sidebarRows([note()])).toEqual([
      { severity: "info", text: "✦ 1 head-up" },
      { severity: "info", text: "■ 1 info" },
    ]);
  });

  it("shows the total header and one row per non-zero severity in priority order", () => {
    const notes = [
      note({ title: "A" }),
      note({ severity: "critical", title: "B" }),
      note({ severity: "warning", title: "C" }),
      note({ severity: "warning", title: "D" }),
      note({ severity: "critical", title: "E" }),
    ];
    expect(sidebarRows(notes)).toEqual([
      { severity: "info", text: "✦ 5 heads-up" },
      { severity: "critical", text: "■ 2 critical" },
      { severity: "warning", text: "■ 2 warning" },
      { severity: "info", text: "■ 1 info" },
    ]);
  });

  it("omits severities with a zero count", () => {
    expect(sidebarRows([note({ severity: "warning" })])).toEqual([
      { severity: "info", text: "✦ 1 head-up" },
      { severity: "warning", text: "■ 1 warning" },
    ]);
  });

  it("colors the header with the accent token and rows with their severity tokens", () => {
    const rows = sidebarRows([note({ severity: "critical" }), note({ severity: "warning" })]);
    expect(severityColorToken(rows[0]!.severity)).toBe("accent");
    expect(severityColorToken(rows[1]!.severity)).toBe("error");
    expect(severityColorToken(rows[2]!.severity)).toBe("warning");
  });

  it("truncates rows at the requested width and ignores invalid widths", () => {
    const truncated = sidebarRows([note({ severity: "critical" })], { width: 8 });
    expect(truncated.map((row) => row.text)).toEqual(["✦ 1 hea…", "■ 1 cri…"]);
    for (const row of truncated) expect(row.text.length).toBeLessThanOrEqual(8);

    const untouched = sidebarRows([note({ title: "w".repeat(60) })], { width: 0 });
    expect(untouched[0]!.text).toBe("✦ 1 head-up");
  });
});

describe("severityAtSidebarRow", () => {
  const rows = sidebarRows([note({ severity: "critical" }), note({ severity: "warning" }), note()]);

  it("maps the header row to all and severity rows to their severity", () => {
    expect(severityAtSidebarRow(rows, 0)).toBe("all");
    expect(severityAtSidebarRow(rows, 1)).toBe("critical");
    expect(severityAtSidebarRow(rows, 2)).toBe("warning");
    expect(severityAtSidebarRow(rows, 3)).toBe("info");
  });

  it("returns null for out-of-range rows and empty input", () => {
    expect(severityAtSidebarRow(rows, -1)).toBeNull();
    expect(severityAtSidebarRow(rows, 4)).toBeNull();
    expect(severityAtSidebarRow([], 0)).toBeNull();
  });
});

describe("popupListRows", () => {
  it("builds a muted header, 1-based numbered rows, and a muted hint", () => {
    const rows = popupListRows([note({ title: "First" }), note({ severity: "critical", title: "Second" })]);
    expect(rows).toEqual([
      { severity: "muted", text: "Heads up" },
      { severity: "info", text: "1. [info] First" },
      { severity: "critical", text: "2. [critical] Second" },
      { severity: "muted", text: "number to open · Esc to close" },
    ]);
  });

  it("returns [] when there are no notes", () => {
    expect(popupListRows([])).toEqual([]);
  });

  it("falls back to the topic when the title is blank", () => {
    const rows = popupListRows([note({ title: "   ", topic: "silent assumption" })]);
    expect(rows[1]!.text).toBe("1. [info] silent assumption");
  });

  it("truncates rows at the requested width", () => {
    const rows = popupListRows([note({ title: "x".repeat(60) })], { width: 14 });
    for (const row of rows) expect(row.text.length).toBeLessThanOrEqual(14);
    expect(rows[1]!.text).toBe("1. [info] xxx…");
  });
});

describe("noteIndexAtPopupRow", () => {
  const rows = popupListRows([note(), note({ title: "B" })]);

  it("maps numbered rows to their 1-based note index", () => {
    expect(noteIndexAtPopupRow(rows, 1)).toBe(1);
    expect(noteIndexAtPopupRow(rows, 2)).toBe(2);
  });

  it("returns null for the header, the hint, and out-of-range rows", () => {
    expect(noteIndexAtPopupRow(rows, 0)).toBeNull();
    expect(noteIndexAtPopupRow(rows, 3)).toBeNull();
    expect(noteIndexAtPopupRow(rows, -1)).toBeNull();
    expect(noteIndexAtPopupRow(rows, 99)).toBeNull();
    expect(noteIndexAtPopupRow([], 0)).toBeNull();
  });
});

describe("popupDetailRows", () => {
  it("shows the severity header, blank, detail lines, blank, and the muted hint block", () => {
    const rows = popupDetailRows(
      note({ severity: "warning", title: "Silent assumption", detail: "line one\nline two" }),
    );
    expect(rows).toEqual([
      { severity: "warning", text: "Heads up · Silent assumption" },
      { severity: "info", text: "" },
      { severity: "info", text: "line one" },
      { severity: "info", text: "line two" },
      { severity: "info", text: "" },
      { severity: "muted", text: "1: Understood" },
      { severity: "muted", text: "2: Chat in main session" },
      { severity: "muted", text: "0: Dismiss" },
    ]);
  });

  it("omits detail rows when the detail is blank but keeps the surrounding blanks and hint block", () => {
    const rows = popupDetailRows(note({ detail: "   " }));
    expect(rows).toEqual([
      { severity: "info", text: "Heads up · A title" },
      { severity: "info", text: "" },
      { severity: "info", text: "" },
      { severity: "muted", text: "1: Understood" },
      { severity: "muted", text: "2: Chat in main session" },
      { severity: "muted", text: "0: Dismiss" },
    ]);
  });

  it("falls back to the topic when the title is blank", () => {
    expect(popupDetailRows(note({ title: "  ", topic: "t" }))[0]!.text).toBe("Heads up · t");
  });

  it("truncates every row at the requested width", () => {
    const rows = popupDetailRows(note({ detail: "d".repeat(60) }), { width: 16 });
    for (const row of rows) expect(row.text.length).toBeLessThanOrEqual(16);
  });
});

describe("popupActionAtRow", () => {
  const rows = popupDetailRows(note()); // header, blank, detail, blank, 3 hint rows

  it("maps each hint row's index to the action it names", () => {
    const hintAt = (text: string) => rows.findIndex((row) => row.text === text);
    expect(popupActionAtRow(rows, hintAt("1: Understood"))).toBe("understood");
    expect(popupActionAtRow(rows, hintAt("2: Chat in main session"))).toBe("chat");
    expect(popupActionAtRow(rows, hintAt("0: Dismiss"))).toBe("dismiss");
  });

  it("returns null for header, blank, and detail rows, and out-of-range indices", () => {
    expect(popupActionAtRow(rows, 0)).toBeNull(); // header
    expect(popupActionAtRow(rows, 1)).toBeNull(); // blank
    expect(popupActionAtRow(rows, 2)).toBeNull(); // detail line
    expect(popupActionAtRow(rows, 3)).toBeNull(); // blank before the hint block
    expect(popupActionAtRow(rows, -1)).toBeNull();
    expect(popupActionAtRow(rows, rows.length)).toBeNull();
    expect(popupActionAtRow(rows, 1.5)).toBeNull();
    expect(popupActionAtRow([], 0)).toBeNull();
  });
});
