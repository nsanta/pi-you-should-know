/**
 * Subagent relay: the file convention that carries heads-up notes from
 * gentle-pi subagent children (headless `pi --mode rpc` processes) to
 * parent sessions.
 *
 * gentle-pi spawns every subagent as a separate pi process and marks it
 * with `GENTLE_PI_AGENTS_CHILD=1` (agents-runner.ts). This package loads in
 * every pi process, so both ends of the relay live here:
 *
 * - CHILD (writer): appends one JSON line per new note to
 *   `<agentHome>/you-should-know/relay/<sessionId>.jsonl`. The child never
 *   reads relay state; its own in-memory store keeps working unchanged.
 * - PARENT (watcher): scans the shared relay dir, ingests fresh lines into
 *   its pending-note store (with `origin: { via: "subagent" }`), and shows
 *   them through the normal sidebar/popup surfaces.
 *
 * Coordination contract, deliberately one-directional: a relay file has
 * exactly one appender (its child) and many best-effort readers (parents).
 * Parents keep byte-offset cursors in memory and never mutate child files
 * except for garbage collection (files idle for RELAY_FILE_GC_MS). Nothing
 * here throws: the relay is best-effort transport around a quiet feature.
 */

import { watch, type FSWatcher, type Stats } from "node:fs";
import { appendFile, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { coerceSeverity, normalizeTopic, type Note, type Severity } from "./notes.ts";

/** Schema version of a relay line; bump only for a breaking wire change. */
export const RELAY_SCHEMA_VERSION = 1;

/**
 * Relay files idle longer than this are garbage: children are short-lived,
 * so a stale mtime means the child is gone and its notes are far past any
 * parent's ingest window.
 */
export const RELAY_FILE_GC_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Resolve the pi agent home the same way gentle-pi does (lib/agent-home.ts):
 * an empty override must fall through so both ends always agree on one home.
 */
export function resolveAgentHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = typeof env.GENTLE_PI_AGENT_HOME === "string" ? env.GENTLE_PI_AGENT_HOME.trim() : "";
  if (override.length > 0) return override;
  const piDir = typeof env.PI_CODING_AGENT_DIR === "string" ? env.PI_CODING_AGENT_DIR.trim() : "";
  if (piDir.length > 0) return piDir;
  return join(typeof env.HOME === "string" && env.HOME.length > 0 ? env.HOME : "", ".pi", "agent");
}

/** The relay directory both ends share, under the resolved agent home. */
export function relayDirFor(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveAgentHome(env), "you-should-know", "relay");
}

/**
 * True when this process is a gentle-pi subagent child (runner-set marker).
 * Undefined/empty markers mean a normal session — the parent side.
 */
export function isSubagentChild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GENTLE_PI_AGENTS_CHILD === "1";
}

/** Who produced a relayed note and where its session ran. */
export interface NoteOrigin {
  via: "subagent";
  /** Working directory of the child session, when known. */
  cwd?: string;
  /** Session id of the child, when known. */
  sessionId?: string;
}

/** The wire form of one relayed note: one JSON line in a `<sessionId>.jsonl` file. */
export interface RelayLine {
  v: typeof RELAY_SCHEMA_VERSION;
  /** Stable identity `<sessionId>:<seq>`; parents use it to consume once. */
  id: string;
  /** Creation time (Date.now() at the child). */
  ts: number;
  /** Child working directory; context for the parent's display. */
  cwd?: string;
  /** Child session id; redundant with the file name but self-describing. */
  sessionId?: string;
  /** The note payload, exactly the pending-store shape (no origin here: the file IS the origin). */
  note: { topic: string; severity: Severity; title: string; detail: string };
}

/**
 * Build one relay line for a note. Returns null for notes that could never
 * be ingested (empty normalized topic), so the writer skips them instead of
 * writing junk a parent must filter.
 */
