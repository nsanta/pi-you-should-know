import { describe, expect, it } from "vitest";
import {
  KEY_ACTIONS,
  renderWidget,
  severityColorToken,
  severityLabel,
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
