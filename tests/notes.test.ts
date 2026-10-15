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

describe("NoteStore persistPending", () => {
  it("fires once with the exact pending list after an add", () => {
    const persist = vi.fn();
    const store = new NoteStore({ persistPending: persist });
    store.add(note("one"));
    store.add(note("two"));
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith([note("one"), note("two")]);
  });

  it("does not fire for a duplicate add", () => {
    const persist = vi.fn();
    const store = new NoteStore({ persistPending: persist });
    expect(store.add(note("API Keys"))).toBe(true);
    expect(store.add(note("api   keys", "warning", "Different title"))).toBe(false);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith([note("API Keys")]);
  });

  it("fires with the remaining list only when dismissSession removes something", () => {
    const persist = vi.fn();
    const store = new NoteStore({ persistPending: persist });
    store.add(note("one"));
    store.add(note("two"));
    persist.mockClear();

    expect(store.dismissSession("unknown")).toBe(false);
    expect(persist).not.toHaveBeenCalled();

    expect(store.dismissSession("  ONE  ")).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith([note("two")]);
  });

  it("fires once with the final deduped list after replacePending", () => {
    const persist = vi.fn();
    const store = new NoteStore({ persistPending: persist });
    store.replacePending([note("a"), note("A", "warning"), note("b"), note("c"), note("d")]);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith([note("b"), note("c"), note("d")]);
  });

  it("does not fire for a replacePending that leaves the pending list unchanged", () => {
    const persist = vi.fn();
    const store = new NoteStore({ persistPending: persist });
    store.add(note("one"));
    store.clearPending();
    persist.mockClear();

    store.replacePending([]); // empty -> empty: no-op, no fire
    store.replacePending([note("one")]); // real change: fires
    store.replacePending([note("ONE")]); // identical by topic: no-op, no fire
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith([note("one")]);
    expect(store.pending).toEqual([note("ONE")]);
  });

  it("fires for clearPending only when items were non-empty", () => {
    const persist = vi.fn();
    const store = new NoteStore({ persistPending: persist });
    store.clearPending(); // empty store: no-op, no fire
    expect(persist).not.toHaveBeenCalled();

    store.add(note("one"));
    persist.mockClear();
    store.clearPending();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith([]);

    store.clearPending();
    expect(persist).toHaveBeenCalledTimes(1); // already empty: no second fire
  });

  it("fires for dismissPermanently with the remaining pending list, alongside persistDismissed", () => {
    const persist = vi.fn();
    const persistDismissed = vi.fn();
    const store = new NoteStore({ persistPending: persist, persistDismissed });
    store.add(note("one"));
    store.add(note("two"));
    persist.mockClear();

    store.dismissPermanently("ONE");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith([note("two")]);
    expect(persistDismissed).toHaveBeenCalledWith(["one"]);
    expect(store.pending.map((n) => n.topic)).toEqual(["two"]);
  });

  it("works without a persistPending callback (option is optional)", () => {
    const store = new NoteStore();
    expect(() => {
      store.add(note("one"));
      store.dismissSession("one");
      store.clearPending();
      store.replacePending([note("two")]);
      store.dismissPermanently("two");
    }).not.toThrow();
    expect(store.pending).toHaveLength(0);
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
