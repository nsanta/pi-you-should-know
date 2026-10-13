import { describe, expect, it, vi } from "vitest";
import {
  formatNotesForChat,
  normalizeTopic,
  NoteStore,
  PENDING_CAP,
  type Note,
} from "../src/notes.ts";

function note(topic: string, severity: Note["severity"] = "info", title?: string, detail?: string): Note {
  return { topic, severity, title: title ?? `${topic} title`, detail: detail ?? `${topic} detail` };
}

describe("normalizeTopic", () => {
  it("trims, collapses whitespace, and lowercases", () => {
    expect(normalizeTopic("  API   Keys  ")).toBe("api keys");
    expect(normalizeTopic("Mixed\tCase\nTopic")).toBe("mixed case topic");
    expect(normalizeTopic("")).toBe("");
  });
});

describe("NoteStore.add", () => {
  it("adds notes and returns true", () => {
    const store = new NoteStore();
    expect(store.add(note("api keys"))).toBe(true);
    expect(store.pending).toHaveLength(1);
  });

  it("dedupes pending notes by normalized topic", () => {
    const store = new NoteStore();
    store.add(note("API Keys"));
    expect(store.add(note("api   keys", "warning", "Different title"))).toBe(false);
    expect(store.pending).toHaveLength(1);
    expect(store.pending[0]?.title).toBe("API Keys title");
  });

  it("allows distinct topics", () => {
    const store = new NoteStore();
    store.add(note("api keys"));
    expect(store.add(note("naming"))).toBe(true);
    expect(store.pending).toHaveLength(2);
  });
});

describe("NoteStore pending cap", () => {
  it("caps pending notes at 3, evicting the oldest", () => {
    const store = new NoteStore();
    for (const topic of ["one", "two", "three", "four"]) store.add(note(topic));
    expect(PENDING_CAP).toBe(3);
    expect(store.pending.map((n) => n.topic)).toEqual(["two", "three", "four"]);
  });

  it("returns defensive copies of the pending list", () => {
    const store = new NoteStore();
    store.add(note("one"));
    store.pending.push(note("intruder"));
    store.pending.shift();
    expect(store.pending.map((n) => n.topic)).toEqual(["one"]);
  });
});

describe("NoteStore dismissal flows", () => {
  it("dismissSession removes the pending note for this session", () => {
    const store = new NoteStore();
    store.add(note("api keys"));
    expect(store.dismissSession("  API   KEYS ")).toBe(true);
    expect(store.pending).toHaveLength(0);
    expect(store.isDismissed("api keys")).toBe(true);
  });

  it("dismissSession returns false for unknown topics", () => {
    const store = new NoteStore();
    expect(store.dismissSession("nope")).toBe(false);
  });

  it("dismissPermanently persists via the injected callback and survives re-checks", () => {
    const persist = vi.fn();
    const store = new NoteStore({ persistDismissed: persist });
    store.add(note("api keys"));
    store.add(note("naming"));
    store.dismissPermanently("API   Keys");
    expect(store.pending.map((n) => n.topic)).toEqual(["naming"]);
    expect(store.isDismissed("api keys")).toBe(true);
    expect(store.dismissedTopics).toEqual(["api keys"]);
    expect(persist).toHaveBeenCalledWith(["api keys"]);

    store.dismissPermanently("naming");
    expect(store.dismissedTopics).toEqual(["api keys", "naming"]);
    expect(persist).toHaveBeenLastCalledWith(["api keys", "naming"]);
  });

  it("isDismissed matches only normalized topics", () => {
    const store = new NoteStore();
    store.dismissPermanently("Time  Out");
    expect(store.isDismissed("time out")).toBe(true);
    expect(store.isDismissed("timeout")).toBe(false);
    expect(store.isDismissed("other")).toBe(false);
  });

  it("clearPending empties pending but keeps dismissals", () => {
    const store = new NoteStore();
    store.add(note("one"));
    store.dismissPermanently("one");
    store.add(note("two"));
    store.clearPending();
    expect(store.pending).toHaveLength(0);
    expect(store.isDismissed("one")).toBe(true);
  });

  it("replacePending dedupes and caps like add", () => {
    const store = new NoteStore();
    store.replacePending([
      note("a"),
      note("A", "warning"),
      note("b"),
      note("c"),
      note("d"),
    ]);
    expect(store.pending.map((n) => n.topic)).toEqual(["b", "c", "d"]);
  });
});

describe("formatNotesForChat", () => {
  it("formats one or more notes as a chat message", () => {
    const text = formatNotesForChat([
      note("api keys", "warning", "Hardcoded API keys", "Keys live in src/config.ts."),
      note("naming", "critical", "Naming drift"),
    ]);
    expect(text).toContain("**You should know**");
    expect(text).toContain("- [warning] Hardcoded API keys");
    expect(text).toContain("Keys live in src/config.ts.");
    expect(text).toContain("- [critical] Naming drift");
  });

  it("returns an empty string for no notes", () => {
    expect(formatNotesForChat([])).toBe("");
  });
});