export function encodeRelayLine(note: Note, identity: { id: string; ts: number; cwd?: string; sessionId?: string }): RelayLine | null {
  const topic = normalizeTopic(note?.topic ?? "");
  if (topic.length === 0) return null;
  const line: RelayLine = {
    v: RELAY_SCHEMA_VERSION,
    id: identity.id,
    ts: Number.isFinite(identity.ts) ? Math.floor(identity.ts) : Date.now(),
    note: {
      topic,
      severity: coerceSeverity(note.severity),
      title: typeof note.title === "string" ? note.title : "",
      detail: typeof note.detail === "string" ? note.detail : "",
    },
  };
  if (typeof identity.cwd === "string" && identity.cwd.length > 0) line.cwd = identity.cwd;
  if (typeof identity.sessionId === "string" && identity.sessionId.length > 0) line.sessionId = identity.sessionId;
  return line;
}

/** Defensive origin parser for note persistence: only well-formed subagent origins survive. */
export function parseOrigin(value: unknown): NoteOrigin | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.via !== "subagent") return undefined;
  const origin: NoteOrigin = { via: "subagent" };
  if (typeof record.cwd === "string" && record.cwd.length > 0) origin.cwd = record.cwd;
  if (typeof record.sessionId === "string" && record.sessionId.length > 0) origin.sessionId = record.sessionId;
  return origin;
}

/**
 * Decode one relay-file line into the note the parent should ingest plus
 * its relay identity. Returns null for blank lines, corrupt JSON, wrong
 * schema versions, or unusable payloads — a bad line is skipped, never
 * fatal, and never advances a parent past good lines that follow (callers
 * advance offsets only to the end of the last fully parsed block).
 */
export function decodeRelayLine(text: string): { id: string; ts: number; origin: NoteOrigin; note: Note } | null {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.v !== RELAY_SCHEMA_VERSION) return null;
  const id = typeof record.id === "string" ? record.id : "";
  if (id.length === 0) return null;
  const payload = typeof record.note === "object" && record.note !== null && !Array.isArray(record.note)
    ? (record.note as Record<string, unknown>)
    : undefined;
  const topic = normalizeTopic(typeof payload?.topic === "string" ? payload.topic : "");
  if (topic.length === 0 || payload === undefined) return null;
  const ts = typeof record.ts === "number" && Number.isFinite(record.ts) ? record.ts : 0;
  const cwd = typeof record.cwd === "string" && record.cwd.length > 0 ? record.cwd : undefined;
  const sessionId = typeof record.sessionId === "string" && record.sessionId.length > 0 ? record.sessionId : undefined;
  return {
    id,
    ts,
    origin: { via: "subagent", ...(cwd ? { cwd } : {}), ...(sessionId ? { sessionId } : {}) },
    note: {
      topic,
      severity: coerceSeverity(payload.severity),
      title: typeof payload.title === "string" ? payload.title : "",
      detail: typeof payload.detail === "string" ? payload.detail : "",
    },
  };
}

// ---------------------------------------------------------------------------
// Relay endpoints (child writer + parent watcher). Both are plain Node and
// stay free of pi imports so wiring tests can exercise them directly.
// ---------------------------------------------------------------------------

/** Debounce for fs.watch-triggered rescans; bursts of events collapse into one scan. */
const RELAY_WATCH_DEBOUNCE_MS = 250;

/** Cap on the in-memory consumed-line-id set (memory guard, not correctness). */
const RELAY_CONSUMED_CAP = 1000;

/** Options for the child-side RelayWriter. */
export interface RelayWriterOptions {
  /** The shared relay directory (relayDirFor(env) at runtime; injected in tests). */
  dir: string;
  /** This child's session id: the relay file name and every line's identity prefix. */
  sessionId: string;
  /** Child working directory recorded on every line for the parent's display. */
  cwd?: string;
  /** Time source for line timestamps; defaults to Date.now (injected in tests). */
  clock?: () => number;
}

/**
 * Child side of the relay: turns real NoteStore adds into appended JSONL
 * lines. Every enqueue serializes through one promise chain (mkdir once,
 * then appendFile), so concurrent adds land in enqueue order, and every
 * failure is swallowed — the relay is best-effort transport and must never
 * reach the runtime. Notes that encodeRelayLine rejects (empty topic) are
 * skipped instead of written.
 */
