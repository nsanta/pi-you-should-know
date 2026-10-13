/**
 * Background reviewer core for you-should-know.
 *
 * Pure-ish building blocks plus a thin, fully-injected model boundary:
 *
 * - buildDigest: bounded transcript digest from pi session branch entries.
 * - buildReviewerPrompt: strict system/user prompt pair for the reviewer.
 * - parseNotes: strict-but-tolerant parser for the reviewer's JSON output.
 * - runReviewer: composes the above and delegates the model call to the
 *   injected `stream` dependency, so tests use fakes and T5 wiring adapts
 *   `ctx.modelRegistry.streamSimple()`.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { coerceSeverity, normalizeTopic, type Note } from "./notes.ts";

/** Digest bounds. Entries render newest-last; older entries are dropped first. */
export interface DigestOptions {
  /** Keep at most this many (newest) entries. */
  maxEntries?: number;
  /** Truncate each rendered entry to this many characters. */
  maxEntryChars?: number;
  /** Hard cap for the whole digest; oldest entries are dropped to fit. */
  maxTotalChars?: number;
}

/** Default digest bounds: a tail that stays well within a cheap side call. */
export const DEFAULT_DIGEST_OPTIONS: Required<DigestOptions> = {
  maxEntries: 40,
  maxEntryChars: 500,
  maxTotalChars: 6000,
};

const ENTRY_TRUNCATED_MARKER = "…[truncated]";
const OMITTED_MARKER = "[...";

/** User-message shape for the reviewer request (pi-ai `UserMessage`-compatible). */
export interface ReviewerUserMessage {
  role: "user";
  content: string;
  timestamp: number;
}

/**
 * Request handed to the injected stream function. Structurally compatible
 * with the pi-ai `Context` accepted by `ModelRegistry.streamSimple()`, so the
 * T5 adapter can forward it as-is.
 */
export interface ReviewerRequest {
  systemPrompt: string;
  messages: ReviewerUserMessage[];
}

/** Model-call boundary injected into runReviewer; rejections propagate upward. */
export interface ReviewerDeps {
  stream: (request: ReviewerRequest) => Promise<string>;
  /** Return true to drop a (normalized) topic, e.g. dismissed or seen. */
  skipTopic?: (topic: string) => boolean;
}

/** Maximum notes a single review may contribute. */
export const MAX_NOTES_PER_REVIEW = 2;

/**
 * Build a bounded transcript digest from pi session branch entries.
 *
 * Only conversation-relevant entries render (user/assistant/toolResult
 * messages, compaction + branch summaries, custom messages); the rest are
 * skipped. Bounds are enforced in three layers: newest-first entry selection,
 * per-entry truncation with an explicit marker, and a total-character cap
 * that drops oldest entries first behind an omission marker. Never throws.
 */
export function buildDigest(entries: SessionEntry[], options: DigestOptions = {}): string {
  if (!Array.isArray(entries)) return "";
  const opts = resolveOptions(options);

  const rendered: string[] = [];
  for (const entry of entries.slice(-opts.maxEntries)) {
    const line = renderEntry(entry);
    if (line === undefined) continue;
    rendered.push(truncateEntry(line, opts.maxEntryChars));
  }
  if (rendered.length === 0) return "";

  let omitted = 0;
  let digest = rendered.join("\n\n");
  while (digest.length > opts.maxTotalChars && rendered.length > 1) {
    rendered.shift();
    omitted += 1;
    digest = rendered.join("\n\n");
  }
  if (digest.length > opts.maxTotalChars) {
    digest = digest.slice(0, opts.maxTotalChars) + ENTRY_TRUNCATED_MARKER;
  }
  if (omitted > 0) {
    digest = `${OMITTED_MARKER} ${omitted} earlier entries omitted]\n\n${digest}`;
  }
  return digest;
}

/**
 * Build the reviewer prompt pair from a digest. The system prompt demands a
 * STRICT output contract: a JSON array with at most 2 objects, each exactly
 * `{ topic, severity, title, detail }`, severity in info|warning|critical,
 * and `[]` when nothing notable. The digest rides in the user message.
 */
export function buildReviewerPrompt(digest: string): { systemPrompt: string; userMessage: string } {
  const systemPrompt = [
    "You are a quiet background reviewer for a coding agent session.",
    "You look for hidden decisions, silent assumptions, and architectural blind spots that the user may not be aware of.",
    "",
    "Output contract — follow it EXACTLY:",
    "- Respond with ONLY a JSON array. No prose, no markdown fences.",
    "- Include max 2 objects in the array.",
    "- Each object has exactly these keys: topic, severity, title, detail.",
    "- topic: short stable identifier for the concern (lowercase, few words).",
    "- severity: one of info, warning, critical.",
    "- title: one-line human-readable summary.",
    "- detail: 1-3 sentences with the specifics.",
    "- When there is nothing notable, respond with [].",
  ].join("\n");

  const userMessage = [
    "Review this transcript digest for hidden decisions, silent assumptions, and blind spots.",
    "Apply the output contract exactly; respond with [] when nothing is notable.",
    "",
    "Transcript digest:",
    digest,
  ].join("\n");

  return { systemPrompt, userMessage };
}

