import { describe, expect, it, vi } from "vitest";
import { parseYskArgs, resolveNote, wireActions, type ActionDeps } from "../src/actions.ts";
import { NoteStore, type Note } from "../src/notes.ts";

function note(topic: string, title = `Title: ${topic}`): Note {
  return { topic, severity: "info", title, detail: `Detail for ${topic}` };
}

describe("parseYskArgs", () => {
  it("opens the popup for empty input", () => {
    expect(parseYskArgs("")).toEqual({ action: "popup" });
    expect(parseYskArgs("   ")).toEqual({ action: "popup" });
  });

  it("parses each known action", () => {
    expect(parseYskArgs("learn")).toEqual({ action: "learn" });
    expect(parseYskArgs("known")).toEqual({ action: "known" });
    expect(parseYskArgs("chat")).toEqual({ action: "chat" });
    expect(parseYskArgs("dismiss")).toEqual({ action: "dismiss" });
    expect(parseYskArgs("status")).toEqual({ action: "status" });
    expect(parseYskArgs("popup")).toEqual({ action: "popup" });
  });

  it("is tolerant of surrounding whitespace and case-insensitive... no, keeps exact tokens", () => {
    expect(parseYskArgs("  dismiss  ")).toEqual({ action: "dismiss" });
    expect(parseYskArgs("DISMISS").hint).toBeDefined();
  });

  it("parses a 1-based index after the action", () => {
    expect(parseYskArgs("dismiss 2")).toEqual({ action: "dismiss", index: 2 });
    expect(parseYskArgs("learn 1")).toEqual({ action: "learn", index: 1 });
    expect(parseYskArgs("popup 2")).toEqual({ action: "popup", index: 2 });
  });

  it("treats a bare index as shorthand for learning that note", () => {
    expect(parseYskArgs("3")).toEqual({ action: "learn", index: 3 });
  });

  it("falls back to status with a hint for unknown actions", () => {
    const parsed = parseYskArgs("explode");
    expect(parsed.action).toBe("status");
    expect(parsed.hint).toContain("explode");
  });

  it("ignores non-numeric extra tokens instead of guessing an index", () => {
    expect(parseYskArgs("chat now")).toEqual({ action: "chat" });
  });

  it("keeps zero and negative indexes so resolveNote can reject them", () => {
    expect(parseYskArgs("dismiss 0")).toEqual({ action: "dismiss", index: 0 });
    expect(parseYskArgs("dismiss -1").index).toBeUndefined();
  });
});

describe("resolveNote", () => {
  const pending = [note("oldest"), note("middle"), note("newest")];

  it("picks the newest note by default", () => {
    expect(resolveNote(pending)?.topic).toBe("newest");
  });

  it("resolves 1-based indexes oldest-first, matching popup list order", () => {
    expect(resolveNote(pending, 1)?.topic).toBe("oldest");
    expect(resolveNote(pending, 3)?.topic).toBe("newest");
  });

  it("returns undefined for empty pending lists", () => {
    expect(resolveNote([], 1)).toBeUndefined();
    expect(resolveNote([])).toBeUndefined();
  });

  it("returns undefined for out-of-range, zero, negative, and fractional indexes", () => {
    expect(resolveNote(pending, 4)).toBeUndefined();
    expect(resolveNote(pending, 0)).toBeUndefined();
    expect(resolveNote(pending, -1)).toBeUndefined();
    expect(resolveNote(pending, 1.5)).toBeUndefined();
  });
});

