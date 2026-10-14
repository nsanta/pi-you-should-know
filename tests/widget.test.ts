import { describe, expect, it } from "vitest";
import {
  POPUP_ACTIONS,
  noteIndexAtPopupRow,
  popupActionAtRow,
  popupDetailRows,
  popupListRows,
  severityAtSidebarCardRow,
  severityColorToken,
  severityLabel,
  sidebarCardRows,
  tallyBySeverity,
  truncateLine,
} from "../src/widget.ts";
import type { Note } from "../src/notes.ts";

function note(overrides: Partial<Note> = {}): Note {
  return { topic: "topic", severity: "info", title: "A title", detail: "Some detail", ...overrides };
}

describe("severity mappings", () => {
  it("maps severity -> theme token (info=accent, warning=warning, critical=error)", () => {
    expect(severityColorToken("info")).toBe("accent");
    expect(severityColorToken("warning")).toBe("warning");
    expect(severityColorToken("critical")).toBe("error");
  });

  it("maps the muted pseudo-severity -> muted token", () => {
    expect(severityColorToken("muted")).toBe("muted");
  });

  it("maps the border frame token -> itself", () => {
    expect(severityColorToken("border")).toBe("border");
  });

  it("maps severity -> display label", () => {
    expect(severityLabel("info")).toBe("info");
    expect(severityLabel("warning")).toBe("warning");
    expect(severityLabel("critical")).toBe("critical");
  });
});

describe("truncateLine", () => {
  it("marks truncation instead of cutting silently", () => {
    const line = truncateLine("y".repeat(100), 20);
    expect(line.length).toBe(20);
    expect(line.endsWith("…")).toBe(true);
  });

  it("leaves rows untouched when no width is given", () => {
    const title = "z".repeat(150);
    expect(truncateLine(title, undefined)).toBe(title);
  });

  it("ignores invalid widths", () => {
    const title = "w".repeat(50);
    expect(truncateLine(title, 0)).toBe(title);
    expect(truncateLine(title, Number.NaN)).toBe(title);
  });

  it("keeps a single character when width is 1", () => {
    expect(truncateLine("abc", 1)).toBe("a");
  });
});