/**
 * Parse reviewer output into notes. Tolerates plain arrays, a single bare
 * object, code fences, and leading/trailing prose. Invalid or malformed items
 * are dropped; unknown/missing severity falls back to "info"; `skipTopic`
 * filters on normalized topics. Never throws.
 */
export function parseNotes(raw: string, options: { skipTopic?: (topic: string) => boolean } = {}): Note[] {
  if (typeof raw !== "string") return [];
  const items = extractJsonItems(stripFences(raw.trim()));
  if (items.length === 0) return [];

  const notes: Note[] = [];
  for (const item of items) {
    const note = toNote(item);
    if (note === undefined) continue;
    if (options.skipTopic?.(note.topic)) continue;
    notes.push(note);
  }
  return notes;
}

/**
 * Run one background review: build the prompt from the digest, call the
 * injected stream, and parse the response defensively.
 *
 * - An empty digest short-circuits to [] without calling the model.
 * - Stream rejections propagate to the caller (T5 handles quiet failure).
 * - Results are capped at MAX_NOTES_PER_REVIEW even if the model overshoots.
 */
export async function runReviewer(digest: string, deps: ReviewerDeps): Promise<Note[]> {
  if (typeof digest !== "string" || digest.trim().length === 0) return [];

  const { systemPrompt, userMessage } = buildReviewerPrompt(digest);
  const request: ReviewerRequest = {
    systemPrompt,
    messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
  };
  const raw = await deps.stream(request);
  return parseNotes(raw, { skipTopic: deps.skipTopic }).slice(0, MAX_NOTES_PER_REVIEW);
}

function resolveOptions(options: DigestOptions): Required<DigestOptions> {
  return {
    maxEntries: positiveInt(options.maxEntries, DEFAULT_DIGEST_OPTIONS.maxEntries),
    maxEntryChars: positiveInt(options.maxEntryChars, DEFAULT_DIGEST_OPTIONS.maxEntryChars),
    maxTotalChars: positiveInt(options.maxTotalChars, DEFAULT_DIGEST_OPTIONS.maxTotalChars),
  };
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

/** Render one session entry to a labeled digest line, or undefined to skip. */
function renderEntry(entry: SessionEntry): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;

  if (entry.type === "message") {
    const message = (entry as { message?: unknown }).message;
    return renderMessage(message);
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    const summary = (entry as { summary?: unknown }).summary;
    return typeof summary === "string" && summary.trim().length > 0 ? `[summary] ${summary.trim()}` : undefined;
  }
  if (entry.type === "custom_message") {
    const customType = String((entry as { customType?: unknown }).customType ?? "custom");
    const content = (entry as { content?: unknown }).content;
    const text = contentText(content);
    return text.length > 0 ? `[custom:${customType}] ${text}` : undefined;
  }
  return undefined;
}

/** Render a session message by role; unknown roles and empty text are skipped. */
function renderMessage(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const role = (message as { role?: unknown }).role;
  const content = (message as { content?: unknown }).content;
  const text = contentText(content);
  if (text.length === 0) return undefined;

  if (role === "user") return `[user] ${text}`;
  if (role === "assistant") return `[assistant] ${text}`;
  if (role === "toolResult") {
    const toolName = String((message as { toolName?: unknown }).toolName ?? "tool");
    return `[tool:${toolName}] ${text}`;
  }
  if (role === "system") return `[system] ${text}`;
  return undefined;
}

/** Extract plain text from string content or an array of typed content parts. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    if ((part as { type?: unknown }).type !== "text") continue;
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string" && text.trim().length > 0) parts.push(text.trim());
  }
  return parts.join("\n");
}

function truncateEntry(line: string, maxEntryChars: number): string {
  if (line.length <= maxEntryChars) return line;
  return line.slice(0, maxEntryChars) + ENTRY_TRUNCATED_MARKER;
}

/** Remove a leading/trailing markdown code fence, if present. */
function stripFences(text: string): string {
  const fenced = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?\s*```$/;
  const match = text.match(fenced);
  return match ? match[1] : text;
}

/**
 * Pull candidate JSON items out of possibly-noisy text: try the whole text,
 * then the first `[...]` span, then the first `{...}` span.
 */
function extractJsonItems(text: string): unknown[] {
  for (const candidate of candidateSpans(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === "object" && parsed !== null) return [parsed];
  }
  return [];
}

function candidateSpans(text: string): string[] {
  const candidates = [text];
  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) candidates.push(text.slice(arrayStart, arrayEnd + 1));
  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) candidates.push(text.slice(objectStart, objectEnd + 1));
  return candidates;
}

/** Validate one parsed item into a Note; returns undefined for malformed items. */
function toNote(item: unknown): Note | undefined {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
  const record = item as Record<string, unknown>;

  const topic = typeof record.topic === "string" ? normalizeTopic(record.topic) : "";
  if (topic.length === 0) return undefined;

  const title = typeof record.title === "string" ? record.title.trim() : "";
  const detail = typeof record.detail === "string" ? record.detail.trim() : "";
  return { topic, severity: coerceSeverity(record.severity), title, detail };
}
