/**
 * Config loading/saving for you-should-know.
 *
 * Config lives in two JSON files: a user-level file and a project-level file.
 * Project values override user values; `dismissedTopics` is a union of both.
 * Missing files, missing fields, and corrupt JSON are all tolerated: the
 * affected layer simply contributes nothing and defaults stand in.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { coerceSeverity, normalizeTopic, type Note } from "./notes.ts";
import { parseOrigin } from "./relay.ts";

/** Review cadence default: run the background reviewer every N tool steps. */
export const DEFAULT_REVIEW_EVERY = 6;

/** Subagent relay default ingest window, in hours. */
export const DEFAULT_RELAY_MAX_AGE_HOURS = 24;

/** Fully resolved extension configuration. */
export interface YskConfig {
  /** Run the background reviewer every N completed tool steps (>= 1). */
  reviewEvery: number;
  /** Optional model override for the nested reviewer call. */
  model?: string;
  /** Relay subagent notes: the child writes them out, the parent ingests them. Default true. */
  subagentRelay: boolean;
  /** Ingest window for relayed notes, in hours (floored integer, minimum 1). Default 24. */
  subagentRelayMaxAgeHours: number;
  /** Permanently dismissed topics (normalized), union of user + project. */
  dismissedTopics: string[];
}

/**
 * Expand a leading `~` to the user's home directory. Plain `~` and `~/...`
 * forms are expanded; anything else (including undefined) is returned as-is.
 */
export function expandTildePath(path: string | undefined): string | undefined {
  if (typeof path !== "string" || path.length === 0) return path;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return joinHome(path.slice(2));
  return path;
}

function joinHome(rest: string): string {
  const home = homedir();
  return home.endsWith("/") ? `${home}${rest}` : `${home}/${rest}`;
}

/**
 * Load and merge user + project configuration. Both paths are optional and
 * may start with `~`. Never throws on unreadable or corrupt files: such a
 * file is treated as absent.
 */
export async function loadConfig(projectPath?: string, userPath?: string): Promise<YskConfig> {
  const user = await readLayer(expandTildePath(userPath));
  const project = await readLayer(expandTildePath(projectPath));

  const reviewEvery = pickReviewEvery(project.get("reviewEvery"), user.get("reviewEvery"));
  const model = pickModel(project.get("model"), user.get("model"));
  const subagentRelay = pickBoolean(DEFAULT_RELAY_ENABLED, project.get("subagentRelay"), user.get("subagentRelay"));
  const subagentRelayMaxAgeHours = pickHours(
    project.get("subagentRelayMaxAgeHours"),
    user.get("subagentRelayMaxAgeHours"),
  );
  const dismissedTopics = unionTopics([...readTopics(user), ...readTopics(project)]);

  return { reviewEvery, ...(model !== undefined ? { model } : {}), subagentRelay, subagentRelayMaxAgeHours, dismissedTopics };
}

/**
 * Persist the permanently dismissed topics into the project config file,
 * preserving any other fields already present. Creates the file (and its
 * parent directory) when missing. Topics are normalized and deduped.
 */
export async function saveDismissed(projectPath: string, topics: string[]): Promise<void> {
  const path = expandTildePath(projectPath);
  if (typeof path !== "string" || path.length === 0) return;

  const existing = await readRawObject(path);
  const next = {
    ...existing,
    dismissedTopics: unionTopics(Array.isArray(topics) ? topics : []),
  };
  const json = `${JSON.stringify(next, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, json, "utf8");
}

/**
 * Load the pending notes persisted for a project from a state file written
 * by savePendingNotes (`{ "notes": [...] }`, oldest first). Missing,
 * corrupt, or non-object files are treated as empty, and every entry is
 * validated defensively: entries must be objects with a non-empty topic
 * (normalized); severity falls back to "info" and missing title/detail
 * become empty strings. Invalid entries are skipped, never fatal.
 */
export async function loadPendingNotes(path?: string): Promise<Note[]> {
  const raw = await readRawObject(expandTildePath(path));
  const entries = raw.notes;
  if (!Array.isArray(entries)) return [];

  const notes: Note[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.topic !== "string") continue;
    const topic = normalizeTopic(record.topic);
    if (topic.length === 0) continue;
    const origin = parseOrigin(record.origin);
    notes.push({
      topic,
      severity: coerceSeverity(record.severity),
      title: typeof record.title === "string" ? record.title : "",
      detail: typeof record.detail === "string" ? record.detail : "",
      ...(origin !== undefined ? { origin } : {}),
    });
  }
  return notes;
}

/**
 * Persist the pending notes for a project into a state file as pretty JSON
 * with a trailing newline (`{ "notes": [...] }`, oldest first), creating
 * the file (and its parent directory) when missing. The write replaces the
 * previous content wholesale: notes removed from the pending store are
 * simply absent afterwards. Non-string/empty paths are skipped quietly;
 * real write errors propagate so the caller can fail quiet.
 */
export async function savePendingNotes(path: string, notes: Note[]): Promise<void> {
  const resolved = expandTildePath(path);
  if (typeof resolved !== "string" || resolved.length === 0) return;

  const json = `${JSON.stringify({ notes: Array.isArray(notes) ? notes : [] }, null, 2)}\n`;
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, json, "utf8");
}

/** Read one config file into a permissive field map; absent/corrupt => empty. */
async function readLayer(path: string | undefined): Promise<Map<string, unknown>> {
  const raw = await readRawObject(path);
  return new Map(Object.entries(raw));
}

/** Parse a JSON file into a plain object; missing/corrupt/non-object => {}. */
async function readRawObject(path: string | undefined): Promise<Record<string, unknown>> {
  if (!path) return {};
  try {
    const text = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Default subagent relay switch. */
const DEFAULT_RELAY_ENABLED = true;

/**
 * Resolve reviewEvery: project overrides user; must be a finite number >= 1
 * (floored to an integer); otherwise the default applies.
 */
function pickReviewEvery(...candidates: unknown[]): number {
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 1) {
      return Math.floor(candidate);
    }
  }
  return DEFAULT_REVIEW_EVERY;
}

/**
 * Resolve a boolean: project overrides user; only strict true/false count —
 * anything else (strings, numbers, null) falls through to the next
 * candidate, then the default.
 */
function pickBoolean(fallback: boolean, ...candidates: unknown[]): boolean {
  for (const candidate of candidates) {
    if (typeof candidate === "boolean") return candidate;
  }
  return fallback;
}

/**
 * Resolve an hours value: project overrides user; must be a finite number
 * >= 1, floored to an integer; otherwise the default applies.
 */
function pickHours(...candidates: unknown[]): number {
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 1) {
      return Math.floor(candidate);
    }
  }
  return DEFAULT_RELAY_MAX_AGE_HOURS;
}

/** Resolve model: project overrides user; must be a non-empty string. */
function pickModel(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return undefined;
}

/** Collect valid string topics, normalized; non-strings and empties are dropped. */
function readTopics(layer: Map<string, unknown>): string[] {
  const value = layer.get("dismissedTopics");
  if (!Array.isArray(value)) return [];
  return value.filter((topic): topic is string => typeof topic === "string").map(normalizeTopic);
}

/** Dedupe normalized topics, dropping empties, preserving first-seen order. */
function unionTopics(topics: string[]): string[] {
  const seen = new Set<string>();
  for (const topic of topics) {
    const key = normalizeTopic(topic);
    if (key.length > 0) seen.add(key);
  }
  return [...seen];
}