describe("POPUP_ACTIONS", () => {
  it("is the single source of truth for the detail-stage keys and labels", () => {
    expect(POPUP_ACTIONS).toEqual([
      { key: "1", action: "understood", label: "Understood" },
      { key: "2", action: "chat", label: "Chat in main session" },
      { key: "0", action: "dismiss", label: "Dismiss" },
    ]);
  });

  it("drives the popupDetailRows hint block (one row per action)", () => {
    const rows = popupDetailRows(note({ detail: "   " }));
    const tail = rows.slice(-POPUP_ACTIONS.length).map((row) => row.text);
    expect(tail).toEqual(POPUP_ACTIONS.map((entry) => `${entry.key}: ${entry.label}`));
    expect(rows.slice(0, rows.length - POPUP_ACTIONS.length)).toEqual([
      { severity: "info", text: "Heads up · A title" },
      { severity: "info", text: "" },
      { severity: "info", text: "" },
    ]);
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

describe("sidebarCardRows", () => {
  it("returns [] when there are no notes or the notes input is unusable", () => {
    expect(sidebarCardRows([], { width: 26 })).toEqual([]);
    expect(sidebarCardRows(undefined as unknown as Note[], { width: 26 })).toEqual([]);
    expect(sidebarCardRows("notes" as unknown as Note[], { width: 26 })).toEqual([]);
  });

  it("frames a single pending note: singular title rule, body row, bottom rule (width 26)", () => {
    expect(sidebarCardRows([note()], { width: 26 })).toEqual([
      {
        segments: [
          { token: "border", text: "╭─ " },
          { token: "info", text: "✦ 1 head-up" },
          { token: "border", text: ` ${"─".repeat(10)}╮` }, // fill = 26 - 11 - 5
        ],
      },
      {
        segments: [
          { token: "border", text: "│ " },
          { token: "info", text: "■ 1 info" },
          { token: "border", text: `${" ".repeat(14)} │` }, // pad to exactly 26 columns
        ],
      },
      { segments: [{ token: "border", text: `╰${"─".repeat(24)}╯` }] },
    ]);
  });

  it("shows the total title and one body row per non-zero severity in priority order", () => {
    const notes = [
      note({ title: "A" }),
      note({ severity: "critical", title: "B" }),
      note({ severity: "warning", title: "C" }),
      note({ severity: "warning", title: "D" }),
      note({ severity: "critical", title: "E" }),
    ];
    expect(sidebarCardRows(notes, { width: 26 })).toEqual([
      {
        segments: [
          { token: "border", text: "╭─ " },
          { token: "info", text: "✦ 5 heads-up" },
          { token: "border", text: ` ${"─".repeat(9)}╮` }, // fill = 26 - 12 - 5
        ],
      },
      {
        segments: [
          { token: "border", text: "│ " },
          { token: "critical", text: "■ 2 critical" },
          { token: "border", text: `${" ".repeat(10)} │` },
        ],
      },
      {
        segments: [
          { token: "border", text: "│ " },
          { token: "warning", text: "■ 2 warning" },
          { token: "border", text: `${" ".repeat(11)} │` },
        ],
      },
      {
        segments: [
          { token: "border", text: "│ " },
          { token: "info", text: "■ 1 info" },
          { token: "border", text: `${" ".repeat(14)} │` },
        ],
      },
      { segments: [{ token: "border", text: `╰${"─".repeat(24)}╯` }] },
    ]);
  });

  it("omits severities with a zero count", () => {
    expect(sidebarCardRows([note({ severity: "warning" })], { width: 26 })).toEqual([
      {
        segments: [
          { token: "border", text: "╭─ " },
          { token: "info", text: "✦ 1 head-up" },
          { token: "border", text: ` ${"─".repeat(10)}╮` },
        ],
      },
      {
        segments: [
          { token: "border", text: "│ " },
          { token: "warning", text: "■ 1 warning" },
          { token: "border", text: `${" ".repeat(11)} │` },
        ],
      },
      { segments: [{ token: "border", text: `╰${"─".repeat(24)}╯` }] },
    ]);
  });

  it("truncates an over-long title and body at small widths, never exceeding the width", () => {
    const notes = [
      note(),
      note({ severity: "critical" }),
      note({ severity: "warning" }),
      note({ severity: "warning" }),
      note({ severity: "critical" }),
    ];
    const rows = sidebarCardRows(notes, { width: 10 });
    expect(rows).toEqual([
      {
        segments: [
          { token: "border", text: "╭─ " },
          { token: "info", text: "✦ 5 …" }, // title truncated to width - 5 chars
          { token: "border", text: " ╮" }, // fill clamps to 0
        ],
      },
      {
        segments: [
          { token: "border", text: "│ " },
          { token: "critical", text: "■ 2 c…" }, // body truncated to width - 4 chars
          { token: "border", text: " │" },
        ],
      },
      {
        segments: [
          { token: "border", text: "│ " },
          { token: "warning", text: "■ 2 w…" },
          { token: "border", text: " │" },
        ],
      },
      {
        segments: [
          { token: "border", text: "│ " },
          { token: "info", text: "■ 1 i…" },
          { token: "border", text: " │" },
        ],
      },
      { segments: [{ token: "border", text: `╰${"─".repeat(8)}╯` }] },
    ]);
    for (const row of rows) {
      const columns = row.segments.reduce((total, segment) => total + segment.text.length, 0);
      expect(columns).toBeLessThanOrEqual(10);
    }
  });

  it("degrades to bare clamped rules below width 5 and floors non-integer widths", () => {
    expect(sidebarCardRows([note()], { width: 4 })).toEqual([
      { segments: [{ token: "border", text: "╭──╮" }] },
      { segments: [{ token: "border", text: "╰──╯" }] },
    ]);
    expect(sidebarCardRows([note()], { width: 1 })).toEqual([
      { segments: [{ token: "border", text: "╭" }] },
      { segments: [{ token: "border", text: "╰" }] },
    ]);
    // Non-finite and float widths clamp/floor before the frame math runs.
    expect(sidebarCardRows([note()], { width: Number.NaN })).toEqual(sidebarCardRows([note()], { width: 0 }));
    const floated = sidebarCardRows([note()], { width: 26.9 });
    for (const row of floated) {
      const columns = row.segments.reduce((total, segment) => total + segment.text.length, 0);
      expect(columns).toBe(26);
    }
  });
});

describe("severityAtSidebarCardRow", () => {
  const rows = sidebarCardRows(
    [note({ severity: "critical" }), note({ severity: "warning" }), note()],
    { width: 26 },
  ); // title, critical, warning, info, bottom rule

  it("maps the title row to all and body rows to their middle segment's severity", () => {
    expect(severityAtSidebarCardRow(rows, 0)).toBe("all");
    expect(severityAtSidebarCardRow(rows, 1)).toBe("critical");
    expect(severityAtSidebarCardRow(rows, 2)).toBe("warning");
    expect(severityAtSidebarCardRow(rows, 3)).toBe("info");
  });

  it("returns null for the bottom rule, non-integer and out-of-range rows, and empty input", () => {
    expect(severityAtSidebarCardRow(rows, 4)).toBeNull();
    expect(severityAtSidebarCardRow(rows, -1)).toBeNull();
    expect(severityAtSidebarCardRow(rows, 5)).toBeNull();
    expect(severityAtSidebarCardRow(rows, 1.5)).toBeNull();
    expect(severityAtSidebarCardRow([], 0)).toBeNull();
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

  it("maps each trailing hint row to the action it names", () => {
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

  it("never treats a detail line as an action, even one starting '<digit>: '", () => {
    const tricky = popupDetailRows(note({ detail: "2: Chat looks like a hint line" }));
    const detailAt = tricky.findIndex((row) => row.text === "2: Chat looks like a hint line");
    expect(detailAt).toBeGreaterThan(0);
    expect(detailAt).toBeLessThan(tricky.length - POPUP_ACTIONS.length); // outside the trailing block
    expect(popupActionAtRow(tricky, detailAt)).toBeNull();
  });
});