export class RelayWriter {
  /** The relay directory lines are appended to. */
  readonly dir: string;
  /** This child's session id (file name stem and id prefix). */
  readonly sessionId: string;
  private readonly cwd?: string;
  private readonly clock: () => number;
  private seq = 0;
  private chain: Promise<void> = Promise.resolve();
  private directoryReady = false;

  constructor(options: RelayWriterOptions) {
    this.dir = options.dir;
    this.sessionId = options.sessionId;
    this.cwd = typeof options.cwd === "string" && options.cwd.length > 0 ? options.cwd : undefined;
    this.clock = options.clock ?? Date.now;
  }

  /** The relay file this writer appends to: `<dir>/<sessionId>.jsonl`. */
  get file(): string {
    return join(this.dir, `${this.sessionId}.jsonl`);
  }

  /**
   * Queue one note for append. Returns immediately: the encoded line joins
   * the serialized write chain, where mkdir/appendFile failures are
   * swallowed. Unusable notes (encodeRelayLine null) never consume a seq.
   */
  enqueue(note: Note): void {
    try {
      const identity = {
        id: `${this.sessionId}:${this.seq + 1}`,
        ts: this.clock(),
        cwd: this.cwd,
        sessionId: this.sessionId,
      };
      const line = encodeRelayLine(note, identity);
      if (line === null) return;
      this.seq += 1;
      this.chain = this.chain.then(async () => {
        try {
          if (!this.directoryReady) {
            await mkdir(this.dir, { recursive: true });
            this.directoryReady = true;
          }
          await appendFile(this.file, `${JSON.stringify(line)}\n`, "utf8");
        } catch {
          // quiet by design: an unwritable relay must never reach the runtime
        }
      });
    } catch {
      // quiet: enqueue itself must never throw
    }
  }
}

/** The decoded note handed to a RelayWatcher's ingest sink. */
export type IngestedNote = Note;

/** Options for the parent-side RelayWatcher. */
export interface RelayWatcherOptions {
  /** The shared relay directory to scan and watch. */
  dir: string;
  /** Ingest window: lines older than now - maxAgeMs are skipped. */
  maxAgeMs: number;
  /** Called once per freshly ingested note ({ ...note, origin }). */
  ingest: (note: IngestedNote) => void;
  /** Time source for the age window; defaults to Date.now (injected in tests). */
  clock?: () => number;
}

/**
 * Parent side of the relay: scans the shared dir for child-written JSONL
 * files and ingests fresh lines into its sink. One initial scan plus a
 * debounced fs.watch rescan; per-file byte-offset cursors (in memory) make
 * rescans incremental, and a consumed-id set (in memory, capped) keeps
 * re-reads single-shot for this watcher's lifetime. Lines outside the age
 * window are skipped, so a restart resurfaces only recent traffic — the
 * documented bounded-echo semantics. Old files are garbage-collected by
 * mtime. Nothing throws: a missing dir, corrupt lines, and watch failures
 * all degrade quietly (explicit scanNow() always remains available).
 */
export class RelayWatcher {
  private readonly dir: string;
  private readonly maxAgeMs: number;
  private readonly ingest: (note: IngestedNote) => void;
  private readonly clock: () => number;
  /** Per-file byte offset of the last fully parsed block (file name -> bytes). */
  private readonly cursors = new Map<string, number>();
  /** Line ids already ingested by this watcher (capped, in memory). */
  private readonly consumed = new Set<string>();
  private watcher: FSWatcher | null = null;
  private rescanTimer: ReturnType<typeof setTimeout> | null = null;
  private ingestedCount = 0;

  constructor(options: RelayWatcherOptions) {
    this.dir = options.dir;
    this.maxAgeMs = typeof options.maxAgeMs === "number" && Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : 0;
    this.ingest = options.ingest;
    this.clock = options.clock ?? Date.now;
  }

