import { describe, expect, it } from "vitest";
import {
  renderWidget,
  severityColorToken,
  severityLabel,
  widgetLines,
  type WidgetOptions,
} from "../src/widget.ts";
import { PENDING_CAP, type Note, type Severity } from "../src/notes.ts";

function note(overrides: Partial<Note> = {}): Note {
  return { topic: "topic", severity: "info", title: "A title", detail: "Some detail", ...overrides };
}

function notesOfSeverities(...severities: Severity[]): Note[] {
  return severities.map((severity, i) => note({ topic: `topic-${i}`, title: `Title ${i + 1}`, severity }));
}

const HINT = "Actions: /ysk learn · known · chat · dismiss";

describe("severity mappings", () => {
  it("maps severity -> theme token (info=accent, warning=warning, critical=error)", () => {
    expect(severityColorToken("info")).toBe("accent");
    expect(severityColorToken("warning")).toBe("warning");
    expect(severityColorToken("critical")).toBe("error");
  });

  it("maps severity -> display label", () => {
    expect(severityLabel("info")).toBe("info");
    expect(severityLabel("warning")).toBe("warning");
    expect(severityLabel("critical")).toBe("critical");
  });
});

describe("renderWidget", () => {
  it("returns an empty array when there are no notes", () => {
    expect(renderWidget([])).toEqual([]);
  });

  it("renders one line per note plus the action hint", () => {
    const lines = renderWidget(notesOfSeverities("info", "warning"));
    expect(lines).toEqual(["[info] Title 1", "[warning] Title 2", HINT]);
  });

  it("falls back to the topic when the title is blank", () => {
    const lines = renderWidget([note({ title: "   ", topic: "silent assumption" })]);
    expect(lines[0]).toBe("[info] silent assumption");
  });

  it("shows at most PENDING_CAP notes and a +N more line", () => {
    const lines = renderWidget(notesOfSeverities("info", "info", "info", "critical", "warning"));
    expect(lines).toHaveLength(PENDING_CAP + 2);
    expect(lines[0]).toBe("[info] Title 1");
    expect(lines[2]).toBe("[info] Title 3");
    expect(lines[3]).toBe("+2 more");
    expect(lines[4]).toBe(HINT);
  });

  it("never emits the action hint when there are no notes", () => {
    expect(renderWidget([]).some((line) => line.includes("/ysk"))).toBe(false);
  });

  it("respects a custom maxNotes option", () => {
    const options: WidgetOptions = { maxNotes: 1 };
    const lines = renderWidget(notesOfSeverities("info", "critical"), options);
    expect(lines).toEqual(["[info] Title 1", "+1 more", HINT]);
  });
});

describe("widget width safety", () => {
  it("truncates every line to the requested width", () => {
    const wide = notesOfSeverities("warning", "critical");
    wide[0]!.title = "x".repeat(300);
    const width = 40;
    const lines = renderWidget(wide, { width });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(width);
  });

  it("marks truncation instead of cutting silently", () => {
    const lines = renderWidget([note({ title: "y".repeat(100) })], { width: 20 });
    expect(lines[0]!.length).toBe(20);
    expect(lines[0]!.endsWith("…")).toBe(true);
  });

  it("leaves lines untouched when no width is given", () => {
    const title = "z".repeat(150);
    const lines = renderWidget([note({ title })]);
    expect(lines[0]).toBe(`[info] ${title}`);
  });

  it("ignores invalid widths", () => {
    const lines = renderWidget([note({ title: "w".repeat(50) })], { width: 0 });
    expect(lines[0]!.length).toBeGreaterThan(10);
  });
});

describe("widgetLines (structural rows for the themed caller)", () => {
  it("pairs every row with its severity so callers can color it", () => {
    const rows = widgetLines(notesOfSeverities("info", "critical"));
    expect(rows.map((row) => row.severity)).toEqual(["info", "critical", "info"]);
    expect(rows[2]!.text).toBe(HINT);
  });

  it("marks the +N more row as neutral info severity", () => {
    const rows = widgetLines(notesOfSeverities("critical", "critical", "critical", "critical"));
    expect(rows[3]).toEqual({ severity: "info", text: "+1 more" });
  });
});
