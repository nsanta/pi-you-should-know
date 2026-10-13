import { describe, expect, it, vi } from "vitest";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import {
  buildDigest,
  buildReviewerPrompt,
  DEFAULT_DIGEST_OPTIONS,
  MAX_NOTES_PER_REVIEW,
  parseNotes,
  runReviewer,
} from "../src/reviewer.ts";
import type { Note } from "../src/notes.ts";

let nextId = 0;

function msgEntry(message: Record<string, unknown>): SessionMessageEntry {
  nextId += 1;
  return {
    type: "message",
    id: `e${nextId}`,
    parentId: null,
    timestamp: "2026-02-14T00:00:00Z",
    message,
  } as unknown as SessionMessageEntry;
}

function entryOf(base: Record<string, unknown>): SessionEntry {
  nextId += 1;
  return {
    id: `e${nextId}`,
    parentId: null,
    timestamp: "2026-02-14T00:00:00Z",
    ...base,
  } as unknown as SessionEntry;
}

function userMessage(content: string): Record<string, unknown> {
  return { role: "user", content, timestamp: 1 };
}

function assistantMessage(text: string): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude",
    usage: {},
    stopReason: "stop",
    timestamp: 2,
  };
}

function toolResultMessage(text: string): Record<string, unknown> {
  return {
    role: "toolResult",
    toolCallId: "t1",
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 3,
  };
}

describe("buildDigest", () => {
  it("renders conversation entries with role labels", () => {
    const digest = buildDigest([
      msgEntry(userMessage("Switch the parser to streaming")),
      msgEntry(assistantMessage("Agreed, I will use an event stream.")),
      msgEntry(toolResultMessage("file contents here")),
      entryOf({ type: "compaction", summary: "Earlier: chose vitest.", firstKeptEntryId: "e1", tokensBefore: 900 }),
      entryOf({ type: "branch_summary", fromId: "e0", summary: "Branch from main." }),
      entryOf({ type: "custom_message", customType: "ysk:note", content: "Custom text", display: true }),
    ]);
    expect(digest).toContain("[user] Switch the parser to streaming");
    expect(digest).toContain("[assistant] Agreed, I will use an event stream.");
    expect(digest).toContain("[tool:read] file contents here");
    expect(digest).toContain("[summary] Earlier: chose vitest.");
    expect(digest).toContain("[summary] Branch from main.");
    expect(digest).toContain("[custom:ysk:note] Custom text");
  });

  it("skips non-conversational entries and messages without text", () => {
    const digest = buildDigest([
      entryOf({ type: "thinking_level_change", thinkingLevel: "high" }),
      entryOf({ type: "model_change", provider: "anthropic", modelId: "claude" }),
      entryOf({ type: "usage", kind: "cache_warm", provider: "anthropic", model: "claude", usage: {} }),
      entryOf({ type: "label", targetId: "e1", label: "keep" }),
      entryOf({ type: "session_info", name: "my session" }),
      entryOf({ type: "custom", customType: "ysk:state", data: { hidden: true } }),
      msgEntry({ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }], timestamp: 4 }),
    ]);
    expect(digest).toBe("");
  });

  it("keeps only the newest entries within maxEntries", () => {
    const entries = Array.from({ length: 10 }, (_, i) => msgEntry(userMessage(`message ${i}`)));
    const digest = buildDigest(entries, { maxEntries: 3 });
    expect(digest).toContain("message 9");
    expect(digest).toContain("message 8");
    expect(digest).toContain("message 7");
    expect(digest).not.toContain("message 6");
  });

  it("truncates oversized entries with an explicit marker", () => {
    const long = "x".repeat(200);
    const digest = buildDigest([msgEntry(userMessage(long))], { maxEntryChars: 50 });
    expect(digest.length).toBeLessThan(long.length);
    expect(digest).toContain("…[truncated]");
  });

  it("enforces the total character cap by dropping the oldest entries first", () => {
    const entries = Array.from({ length: 20 }, (_, i) => msgEntry(userMessage(`m${i} ${"y".repeat(40)}`)));
    const digest = buildDigest(entries, {
      maxEntries: DEFAULT_DIGEST_OPTIONS.maxEntries,
      maxTotalChars: 300,
    });
    expect(digest.length).toBeLessThanOrEqual(300 + "[... N earlier entries omitted]".length);
    expect(digest).toContain("earlier entries omitted");
    expect(digest).toContain("m19");
    expect(digest).not.toContain("m0 ");
  });

  it("returns an empty string for empty or unusable input", () => {
    expect(buildDigest([])).toBe("");
    expect(buildDigest(undefined as unknown as SessionEntry[])).toBe("");
  });
});

describe("buildReviewerPrompt", () => {
  const { systemPrompt, userMessage } = buildReviewerPrompt("DIGEST TEXT");

  it("demands the strict JSON output contract in the system prompt", () => {
    expect(systemPrompt).toContain("JSON array");
    expect(systemPrompt).toContain("max 2");
    expect(systemPrompt).toContain("topic");
    expect(systemPrompt).toContain("severity");
    expect(systemPrompt).toContain("title");
    expect(systemPrompt).toContain("detail");
    expect(systemPrompt).toContain("info");
    expect(systemPrompt).toContain("warning");
    expect(systemPrompt).toContain("critical");
    expect(systemPrompt).toContain("[]");
  });

  it("places the digest in the user message", () => {
    expect(userMessage).toContain("DIGEST TEXT");
  });
});