  /**
   * Begin watching: best-effort mkdir, the initial full scan, then a
   * debounced fs.watch. A failing watch disables watching quietly —
   * explicit scanNow() calls keep working.
   */
  async start(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
    } catch {
      // quiet: the scan still works when the dir already exists
    }
    await this.scanNow();
    try {
      this.watcher = watch(this.dir, { persistent: false }, () => this.scheduleRescan());
      this.watcher.on("error", () => this.stopWatching());
    } catch {
      this.stopWatching(); // watch unavailable: scanNow() remains the ingest path
    }
  }

  /**
   * Scan every *.jsonl file once: GC by mtime, then parse only the bytes
   * past the recorded cursor (resetting it when a file shrank). Always
   * safe to call; never throws.
   */
  async scanNow(): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((name) => name.endsWith(".jsonl")).sort();
    } catch {
      return; // no dir (yet): nothing to ingest
    }
    const now = this.clock();
    for (const name of names) {
      let stats: Stats;
      try {
        stats = await stat(join(this.dir, name));
      } catch {
        this.cursors.delete(name); // file vanished: drop its cursor
        continue;
      }
      if (now - stats.mtimeMs > RELAY_FILE_GC_MS) {
        // Garbage: the child is long gone and its notes are past every
        // parent's ingest window. Drop the cursor, unlink best-effort.
        this.cursors.delete(name);
        try {
          await unlink(join(this.dir, name));
        } catch {
          // quiet: another watcher may have unlinked it first
        }
        continue;
      }
      await this.scanFile(name, stats.mtimeMs, now);
    }
  }

  /** Stop watching: ends event-triggered rescans; explicit scanNow() stays available. */
  close(): void {
    this.stopWatching();
  }

  /** Lifetime counters: files tracked by a cursor, and notes ingested so far. */
  stats(): { files: number; ingested: number } {
    return { files: this.cursors.size, ingested: this.ingestedCount };
  }

  /** Debounced rescan entry: coalesce event bursts into one scan. */
  private scheduleRescan(): void {
    if (this.rescanTimer !== null) return;
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      void this.scanNow();
    }, RELAY_WATCH_DEBOUNCE_MS);
    this.rescanTimer.unref?.(); // never keep a process alive for a rescan
  }

  /** Tear down the fs.watch handle and any pending debounced scan, quiet. */
  private stopWatching(): void {
    if (this.rescanTimer !== null) {
      clearTimeout(this.rescanTimer);
      this.rescanTimer = null;
    }
    if (this.watcher !== null) {
      const handle = this.watcher;
      this.watcher = null;
      try {
        handle.close();
      } catch {
        // quiet: double-close races are harmless
      }
    }
  }

  /** Parse one file's fresh bytes: complete ("\n"-terminated) lines only. */
  private async scanFile(name: string, mtimeMs: number, now: number): Promise<void> {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(this.dir, name));
    } catch {
      return; // vanished mid-scan: the next scan restarts from the cursor
    }
    let offset = this.cursors.get(name) ?? 0;
    if (bytes.length < offset) offset = 0; // file shrank (recreated/truncated): start over
    if (bytes.length === offset) return; // nothing new
    const text = bytes.subarray(offset).toString("utf8");
    const cutoff = text.lastIndexOf("\n"); // advance only past fully written lines
    if (cutoff < 0) return; // a partial tail line waits for its newline
    this.cursors.set(name, offset + Buffer.byteLength(text.slice(0, cutoff + 1), "utf8"));
    for (const line of text.slice(0, cutoff).split("\n")) this.handleLine(line, mtimeMs, now);
  }

  /** Ingest one decoded line, or skip it (consumed, stale, corrupt) quiet. */
  private handleLine(text: string, mtimeMs: number, now: number): void {
    const decoded = decodeRelayLine(text);
    if (decoded === null) return; // corrupt/unknown lines are skipped, never fatal
    if (this.consumed.has(decoded.id)) return;
    // ts 0 (unparseable) falls back to the file mtime so a hand-written
    // line is still window-checked instead of unconditionally fresh.
    const ts = decoded.ts > 0 ? decoded.ts : mtimeMs;
    if (ts < now - this.maxAgeMs) return; // outside the ingest window
    if (this.consumed.size >= RELAY_CONSUMED_CAP) this.consumed.clear();
    this.consumed.add(decoded.id);
    this.ingestedCount += 1;
    try {
      this.ingest({ ...decoded.note, origin: decoded.origin });
    } catch {
      // quiet: a throwing sink must never break the scan
    }
  }
}
