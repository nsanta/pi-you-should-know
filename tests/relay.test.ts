import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RELAY_FILE_GC_MS,
  RELAY_SCHEMA_VERSION,
  RelayWatcher,
  RelayWriter,
  decodeRelayLine,
  encodeRelayLine,
  isSubagentChild,
  parseOrigin,
  relayDirFor,
  resolveAgentHome,
} from "../src/relay.ts";
import { NoteStore, type Note } from "../src/notes.ts";

const HOME = mkdtempSync(join(tmpdir(), "ysk-relay-home-"));

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function note(overrides: Partial<Note> = {}): Note {
  return { topic: "silent assumption", severity: "warning", title: "A title", detail: "Some detail", ...overrides };
}

/** Minimal JSONL relay line for seeding a watcher fixture. */
function lineJson(overrides: Record<string, unknown>): string {
  return `${JSON.stringify({ v: RELAY_SCHEMA_VERSION, id: "s:1", ts: Date.now(), note: { topic: "t", severity: "info", title: "T", detail: "" }, ...overrides })}\n`;
}

describe("resolveAgentHome", () => {
  it("prefers GENTLE_PI_AGENT_HOME, then PI_CODING_AGENT_DIR, then HOME/.pi/agent", () => {
    expect(resolveAgentHome({ GENTLE_PI_AGENT_HOME: "/g", PI_CODING_AGENT_DIR: "/p", HOME: "/h" })).toBe("/g");
    expect(resolveAgentHome({ PI_CODING_AGENT_DIR: "/p", HOME: "/h" })).toBe("/p");
    expect(resolveAgentHome({ HOME: "/h" })).toBe(join("/h", ".pi", "agent"));
  });

  it("falls through empty-string overrides so both ends always agree on one home", () => {
    expect(resolveAgentHome({ GENTLE_PI_AGENT_HOME: "", PI_CODING_AGENT_DIR: "  ", HOME: "/h" })).toBe(
      join("/h", ".pi", "agent"),
    );
  });

  it("tolerates a missing HOME as a relative fallback root", () => {
    expect(resolveAgentHome({})).toBe(join("", ".pi", "agent"));
  });
});

describe("isSubagentChild + relayDirFor", () => {
  it("detects children by the exact runner marker", () => {
    expect(isSubagentChild({ GENTLE_PI_AGENTS_CHILD: "1" })).toBe(true);
    expect(isSubagentChild({ GENTLE_PI_AGENTS_CHILD: "0" })).toBe(false);
    expect(isSubagentChild({ GENTLE_PI_AGENTS_CHILD: "" })).toBe(false);
    expect(isSubagentChild({})).toBe(false);
  });

  it("places the relay dir under the resolved agent home", () => {
    expect(relayDirFor({ GENTLE_PI_AGENT_HOME: "/g" })).toBe(join("/g", "you-should-know", "relay"));
  });
});

describe("encodeRelayLine", () => {
  it("encodes the v1 wire schema with identity and payload", () => {
    const line = encodeRelayLine(note(), { id: "s:7", ts: 123.9, cwd: "/c", sessionId: "s" });
    expect(line).toEqual({
      v: 1,
      id: "s:7",
      ts: 123,
      cwd: "/c",
      sessionId: "s",
      note: { topic: "silent assumption", severity: "warning", title: "A title", detail: "Some detail" },
    });
  });

  it("returns null for an empty normalized topic instead of writing junk", () => {
    expect(encodeRelayLine(note({ topic: "   " }), { id: "s:1", ts: 1 })).toBeNull();
    expect(encodeRelayLine(note({ topic: "" }), { id: "s:1", ts: 1 })).toBeNull();
  });

  it("coerces the payload defensively and drops empty identity fields", () => {
    const line = encodeRelayLine(note({ severity: "nope" as never, title: 42 as never }), { id: "s:1", ts: 1 });
    expect(line?.note).toEqual({ topic: "silent assumption", severity: "info", title: "", detail: "Some detail" });
    expect(line?.cwd).toBeUndefined();
    expect(line?.sessionId).toBeUndefined();
  });
});

describe("decodeRelayLine", () => {
  it("round-trips an encoded line into a note plus its subagent origin", () => {
    const encoded = encodeRelayLine(note(), { id: "s:2", ts: 99, cwd: "/c", sessionId: "s" });
    const decoded = decodeRelayLine(JSON.stringify(encoded));
    expect(decoded).toMatchObject({
      id: "s:2",
      ts: 99,
      origin: { via: "subagent", cwd: "/c", sessionId: "s" },
      note: { topic: "silent assumption", severity: "warning", title: "A title", detail: "Some detail" },
    });
  });

  it("returns null for blank lines and corrupt JSON without throwing", () => {
    expect(decodeRelayLine("")).toBeNull();
    expect(decodeRelayLine("   \n")).toBeNull();
    expect(decodeRelayLine("{ not json")).toBeNull();
  });

  it("returns null for wrong schema versions and unusable payloads", () => {
    expect(decodeRelayLine(JSON.stringify({ v: 999, id: "s:1", ts: 1, note: { topic: "t" } }))).toBeNull();
    expect(decodeRelayLine(JSON.stringify({ v: 1, id: "", ts: 1, note: { topic: "t" } }))).toBeNull();
    expect(decodeRelayLine(JSON.stringify({ v: 1, id: "s:1", ts: 1, note: { topic: "  " } }))).toBeNull();
    expect(decodeRelayLine(JSON.stringify({ v: 1, id: "s:1", ts: 1 }))).toBeNull();
    expect(decodeRelayLine(JSON.stringify([1, 2]))).toBeNull();
  });

  it("defaults a missing ts to 0 (callers fall back to the file mtime)", () => {
    const decoded = decodeRelayLine(lineJson({ ts: undefined }));
    expect(decoded?.ts).toBe(0);
  });
});