describe("parseNotes", () => {
  it("parses a valid JSON array of notes", () => {
    const raw = JSON.stringify([
      { topic: "api keys", severity: "warning", title: "Hardcoded keys", detail: "In config." },
      { topic: "naming", severity: "info", title: "Naming drift", detail: "Mixed styles." },
    ]);
    expect(parseNotes(raw)).toHaveLength(2);
  });

  it("parses notes wrapped in code fences", () => {
    const raw = "```json\n" + JSON.stringify([{ topic: "t", severity: "critical", title: "T", detail: "D" }]) + "\n```";
    const notes = parseNotes(raw);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toEqual({ topic: "t", severity: "critical", title: "T", detail: "D" });
  });

  it("parses notes wrapped in leading and trailing prose", () => {
    const raw = 'Here you go:\n[{"topic":"t","severity":"info","title":"T","detail":"D"}]\nHope that helps!';
    expect(parseNotes(raw)).toHaveLength(1);
  });

  it("wraps a single bare object into a list", () => {
    expect(parseNotes('{"topic":"t","severity":"warning","title":"T","detail":"D"}')).toHaveLength(1);
  });

  it("drops invalid items but keeps valid ones", () => {
    const raw = JSON.stringify([
      "not an object",
      42,
      null,
      [],
      { title: "no topic" },
      { topic: "   " },
      { topic: "good", severity: "nope", title: "T", detail: "D" },
    ]);
    const notes = parseNotes(raw);
    expect(notes).toEqual([{ topic: "good", severity: "info", title: "T", detail: "D" }]);
  });

  it("normalizes unknown or missing severity to info", () => {
    const raw = JSON.stringify([
      { topic: "a", severity: "catastrophic", title: "A", detail: "x" },
      { topic: "b", title: "B", detail: "x" },
    ]);
    expect(parseNotes(raw).map((n) => n.severity)).toEqual(["info", "info"]);
  });

  it("applies the skipTopic filter on normalized topics", () => {
    const raw = JSON.stringify([
      { topic: "API  Keys", severity: "warning", title: "K", detail: "d" },
      { topic: "naming", severity: "info", title: "N", detail: "d" },
    ]);
    const notes = parseNotes(raw, { skipTopic: (topic) => topic === "api keys" });
    expect(notes.map((n) => n.topic)).toEqual(["naming"]);
  });

  it("never throws on unusable output", () => {
    expect(parseNotes("")).toEqual([]);
    expect(parseNotes("The model declined to answer.")).toEqual([]);
    expect(parseNotes("[1, 2, 3]")).toEqual([]);
    expect(parseNotes('{"unrelated": true}')).toEqual([]);
    expect(parseNotes("[{broken")).toEqual([]);
    expect(parseNotes(undefined as unknown as string)).toEqual([]);
  });
});

describe("runReviewer", () => {
  const digest = buildDigest([msgEntry(userMessage("We store secrets in src/config.ts now."))]);

  function noteOf(topic: string): Note {
    return { topic, severity: "info", title: `${topic} title`, detail: "d" };
  }

  it("sends the reviewer request through the injected stream and returns notes", async () => {
    const stream = vi.fn().mockResolvedValue(
      JSON.stringify([
        { topic: "secrets", severity: "critical", title: "Secrets in code", detail: "config.ts" },
      ]),
    );
    const notes = await runReviewer(digest, { stream });
    expect(notes).toEqual([{ topic: "secrets", severity: "critical", title: "Secrets in code", detail: "config.ts" }]);
    expect(stream).toHaveBeenCalledTimes(1);
    const request = stream.mock.calls[0]?.[0];
    expect(request.systemPrompt).toContain("JSON array");
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]?.role).toBe("user");
    expect(request.messages[0]?.content).toContain("secrets in src/config.ts");
  });

  it("caps results at the maximum notes per review", async () => {
    const stream = vi.fn().mockResolvedValue(
      JSON.stringify([1, 2, 3].map((i) => ({ topic: `t${i}`, severity: "info", title: `T${i}`, detail: "d" }))),
    );
    const notes = await runReviewer(digest, { stream });
    expect(notes).toHaveLength(MAX_NOTES_PER_REVIEW);
  });

  it("filters dismissed topics via skipTopic", async () => {
    const stream = vi.fn().mockResolvedValue(
      JSON.stringify([
        { topic: "secrets", severity: "warning", title: "S", detail: "d" },
        { topic: "naming", severity: "info", title: "N", detail: "d" },
      ]),
    );
    const notes = await runReviewer(digest, { stream, skipTopic: (topic) => topic === "secrets" });
    expect(notes.map((n) => n.topic)).toEqual(["naming"]);
  });

  it("does not call the model when the digest is empty", async () => {
    const stream = vi.fn();
    await expect(runReviewer("", { stream })).resolves.toEqual([]);
    expect(stream).not.toHaveBeenCalled();
  });

  it("returns no notes when the response is unusable", async () => {
    const stream = vi.fn().mockResolvedValue("Sorry, I cannot comply.");
    await expect(runReviewer(digest, { stream })).resolves.toEqual([]);
  });

  it("propagates stream rejections to the caller", async () => {
    const stream = vi.fn().mockRejectedValue(new Error("provider down"));
    await expect(runReviewer(digest, { stream })).rejects.toThrow("provider down");
  });
});
