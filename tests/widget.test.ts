import { describe, expect, it } from "vitest";
import {
  POPUP_ACTIONS,
  type CardRow,
  frameCardRows,
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
  wrapLine,
} from "../src/widget.ts";
import type { Note } from "../src/notes.ts";

function note(overrides: Partial<Note> = {}): Note {
  return { topic: "topic", severity: "info", title: "A title", detail: "Some detail", ...overrides };
}

/** Full row text: every segment joined (frame runs included). */
function rowText(row: CardRow): string {
  return row.segments.map((segment) => segment.text).join("");
}

/** Body text of a framed card row: the middle segments joined (frame runs dropped). */
function rowBody(row: CardRow): string {
  return row.segments.slice(1, -1).map((segment) => segment.text).join("");
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

  it("drives the popupDetailRows hint block (one muted row per action, just above the bottom rule)", () => {
    const rows = popupDetailRows(note({ detail: "   " }), { width: 40 });
    const tail = rows.slice(-POPUP_ACTIONS.length - 1); // 3 hint rows + bottom rule
    expect(tail.map(rowBody)).toEqual([...POPUP_ACTIONS.map((entry) => `${entry.key}: ${entry.label}`), ""]);
    for (const hintRow of tail.slice(0, -1)) {
      expect(hintRow.segments[1]).toMatchObject({ token: "muted" });
    }
    expect(rowText(tail.at(-1)!)).toBe(`╰${"─".repeat(38)}╯`); // the bottom rule closes the card
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

describe("frameCardRows", () => {
  it("frames a title and body rows at exactly the requested width (26)", () => {
    expect(
      frameCardRows(
        [
          { severity: "critical", text: "■ 2 critical" },
          { severity: "muted", text: "hint" },
        ],
        "✦ 2 heads-up",
        { width: 26 },
      ),
    ).toEqual([
      {
        segments: [
          { token: "border", text: "╭─ " },
          { token: "info", text: "✦ 2 heads-up" },
          { token: "border", text: ` ${"─".repeat(9)}╮` }, // fill = 26 - 12 - 5
        ],
      },
      {
        segments: [
          { token: "border", text: "│ " },
          { token: "critical", text: "■ 2 critical" },
          { token: "border", text: `${" ".repeat(10)} │` }, // pad = 26 - 4 - 12
        ],
      },
      {
        segments: [
          { token: "border", text: "│ " },
          { token: "muted", text: "hint" },
          { token: "border", text: `${" ".repeat(18)} │` }, // pad = 26 - 4 - 4
        ],
      },
      { segments: [{ token: "border", text: `╰${"─".repeat(24)}╯` }] },
    ]);
  });

  it("keeps each body row's own token and truncates over-long text to the inner width", () => {
    const rows = frameCardRows([{ severity: "warning", text: "w".repeat(30) }], "t".repeat(40), { width: 20 });
    expect(rows[0]!.segments[1]).toEqual({ token: "info", text: `${"t".repeat(14)}…` }); // title bound: 20 - 5
    expect(rows[1]!.segments[1]).toEqual({ token: "warning", text: `${"w".repeat(15)}…` }); // body bound: 20 - 4
    for (const row of rows) expect(rowText(row)).toHaveLength(20);
  });

  it("degrades to bare clamped rules below width 5 (the sidebar's narrow branches)", () => {
    expect(frameCardRows([{ severity: "info", text: "body" }], "title", { width: 4 })).toEqual([
      { segments: [{ token: "border", text: "╭──╮" }] },
      { segments: [{ token: "border", text: "╰──╯" }] },
    ]);
    expect(frameCardRows([], "title", { width: 1 })).toEqual([
      { segments: [{ token: "border", text: "╭" }] },
      { segments: [{ token: "border", text: "╰" }] },
    ]);
    // Non-finite widths clamp to 0 before the degenerate branch runs.
    expect(frameCardRows([], "title", { width: Number.NaN })).toEqual(frameCardRows([], "title", { width: 0 }));
  });

  it("is byte-identical to sidebarCardRows output when given the sidebar's rows and title", () => {
    const notes = [note({ severity: "critical" }), note(), note({ severity: "warning" })];
    expect(sidebarCardRows(notes, { width: 26 })).toEqual(
      frameCardRows(
        [
          { severity: "critical", text: "■ 1 critical" },
          { severity: "warning", text: "■ 1 warning" },
          { severity: "info", text: "■ 1 info" },
        ],
        "✦ 3 heads-up",
        { width: 26 },
      ),
    );
  });
});

describe("wrapLine", () => {
  it("keeps short text on a single row", () => {
    expect(wrapLine("already short", 40)).toEqual(["already short"]);
  });

  it("packs as many whole words per row as the width allows", () => {
    expect(wrapLine("aaa bb cc", 7)).toEqual(["aaa bb", "cc"]); // "aaa bb cc" is 9 chars
  });

  it("hard-breaks a single word longer than the width: nothing lost, no ellipsis", () => {
    const rows = wrapLine("x".repeat(60), 20);
    expect(rows).toEqual(["x".repeat(20), "x".repeat(20), "x".repeat(20)]); // exactly 3 rows
    expect(rows.join("")).toBe("x".repeat(60)); // concatenation recovers the full text
    expect(rows.join("")).not.toContain("…");
  });

  it("hard-breaks an over-long word mid-text and continues with the next word", () => {
    expect(wrapLine("aaaa b", 3)).toEqual(["aaa", "a b"]);
  });

  it('returns [""] for empty text', () => {
    expect(wrapLine("", 20)).toEqual([""]);
  });

  it("degenerates to 1-char rows below width 2 (including invalid widths)", () => {
    expect(wrapLine("abc", 1)).toEqual(["a", "b", "c"]);
    expect(wrapLine("abc", 0)).toEqual(["a", "b", "c"]);
    expect(wrapLine("ab", Number.NaN)).toEqual(["a", "b"]);
  });

  it("collapses space runs and trims the ends", () => {
    expect(wrapLine("  a  b  ", 10)).toEqual(["a b"]);
  });

  it("fits a word exactly as wide as the bound", () => {
    expect(wrapLine("abc", 3)).toEqual(["abc"]);
  });
});

describe("popupListRows", () => {
  it("frames the numbered note rows and the hint inside a full card (width 40)", () => {
    const rows = popupListRows(
      [note({ title: "First" }), note({ severity: "critical", title: "Second" })],
      { width: 40 },
    );
    expect(rows).toEqual([
      {
        segments: [
          { token: "border", text: "╭─ " },
          { token: "info", text: "✦ Heads up" },
          { token: "border", text: ` ${"─".repeat(25)}╮` }, // fill = 40 - 10 - 5
        ],
      },
      {
        segments: [
          { token: "border", text: "│ " },
          { token: "info", text: "1. [info] First" },
          { token: "border", text: `${" ".repeat(21)} │` }, // pad = 40 - 4 - 15
        ],
      },
      {
        segments: [
          { token: "border", text: "│ " },
          { token: "critical", text: "2. [critical] Second" },
          { token: "border", text: `${" ".repeat(16)} │` }, // pad = 40 - 4 - 20
        ],
      },
      {
        segments: [
          { token: "border", text: "│ " },
          { token: "muted", text: "number to open · Esc to close" },
          { token: "border", text: `${" ".repeat(7)} │` }, // pad = 40 - 4 - 29
        ],
      },
      { segments: [{ token: "border", text: `╰${"─".repeat(38)}╯` }] },
    ]);
    for (const row of rows) expect(rowText(row)).toHaveLength(40);
  });

  it("returns [] for empty or unusable notes, and for an unusable width", () => {
    expect(popupListRows([])).toEqual([]);
    expect(popupListRows(undefined as unknown as Note[], { width: 40 })).toEqual([]);
    expect(popupListRows("notes" as unknown as Note[], { width: 40 })).toEqual([]);
    expect(popupListRows([note()], { width: Number.NaN })).toEqual([]);
    expect(popupListRows([note()])).toEqual([]); // width is required in practice: none -> []
  });

  it("wraps long entries instead of truncating: continuation rows keep the severity, full text visible", () => {
    const rows = popupListRows(
      [note({ severity: "warning", title: "Silent assumption caught mid refactor" })],
      { width: 26 },
    );
    // "1. [warning] Silent assumption caught mid refactor" wraps at the 22-col inner width.
    expect(rows.map(rowBody)).toEqual([
      "✦ Heads up",
      "1. [warning] Silent",
      "assumption caught mid",
      "refactor",
      "number to open · Esc", // the hint wraps too: no ellipsis anywhere
      "to close",
      "",
    ]);
    expect(rows[2]!.segments[1]).toEqual({ token: "warning", text: "assumption caught mid" }); // same severity, no prefix
    expect(rows.map(rowText).join("\n")).not.toContain("…");
    for (const row of rows) expect(rowText(row)).toHaveLength(26);
  });

  it("falls back to the topic when the title is blank", () => {
    const rows = popupListRows([note({ title: "   ", topic: "silent assumption" })], { width: 40 });
    expect(rowBody(rows[1]!)).toBe("1. [info] silent assumption");
  });

  it("floors non-integer widths before framing", () => {
    const rows = popupListRows([note()], { width: 40.9 });
    for (const row of rows) expect(rowText(row)).toHaveLength(40);
  });
});

describe("noteIndexAtPopupRow", () => {
  const rows = popupListRows([note(), note({ title: "B" })], { width: 40 });
  // Framed layout: 0 top rule, 1 "1. ...", 2 "2. ...", 3 hint, 4 bottom rule.

  it("maps numbered body rows to their 1-based note index", () => {
    expect(noteIndexAtPopupRow(rows, 1)).toBe(1);
    expect(noteIndexAtPopupRow(rows, 2)).toBe(2);
  });

  it("returns null for the top rule, the hint, the bottom rule, and out-of-range rows", () => {
    expect(noteIndexAtPopupRow(rows, 0)).toBeNull();
    expect(noteIndexAtPopupRow(rows, 3)).toBeNull();
    expect(noteIndexAtPopupRow(rows, 4)).toBeNull();
    expect(noteIndexAtPopupRow(rows, -1)).toBeNull();
    expect(noteIndexAtPopupRow(rows, 99)).toBeNull();
    expect(noteIndexAtPopupRow(rows, 1.5)).toBeNull();
    expect(noteIndexAtPopupRow([], 0)).toBeNull();
  });

  it("returns null on wrapped continuation rows", () => {
    const wrapped = popupListRows(
      [note({ severity: "warning", title: "Silent assumption caught mid refactor" })],
      { width: 26 },
    );
    expect(noteIndexAtPopupRow(wrapped, 1)).toBe(1); // "1. [warning] Silent"
    expect(noteIndexAtPopupRow(wrapped, 2)).toBeNull(); // "assumption caught mid"
    expect(noteIndexAtPopupRow(wrapped, 3)).toBeNull(); // "refactor"
  });
});

describe("popupDetailRows", () => {
  it("frames the severity title, blank, detail lines, blank, and the muted hint block (width 40)", () => {
    const rows = popupDetailRows(
      note({ severity: "warning", title: "Silent assumption", detail: "line one\nline two" }),
      { width: 40 },
    );
    expect(rows).toEqual([
      {
        segments: [
          { token: "border", text: "╭─ " },
          { token: "info", text: "✦ Heads up" },
          { token: "border", text: ` ${"─".repeat(25)}╮` }, // fill = 40 - 10 - 5
        ],
      },
      {
        segments: [
          { token: "border", text: "│ " },
          { token: "warning", text: "Silent assumption" },
          { token: "border", text: `${" ".repeat(19)} │` }, // pad = 40 - 4 - 17
        ],
      },
      {
        segments: [
          { token: "border", text: "│ " },
          { token: "info", text: "" },
          { token: "border", text: `${" ".repeat(36)} │` }, // pad = 40 - 4 - 0
        ],
      },
      {
        segments: [
          { token: "border", text: "│ " },
          { token: "info", text: "line one" },
          { token: "border", text: `${" ".repeat(28)} │` }, // pad = 40 - 4 - 8
        ],
      },
      {
        segments: [
          { token: "border", text: "│ " },
          { token: "info", text: "line two" },
          { token: "border", text: `${" ".repeat(28)} │` },
        ],
      },
      {
        segments: [
          { token: "border", text: "│ " },
          { token: "info", text: "" },
          { token: "border", text: `${" ".repeat(36)} │` },
        ],
      },
      {
        segments: [
          { token: "border", text: "│ " },
          { token: "muted", text: "1: Understood" },
          { token: "border", text: `${" ".repeat(23)} │` }, // pad = 40 - 4 - 13
        ],
      },
      {
        segments: [
          { token: "border", text: "│ " },
          { token: "muted", text: "2: Chat in main session" },
          { token: "border", text: `${" ".repeat(13)} │` }, // pad = 40 - 4 - 23
        ],
      },
      {
        segments: [
          { token: "border", text: "│ " },
          { token: "muted", text: "0: Dismiss" },
          { token: "border", text: `${" ".repeat(26)} │` }, // pad = 40 - 4 - 10
        ],
      },
      { segments: [{ token: "border", text: `╰${"─".repeat(38)}╯` }] },
    ]);
    for (const row of rows) expect(rowText(row)).toHaveLength(40);
  });

  it("omits detail rows when the detail is blank but keeps the surrounding blanks and hint block", () => {
    const rows = popupDetailRows(note({ detail: "   " }), { width: 40 });
    expect(rows.map(rowBody)).toEqual([
      "✦ Heads up",
      "A title",
      "",
      "",
      "1: Understood",
      "2: Chat in main session",
      "0: Dismiss",
      "",
    ]);
  });

  it("falls back to the topic when the title is blank", () => {
    const rows = popupDetailRows(note({ title: "  ", topic: "t" }), { width: 40 });
    expect(rowBody(rows[1]!)).toBe("t");
  });

  it("returns [] for null/non-object notes or an unframeable width", () => {
    expect(popupDetailRows(null as unknown as Note, { width: 40 })).toEqual([]);
    expect(popupDetailRows("note" as unknown as Note, { width: 40 })).toEqual([]);
    expect(popupDetailRows(note(), { width: 4 })).toEqual([]);
  });

  it("keeps blank lines inside a multi-line detail (paragraph structure)", () => {
    const rows = popupDetailRows(note({ detail: "a\n\nb" }), { width: 40 });
    expect(rows.map(rowBody).slice(3, 6)).toEqual(["a", "", "b"]);
  });

  it("wraps long titles and details instead of truncating; the full brief stays visible", () => {
    const rows = popupDetailRows(
      note({
        severity: "critical",
        title: "Hidden decision shipped silently",
        detail: "The gate was skipped\nThe gate was skipped",
      }),
      { width: 26 },
    );
    expect(rows.map(rowBody)).toEqual([
      "✦ Heads up",
      "Hidden decision", // the severity title wraps at the 22-col inner width...
      "shipped silently", // ...and the continuation keeps the severity token
      "",
      "The gate was skipped",
      "The gate was skipped",
      "",
      "1: Understood",
      "2: Chat in main", // even a long hint row wraps rather than truncating
      "session",
      "0: Dismiss",
      "",
    ]);
    expect(rows[2]!.segments[1]).toEqual({ token: "critical", text: "shipped silently" });
    expect(rows.map(rowText).join("\n")).not.toContain("…");
    for (const row of rows) expect(rowText(row)).toHaveLength(26);
  });

  it("hard-breaks a single over-long detail word across rows, still recovering the full text", () => {
    const rows = popupDetailRows(note({ detail: "x".repeat(60) }), { width: 24 });
    const detailRows = rows.map(rowBody).filter((text) => text.includes("x"));
    expect(detailRows).toEqual(["x".repeat(20), "x".repeat(20), "x".repeat(20)]); // inner width 24 - 4
    expect(detailRows.join("")).toBe("x".repeat(60));
  });
});

describe("popupActionAtRow", () => {
  const rows = popupDetailRows(note(), { width: 40 });
  // Framed layout: 0 top, 1 title, 2 blank, 3 detail, 4 blank, 5-7 hints, 8 bottom rule.
  const start = rows.length - 1 - POPUP_ACTIONS.length; // first actionable row, just above the bottom rule

  it("maps each hint row above the bottom rule to the action it names", () => {
    expect(start).toBe(5);
    expect(popupActionAtRow(rows, start)).toBe("understood"); // "1: Understood"
    expect(popupActionAtRow(rows, start + 1)).toBe("chat"); // "2: Chat in main session"
    expect(popupActionAtRow(rows, start + 2)).toBe("dismiss"); // "0: Dismiss"
  });

  it("returns null for the bottom rule, the body above the hint block, and out-of-range rows", () => {
    expect(popupActionAtRow(rows, rows.length - 1)).toBeNull(); // the bottom rule itself
    expect(popupActionAtRow(rows, 0)).toBeNull(); // top rule
    expect(popupActionAtRow(rows, 1)).toBeNull(); // title row
    expect(popupActionAtRow(rows, 2)).toBeNull(); // blank
    expect(popupActionAtRow(rows, 3)).toBeNull(); // detail line
    expect(popupActionAtRow(rows, 4)).toBeNull(); // blank before the hint block
    expect(popupActionAtRow(rows, -1)).toBeNull();
    expect(popupActionAtRow(rows, rows.length)).toBeNull();
    expect(popupActionAtRow(rows, 1.5)).toBeNull();
    expect(popupActionAtRow([], 0)).toBeNull();
  });

  it("never treats a detail line as an action, even one starting '<digit>: '", () => {
    const tricky = popupDetailRows(note({ detail: "2: Chat looks like a hint line" }), { width: 40 });
    const detailAt = tricky.map(rowBody).indexOf("2: Chat looks like a hint line");
    expect(detailAt).toBeGreaterThan(0);
    expect(detailAt).toBeLessThan(tricky.length - 1 - POPUP_ACTIONS.length); // outside the actionable block
    expect(popupActionAtRow(tricky, detailAt)).toBeNull();
  });
});