describe("parseOrigin", () => {
  it("keeps only well-formed subagent origins", () => {
    expect(parseOrigin({ via: "subagent", cwd: "/c", sessionId: "s" })).toEqual({ via: "subagent", cwd: "/c", sessionId: "s" });
    expect(parseOrigin({ via: "subagent" })).toEqual({ via: "subagent" });
    expect(parseOrigin({ via: "local" })).toBeUndefined();
    expect(parseOrigin("subagent")).toBeUndefined();
    expect(parseOrigin(null)).toBeUndefined();
    expect(parseOrigin({ via: "subagent", cwd: 42, sessionId: true })).toEqual({ via: "subagent" });
  });
});

describe("RelayWriter", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ysk-writer-"));
  });

  it("appends valid JSONL lines with sequential per-writer ids and one file per session", async () => {
    let tick = 1000;
    const writer = new RelayWriter({ dir, sessionId: "sess-1", cwd: "/child", clock: () => (tick += 1) });
    writer.enqueue(note({ topic: "first" }));
    writer.enqueue(note({ topic: "second" }));
    writer.enqueue(note({ topic: "   " })); // unusable: skipped, never written
    writer.enqueue(note({ topic: "third" }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const path = join(dir, "sess-1.jsonl");
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    const parsed = lines.map((text) => JSON.parse(text));
    expect(parsed.map((entry) => entry.id)).toEqual(["sess-1:1", "sess-1:2", "sess-1:3"]);
    expect(parsed.map((entry) => entry.note.topic)).toEqual(["first", "second", "third"]);
    for (const entry of parsed) {
      expect(entry.v).toBe(RELAY_SCHEMA_VERSION);
      expect(entry.cwd).toBe("/child");
      expect(entry.sessionId).toBe("sess-1");
    }
    expect(parsed[0]!.ts).toBeLessThan(parsed[1]!.ts); // injected clock drives timestamps
  });

  it("swallows unwritable-dir errors quiet (nothing throws, nothing is written)", async () => {
    const blocked = join(dir, "file-blocks-mkdir"); // a FILE where mkdir must happen
    writeFileSync(blocked, "not a dir", "utf8");
    const writer = new RelayWriter({ dir: join(blocked, "relay"), sessionId: "s" });
    expect(() => writer.enqueue(note())).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(join(blocked, "relay"))).toBe(false);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("RelayWatcher", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ysk-watcher-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("ingests fresh seeded lines into a real NoteStore via the ingest callback", async () => {
    const store = new NoteStore();
    writeFileSync(join(dir, "child.jsonl"), lineJson({ id: "s:1", note: { topic: "relayed", severity: "critical", title: "R", detail: "d" } }), "utf8");
    const watcher = new RelayWatcher({ dir, maxAgeMs: 60_000, ingest: (ingested) => void store.add(ingested) });
    await watcher.scanNow();
    expect(store.pending.map((n) => n.topic)).toEqual(["relayed"]);
    expect(store.pending[0]).toMatchObject({ severity: "critical", title: "R", origin: { via: "subagent" } });
    expect(watcher.stats()).toEqual({ files: 1, ingested: 1 });

    await watcher.close();
  });

  it("respects consumed ids on rescan: a line is ingested once per watcher lifetime", async () => {
    const ingested: string[] = [];
    writeFileSync(join(dir, "child.jsonl"), lineJson({ id: "s:1", note: { topic: "once" } }), "utf8");
    const watcher = new RelayWatcher({ dir, maxAgeMs: 60_000, ingest: (n) => void ingested.push(n.topic) });
    await watcher.scanNow();
    await watcher.scanNow();
    await watcher.scanNow();
    expect(ingested).toEqual(["once"]);
    await watcher.close();
  });

  it("respects maxAgeMs: old-ts lines are skipped, fresh ones ingested", async () => {
    const ingested: string[] = [];
    const stale = Date.now() - 2 * 60 * 60 * 1000;
    writeFileSync(
      join(dir, "child.jsonl"),
      [
        lineJson({ id: "s:old", ts: stale, note: { topic: "stale" } }),
        lineJson({ id: "s:new", ts: Date.now(), note: { topic: "fresh" } }),
      ].join(""),
      "utf8",
    );
    const watcher = new RelayWatcher({ dir, maxAgeMs: 60 * 60 * 1000, ingest: (n) => void ingested.push(n.topic) });
    await watcher.scanNow();
    expect(ingested).toEqual(["fresh"]);
    await watcher.close();
  });

  it("falls back to the file mtime for the age check when a line has no ts", async () => {
    const ingested: string[] = [];
    writeFileSync(join(dir, "child.jsonl"), lineJson({ id: "s:1", ts: undefined, note: { topic: "mtime-aged" } }), "utf8");
    utimesSync(join(dir, "child.jsonl"), new Date(Date.now() - 10 * 60 * 60 * 1000), new Date(Date.now() - 10 * 60 * 60 * 1000));
    const watcher = new RelayWatcher({ dir, maxAgeMs: 60 * 60 * 1000, ingest: (n) => void ingested.push(n.topic) });
    await watcher.scanNow();
    expect(ingested).toEqual([]); // old mtime => outside the window
    await watcher.close();
  });

  it("resumes from byte offsets: appending a second line picks up only the new one", async () => {
    const ingested: string[] = [];
    const path = join(dir, "child.jsonl");
    writeFileSync(path, lineJson({ id: "s:1", note: { topic: "first" } }), "utf8");
    const watcher = new RelayWatcher({ dir, maxAgeMs: 60_000, ingest: (n) => void ingested.push(n.topic) });
    await watcher.scanNow();
    expect(ingested).toEqual(["first"]);

    // A partial (unterminated) line must wait for its newline...
    const { appendFileSync } = await import("node:fs");
    appendFileSync(path, lineJson({ id: "s:2", note: { topic: "second" } }).trimEnd()); // no trailing \n yet
    await watcher.scanNow();
    expect(ingested).toEqual(["first"]);

    appendFileSync(path, "\n");
    await watcher.scanNow();
    expect(ingested).toEqual(["first", "second"]);
    await watcher.close();
  });

  it("resets the cursor when a file shrank (recreated/truncated)", async () => {
    const ingested: string[] = [];
    const path = join(dir, "child.jsonl");
    writeFileSync(path, lineJson({ id: "s:1", note: { topic: "long first run that shifts the offset" } }), "utf8");
    const watcher = new RelayWatcher({ dir, maxAgeMs: 60_000, ingest: (n) => void ingested.push(n.topic) });
    await watcher.scanNow();
    expect(ingested).toEqual(["long first run that shifts the offset"]);

    writeFileSync(path, lineJson({ id: "s:2", note: { topic: "recreated" } }), "utf8"); // shorter: size < cursor
    await watcher.scanNow();
    expect(ingested).toEqual(["long first run that shifts the offset", "recreated"]);
    await watcher.close();
  });

  it("garbage-collects files whose mtime is older than RELAY_FILE_GC_MS and drops their cursors", async () => {
    const ingested: string[] = [];
    const path = join(dir, "ancient.jsonl");
    writeFileSync(path, lineJson({ id: "s:1", note: { topic: "ancient" } }), "utf8");
    const old = new Date(Date.now() - RELAY_FILE_GC_MS - 60_000);
    utimesSync(path, old, old);
    const watcher = new RelayWatcher({ dir, maxAgeMs: 60_000, ingest: (n) => void ingested.push(n.topic) });
    await watcher.scanNow();
    expect(existsSync(path)).toBe(false);
    expect(ingested).toEqual([]); // GC wins before any ingest
    expect(watcher.stats()).toEqual({ files: 0, ingested: 0 });
    await watcher.close();
  });

  it("keeps a failing ingest sink from breaking the scan", async () => {
    writeFileSync(join(dir, "child.jsonl"), lineJson({ id: "s:1", note: { topic: "boom" } }), "utf8");
    const sink = vi.fn(() => {
      throw new Error("sink exploded");
    });
    const watcher = new RelayWatcher({ dir, maxAgeMs: 60_000, ingest: sink });
    await expect(watcher.scanNow()).resolves.toBeUndefined();
    expect(sink).toHaveBeenCalledOnce();
    await watcher.close();
  });

  it("start() tolerates a missing dir quietly and close() stops watching", async () => {
    const missing = join(dir, "not-created-yet");
    const watcher = new RelayWatcher({ dir: missing, maxAgeMs: 60_000, ingest: () => {} });
    await expect(watcher.start()).resolves.toBeUndefined(); // mkdir best-effort, scan quiet
    watcher.close();
    watcher.close(); // double close is harmless
    expect(watcher.stats()).toEqual({ files: 0, ingested: 0 });
  });

  it("ingests live writes through start()'s watch + debounced rescan", async () => {
    const ingested: string[] = [];
    const watcher = new RelayWatcher({ dir, maxAgeMs: 60_000, ingest: (n) => void ingested.push(n.topic) });
    await watcher.start();
    writeFileSync(join(dir, "live.jsonl"), lineJson({ id: "live:1", note: { topic: "live note" } }), "utf8");
    const deadline = Date.now() + 5000;
    while (!ingested.includes("live note") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(ingested).toEqual(["live note"]);
    watcher.close();
  });
});
