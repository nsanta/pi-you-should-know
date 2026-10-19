import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RELAY_MAX_AGE_HOURS,
  DEFAULT_PRUNE_KEEP,
  DEFAULT_PRUNE_MAX_AGE_MS,
  DEFAULT_REVIEW_EVERY,
  expandTildePath,
  loadConfig,
  loadPendingNotes,
  pruneSessionNotes,
  saveDismissed,
  savePendingNotes,
} from "../src/config.ts";
import type { Note } from "../src/notes.ts";

const fakeHome = vi.hoisted(() => `/tmp/ysk-config-test-home-${process.pid}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});

const DEFAULTS = {
  reviewEvery: DEFAULT_REVIEW_EVERY,
  subagentRelay: true,
  subagentRelayMaxAgeHours: DEFAULT_RELAY_MAX_AGE_HOURS,
  dismissedTopics: [],
};

let root: string;

beforeAll(() => {
  mkdirSync(fakeHome, { recursive: true });
  root = mkdtemp("ysk-config-");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

function mkdtemp(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

describe("loadConfig", () => {
  it("returns defaults when both files are missing", async () => {
    const config = await loadConfig(join(root, "nope", "project.json"), join(root, "nope", "user.json"));
    expect(config).toEqual(DEFAULTS);
    expect(config.model).toBeUndefined();
  });

  it("skips undefined paths", async () => {
    const config = await loadConfig(undefined, undefined);
    expect(config).toEqual(DEFAULTS);
  });

  it("applies user config when no project config exists", async () => {
    const user = join(root, "user.json");
    writeJson(user, { reviewEvery: 10, model: "anthropic:claude-haiku", dismissedTopics: ["Naming"] });
    const config = await loadConfig(undefined, user);
    expect(config.reviewEvery).toBe(10);
    expect(config.model).toBe("anthropic:claude-haiku");
    expect(config.dismissedTopics).toEqual(["naming"]);
  });

  it("project config overrides user config", async () => {
    const user = join(root, "user-over.json");
    const project = join(root, "project-over.json");
    writeJson(user, { reviewEvery: 10, model: "user-model", dismissedTopics: ["a", "b"] });
    writeJson(project, { reviewEvery: 3, dismissedTopics: ["b", "c"] });
    const config = await loadConfig(project, user);
    expect(config.reviewEvery).toBe(3);
    expect(config.model).toBe("user-model");
    expect(config.dismissedTopics).toEqual(["a", "b", "c"]);
  });

  it("unions dismissedTopics across layers with normalized dedupe", async () => {
    const user = join(root, "user-union.json");
    const project = join(root, "project-union.json");
    writeJson(user, { dismissedTopics: ["API  Keys", "timeouts"] });
    writeJson(project, { dismissedTopics: ["api keys", "  Timeouts  ", "naming"] });
    const config = await loadConfig(project, user);
    expect(config.dismissedTopics).toEqual(["api keys", "timeouts", "naming"]);
  });

  it("tolerates corrupt JSON in either file", async () => {
    const user = join(root, "user-corrupt.json");
    const project = join(root, "project-corrupt.json");
    writeFileSync(user, "{ not json", "utf8");
    writeFileSync(project, "]]] garbage", "utf8");
    const config = await loadConfig(project, user);
    expect(config).toEqual(DEFAULTS);
  });

  it("falls back to user config when only the project file is corrupt", async () => {
    const user = join(root, "user-fallback.json");
    const project = join(root, "project-corrupt-only.json");
    writeJson(user, { reviewEvery: 8 });
    writeFileSync(project, "{ broken", "utf8");
    const config = await loadConfig(project, user);
    expect(config.reviewEvery).toBe(8);
  });

  it("ignores fields with invalid types", async () => {
    const project = join(root, "project-invalid.json");
    writeJson(project, {
      reviewEvery: "six",
      model: 42,
      subagentRelay: "yes",
      subagentRelayMaxAgeHours: "soon",
      dismissedTopics: "naming",
      extra: true,
    });
    const config = await loadConfig(project, undefined);
    expect(config).toEqual(DEFAULTS);
  });

  it("coerces reviewEvery to a positive integer, ignoring invalid values", async () => {
    const a = join(root, "project-floor.json");
    const b = join(root, "project-zero.json");
    writeJson(a, { reviewEvery: 7.9 });
    writeJson(b, { reviewEvery: 0 });
    expect((await loadConfig(a, undefined)).reviewEvery).toBe(7);
    expect((await loadConfig(b, undefined)).reviewEvery).toBe(DEFAULT_REVIEW_EVERY);
  });

  it("expands ~ in paths", async () => {
    writeJson(join(fakeHome, "home-config.json"), { reviewEvery: 12 });
    const config = await loadConfig("~/home-config.json", undefined);
    expect(config.reviewEvery).toBe(12);
    expect(expandTildePath("~/x/y.json")).toBe(join(fakeHome, "x", "y.json"));
    expect(expandTildePath("/plain/path.json")).toBe("/plain/path.json");
  });

  it("resolves subagentRelay: default true, project overrides user, non-boolean falls back", async () => {
    const both = join(root, "relay-both.json");
    writeJson(both, { subagentRelay: false });
    expect((await loadConfig(both, undefined)).subagentRelay).toBe(false);

    const project = join(root, "relay-project.json");
    const user = join(root, "relay-user.json");
    writeJson(project, { subagentRelay: false });
    writeJson(user, { subagentRelay: true });
    expect((await loadConfig(project, user)).subagentRelay).toBe(false); // project wins

    const invalid = join(root, "relay-invalid.json");
    writeJson(invalid, { subagentRelay: "off" });
    expect((await loadConfig(invalid, undefined)).subagentRelay).toBe(true); // strict boolean, else default
  });

  it("resolves subagentRelayMaxAgeHours: default 24, floored, minimum 1", async () => {
    const floor = join(root, "hours-floor.json");
    writeJson(floor, { subagentRelayMaxAgeHours: 7.9 });
    expect((await loadConfig(floor, undefined)).subagentRelayMaxAgeHours).toBe(7);

    const zero = join(root, "hours-zero.json");
    writeJson(zero, { subagentRelayMaxAgeHours: 0 });
    expect((await loadConfig(zero, undefined)).subagentRelayMaxAgeHours).toBe(DEFAULT_RELAY_MAX_AGE_HOURS);

    const fraction = join(root, "hours-fraction.json");
    writeJson(fraction, { subagentRelayMaxAgeHours: 0.5 });
    expect((await loadConfig(fraction, undefined)).subagentRelayMaxAgeHours).toBe(DEFAULT_RELAY_MAX_AGE_HOURS);

    const project = join(root, "hours-project.json");
    const user = join(root, "hours-user.json");
    writeJson(project, { subagentRelayMaxAgeHours: 2 });
    writeJson(user, { subagentRelayMaxAgeHours: 99 });
    expect((await loadConfig(project, user)).subagentRelayMaxAgeHours).toBe(2); // project wins
  });
});

describe("saveDismissed", () => {
  it("round-trips through loadConfig and preserves other project fields", async () => {
    const project = join(root, "nested", "dir", "project-save.json");
    writeJson(project, { reviewEvery: 4, model: "keep-me" });
    await saveDismissed(project, ["API Keys", "api keys", "naming"]);
    const onDisk = JSON.parse(await readFile(project, "utf8"));
    expect(onDisk.reviewEvery).toBe(4);
    expect(onDisk.model).toBe("keep-me");
    const config = await loadConfig(project, undefined);
    expect(config.dismissedTopics).toEqual(["api keys", "naming"]);
  });

  it("creates the project file when missing", async () => {
    const project = join(root, "fresh", "project-save.json");
    await saveDismissed(project, ["timeouts"]);
    const config = await loadConfig(project, undefined);
    expect(config.dismissedTopics).toEqual(["timeouts"]);
    expect(config.reviewEvery).toBe(DEFAULT_REVIEW_EVERY);
  });

  it("overwrites topics from a previous save", async () => {
    const project = join(root, "project-resave.json");
    await saveDismissed(project, ["one"]);
    await saveDismissed(project, ["two"]);
    const config = await loadConfig(project, undefined);
    expect(config.dismissedTopics).toEqual(["two"]);
  });
});

describe("loadPendingNotes", () => {
  it("returns [] when the file is missing, corrupt, or not an object", async () => {
    expect(await loadPendingNotes(join(root, "nope", "missing.json"))).toEqual([]);

    const corrupt = join(root, "notes-corrupt.json");
    writeFileSync(corrupt, "{ not json", "utf8");
    expect(await loadPendingNotes(corrupt)).toEqual([]);

    const array = join(root, "notes-array.json");
    writeFileSync(array, "[]", "utf8");
    expect(await loadPendingNotes(array)).toEqual([]);
  });

  it("skips undefined paths", async () => {
    expect(await loadPendingNotes(undefined)).toEqual([]);
  });

  it("round-trips notes saved by savePendingNotes, preserving order and fields", async () => {
    const path = join(root, "notes-roundtrip.json");
    const notes: Note[] = [
      { topic: "api keys", severity: "critical", title: "Hardcoded keys", detail: "src/config.ts:12" },
      { topic: "naming", severity: "warning", title: "Naming drift", detail: "" },
    ];
    await savePendingNotes(path, notes);
    expect(await loadPendingNotes(path)).toEqual(notes);
  });

  it("filters and coerces invalid entries defensively", async () => {
    const path = join(root, "notes-defensive.json");
    writeJson(path, {
      notes: [
        { topic: "api keys", severity: "critical", title: "Keep", detail: "kept" },
        { severity: "critical", title: "No topic" }, // dropped: topic missing
        { topic: "   ", severity: "info", title: "Blank topic" }, // dropped: topic empty after normalize
        "not an object", // dropped: not an object
        null, // dropped: null entry
        { topic: "Bad Severity", severity: "nope", title: "Coerced" }, // severity falls back to info
        { topic: "  Mixed   Case  ", severity: "warning" }, // topic normalized, title/detail default ""
      ],
    });
    expect(await loadPendingNotes(path)).toEqual([
      { topic: "api keys", severity: "critical", title: "Keep", detail: "kept" },
      { topic: "bad severity", severity: "info", title: "Coerced", detail: "" },
      { topic: "mixed case", severity: "warning", title: "", detail: "" },
    ]);
  });

  it("round-trips a well-formed origin and drops malformed ones", async () => {
    const path = join(root, "notes-origin.json");
    const notes: Note[] = [
      { topic: "relayed", severity: "warning", title: "Relayed", detail: "", origin: { via: "subagent", cwd: "/child/dir", sessionId: "s" } },
      { topic: "no-origin", severity: "info", title: "Local", detail: "" },
    ];
    await savePendingNotes(path, notes);
    expect(await loadPendingNotes(path)).toEqual(notes);

    const defensive = join(root, "notes-origin-defensive.json");
    writeJson(defensive, {
      notes: [
        { topic: "good", origin: { via: "subagent", cwd: "/c" } },
        { topic: "bad-via", origin: { via: "local" } },
        { topic: "bad-shape", origin: "subagent" },
        { topic: "bad-fields", origin: { via: "subagent", cwd: 42 } },
      ],
    });
    expect(await loadPendingNotes(defensive)).toEqual([
      { topic: "good", severity: "info", title: "", detail: "", origin: { via: "subagent", cwd: "/c" } },
      { topic: "bad-via", severity: "info", title: "", detail: "" },
      { topic: "bad-shape", severity: "info", title: "", detail: "" },
      { topic: "bad-fields", severity: "info", title: "", detail: "", origin: { via: "subagent" } },
    ]);
  });

  it("treats a missing or non-array notes field as empty", async () => {
    const path = join(root, "notes-bad-field.json");
    writeJson(path, { notes: "nope", dismissedTopics: ["unrelated"] });
    expect(await loadPendingNotes(path)).toEqual([]);
  });

  it("expands ~ in paths", async () => {
    const note: Note = { topic: "home topic", severity: "info", title: "", detail: "" };
    await savePendingNotes("~/ysk-home-notes.json", [note]);
    expect(await loadPendingNotes("~/ysk-home-notes.json")).toEqual([note]);
  });
});

describe("savePendingNotes", () => {
  it("writes pretty JSON with a trailing newline, creating parent dirs", async () => {
    const path = join(root, "fresh", "nested", "pending.json");
    await savePendingNotes(path, [{ topic: "timeouts", severity: "warning", title: "T", detail: "D" }]);
    const text = await readFile(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({
      notes: [{ topic: "timeouts", severity: "warning", title: "T", detail: "D" }],
    });
  });

  it("overwrites a previous save wholesale and tolerates a corrupt file", async () => {
    const path = join(root, "pending-overwrite.json");
    writeFileSync(path, "{ not json", "utf8");
    await savePendingNotes(path, [{ topic: "two", severity: "info", title: "", detail: "" }]);
    expect((await loadPendingNotes(path)).map((n) => n.topic)).toEqual(["two"]);
  });

  it("quietly skips non-string or empty paths", async () => {
    await expect(savePendingNotes(undefined as unknown as string, [])).resolves.toBeUndefined();
    await expect(savePendingNotes("", [])).resolves.toBeUndefined();
    expect(existsSync(join(fakeHome, "undefined"))).toBe(false);
  });
});

describe("pruneSessionNotes", () => {
  /**
   * Create a session-notes file in `dir` with an explicit mtime (ms epoch).
   * Returns its absolute path so tests can assert survival/deletion.
   */
  function seedNoteFile(dir: string, name: string, mtimeMs: number, content = "{}"): string {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, content, "utf8");
    const when = new Date(mtimeMs);
    utimesSync(path, when, when);
    return path;
  }

  it("keeps the most recent `keep` files and deletes older ones by count", async () => {
    const dir = mkdtemp("ysk-prune-count-");
    const base = Date.now() - 60 * 60 * 1000;
    const newest = seedNoteFile(dir, "newest.json", base);
    const recent = seedNoteFile(dir, "recent.json", base - 1000);
    const old = seedNoteFile(dir, "old.json", base - 2000);
    const oldest = seedNoteFile(dir, "oldest.json", base - 3000);
    await pruneSessionNotes(dir, { keep: 2, maxAgeMs: DEFAULT_PRUNE_MAX_AGE_MS });
    expect(existsSync(newest)).toBe(true);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(oldest)).toBe(false);
  });

  it("deletes files older than maxAgeMs even inside the keep window", async () => {
    const dir = mkdtemp("ysk-prune-age-");
    const fresh = seedNoteFile(dir, "fresh.json", Date.now());
    const stale = seedNoteFile(dir, "stale.json", Date.now() - 2 * 24 * 60 * 60 * 1000);
    await pruneSessionNotes(dir, { keep: 10, maxAgeMs: 24 * 60 * 60 * 1000 });
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  it("applies the defaults: 20 most recent kept, 14-day age cap", async () => {
    expect(DEFAULT_PRUNE_KEEP).toBe(20);
    expect(DEFAULT_PRUNE_MAX_AGE_MS).toBe(14 * 24 * 60 * 60 * 1000);
    const dir = mkdtemp("ysk-prune-defaults-");
    const base = Date.now() - 60 * 60 * 1000;
    const paths: string[] = [];
    for (let i = 0; i < 21; i += 1) paths.push(seedNoteFile(dir, `s${i}.json`, base - i * 1000));
    seedNoteFile(dir, "ancient.json", base - 15 * 24 * 60 * 60 * 1000); // old, but mtime ranks inside the keep window
    await pruneSessionNotes(dir);
    expect(existsSync(paths[0]!)).toBe(true); // newest survives
    expect(existsSync(paths[19]!)).toBe(true); // 20th newest survives
    expect(existsSync(paths[20]!)).toBe(false); // 21st newest: beyond the default keep
    expect(existsSync(join(dir, "ancient.json"))).toBe(false); // older than the default 14 days
  });

  it("skips non-.json files", async () => {
    const dir = mkdtemp("ysk-prune-nonjson-");
    const ancient = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const txt = seedNoteFile(dir, "notes.txt", ancient);
    const jsonl = seedNoteFile(dir, "child-session.jsonl", ancient);
    await pruneSessionNotes(dir, { keep: 0 }); // would delete every .json file
    expect(existsSync(txt)).toBe(true);
    expect(existsSync(jsonl)).toBe(true);
  });

  it("no-ops quietly on a missing or invalid directory", async () => {
    await expect(pruneSessionNotes(join(root, "nope", "missing-notes-dir"))).resolves.toBeUndefined();
    await expect(pruneSessionNotes("")).resolves.toBeUndefined();
  });

  it("never deletes keepPath, whatever its age or rank", async () => {
    const dir = mkdtemp("ysk-prune-keeppath-");
    const current = seedNoteFile(dir, "current-session.json", Date.now() - 30 * 24 * 60 * 60 * 1000); // oldest AND stale
    const other = seedNoteFile(dir, "other.json", Date.now());
    await pruneSessionNotes(dir, { keep: 1, maxAgeMs: 24 * 60 * 60 * 1000, keepPath: current });
    expect(existsSync(current)).toBe(true); // survives both prune reasons
    expect(existsSync(other)).toBe(true);
  });

  it("tolerates unreadable and non-file .json entries quietly", async () => {
    const dir = mkdtemp("ysk-prune-unreadable-");
    seedNoteFile(dir, "kept.json", Date.now());
    mkdirSync(join(dir, "subdir.json"), { recursive: true }); // stat succeeds, not a file -> skipped
    const dangling = join(dir, "dangling.json");
    symlinkSync(join(dir, "nope"), dangling); // stat fails (ENOENT) -> skipped
    await expect(pruneSessionNotes(dir)).resolves.toBeUndefined();
    expect(existsSync(join(dir, "kept.json"))).toBe(true);
    expect(existsSync(join(dir, "subdir.json"))).toBe(true);
    expect(readdirSync(dir).includes("dangling.json")).toBe(true); // existsSync reads through the symlink
  });
});