describe("wireActions", () => {
  type Handler = (args: string, ctx: unknown) => Promise<void>;

  function setup(pendingNotes: Note[] = []) {
    const commands = new Map<string, { handler: Handler }>();
    const pi = {
      registerCommand: (name: string, options: { handler: Handler }) => commands.set(name, options),
    };
    const store = new NoteStore();
    store.replacePending(pendingNotes);
    const deps: ActionDeps = {
      store,
      openPopup: vi.fn(),
      markProcessed: vi.fn(),
      fillEditor: vi.fn(),
      persist: vi.fn(),
      rerender: vi.fn(),
      notify: vi.fn(),
      status: () => "you-should-know status\npending: 0",
    };
    wireActions(pi as never, deps);
    const handler = commands.get("ysk")!.handler;
    return { deps, handler };
  }

  function openPopupCalls(deps: ActionDeps): unknown[] {
    return (deps.openPopup as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
  }

  it("registers the /ysk command with argument completions", () => {
    const commands = new Map<string, { handler: Handler; getArgumentCompletions?: (p: string) => unknown }>();
    const pi = { registerCommand: (name: string, options: never) => commands.set(name, options) };
    wireActions(
      pi as never,
      {
        store: new NoteStore(),
        openPopup: vi.fn(),
        markProcessed: vi.fn(),
        fillEditor: vi.fn(),
        persist: vi.fn(),
        rerender: vi.fn(),
        notify: vi.fn(),
        status: () => "",
      },
    );
    expect(commands.get("ysk")!.handler).toBeTypeOf("function");
    const completions = commands.get("ysk")!.getArgumentCompletions?.("");
    expect(completions).toContainEqual(expect.objectContaining({ value: "learn" }));
    expect(completions).toContainEqual(expect.objectContaining({ value: "popup" }));
  });

  it("bare /ysk opens the all-notes popup", async () => {
    const { deps, handler } = setup([note("a"), note("b")]);
    await handler("", {});
    expect(openPopupCalls(deps)).toEqual([{ all: true }]);
    expect(deps.fillEditor).not.toHaveBeenCalled();
    expect(deps.store.pending).toHaveLength(2); // nothing processed by opening
  });

  it("/ysk popup opens the all-notes popup too", async () => {
    const { deps, handler } = setup([note("a"), note("b")]);
    await handler("popup", {});
    expect(openPopupCalls(deps)).toEqual([{ all: true }]);
  });

  it("learn opens that note's popup, newest by default", async () => {
    const { deps, handler } = setup([note("a"), note("b")]);
    await handler("learn", {});
    expect(openPopupCalls(deps)).toEqual([expect.objectContaining({ topic: "b" })]);
  });

  it("learn resolves a 1-based index", async () => {
    const { deps, handler } = setup([note("a"), note("b")]);
    await handler("learn 1", {});
    expect(openPopupCalls(deps)).toEqual([expect.objectContaining({ topic: "a" })]);
  });

  it("/ysk popup with an index opens that note's detail popup", async () => {
    const { deps, handler } = setup([note("a"), note("b")]);
    await handler("popup 2", {});
    expect(openPopupCalls(deps)).toEqual([expect.objectContaining({ topic: "b" })]);
  });

  it("learn warns and opens nothing when there is no pending note", async () => {
    const { deps, handler } = setup([]);
    await handler("learn", {});
    await handler("", {});
    expect(deps.openPopup).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("No pending"), "warning");
  });

  it("known dismisses permanently, persists, and re-renders", async () => {
    const { deps, handler } = setup([note("loud-topic")]);
    await handler("known", {});
    expect(deps.store.pending).toHaveLength(0);
    expect(deps.store.isDismissed("loud-topic")).toBe(true);
    expect(deps.persist).toHaveBeenCalledOnce();
    expect(deps.rerender).toHaveBeenCalledOnce();
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("loud-topic"), "info");
  });

  it("chat fills the editor, marks the note processed, and reports the new wording", async () => {
    const { deps, handler } = setup([note("assumption")]);
    await handler("chat", {});
    expect(deps.fillEditor).toHaveBeenCalledOnce();
    const text = (deps.fillEditor as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(text).toContain("Re: heads-up — please address");
    expect(text).toContain("Detail for assumption");
    expect(deps.markProcessed).toHaveBeenCalledOnce();
    expect((deps.markProcessed as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ topic: "assumption" });
    expect(deps.notify).toHaveBeenCalledWith("Note copied to the prompt — marked as processed.", "info");
  });

  it("dismiss hides the note for the session without persisting", async () => {
    const { deps, handler } = setup([note("noisy")]);
    await handler("dismiss", {});
    expect(deps.store.pending).toHaveLength(0);
    expect(deps.persist).not.toHaveBeenCalled();
    expect(deps.rerender).toHaveBeenCalledOnce();
  });

  it("status reports reviewer state through the injected status text", async () => {
    const { deps, handler } = setup([]);
    await handler("status", {});
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("you-should-know status"), "info");
  });

  it("unknown actions show the parse hint and then the status text", async () => {
    const { deps, handler } = setup([]);
    await handler("wat", {});
    expect(deps.notify).toHaveBeenNthCalledWith(1, expect.stringContaining("wat"), "warning");
    expect(deps.notify).toHaveBeenNthCalledWith(2, expect.stringContaining("you-should-know status"), "info");
  });

  it("out-of-range indexes warn instead of acting on the wrong note", async () => {
    const { deps, handler } = setup([note("only")]);
    await handler("dismiss 5", {});
    expect(deps.store.pending).toHaveLength(1);
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("#5"), "warning");
  });
});
