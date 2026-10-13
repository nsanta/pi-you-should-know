import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_REVIEW_EVERY, expandTildePath, loadConfig, saveDismissed } from "../src/config.ts";

const fakeHome = vi.hoisted(() => `/tmp/ysk-config-test-home-${process.pid}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});

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
    expect(config).toEqual({ reviewEvery: DEFAULT_REVIEW_EVERY, dismissedTopics: [] });
    expect(config.model).toBeUndefined();
  });

  it("skips undefined paths", async () => {
    const config = await loadConfig(undefined, undefined);
    expect(config).toEqual({ reviewEvery: DEFAULT_REVIEW_EVERY, dismissedTopics: [] });
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
    expect(config).toEqual({ reviewEvery: DEFAULT_REVIEW_EVERY, dismissedTopics: [] });
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
      dismissedTopics: "naming",
      extra: true,
    });
    const config = await loadConfig(project, undefined);
    expect(config).toEqual({ reviewEvery: DEFAULT_REVIEW_EVERY, dismissedTopics: [] });
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
