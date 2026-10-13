/**
 * heads_up: the agent-invocable note tool for you-should-know.
 *
 * Routes a note through the SAME NoteStore pipeline as background reviews:
 * the topic is derived from the note text (first-line prefix, normalized)
 * so the schema stays minimal, and dedupe/cap/dismissal semantics belong to
 * the store. The tool never throws for bad input; it returns an isError
 * result instead so the model sees a failure while the session stays calm.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { coerceSeverity, normalizeTopic, type Note, type NoteStore, type Severity } from "./notes.ts";

export const HEADS_UP_TOOL_NAME = "heads_up";

/** Topic identity cap: first line of the note, normalized, then truncated. */
export const TOPIC_MAX_CHARS = 80;

/** Display-title cap; longer than the topic cap so titles stay readable. */
export const TITLE_MAX_CHARS = 120;

function firstLine(note: string): string {
  return (note.trim().split(/\r?\n/, 1)[0] ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Derive the note topic from the note text: the first line, whitespace-
 * collapsed, lowercased via normalizeTopic, and capped at TOPIC_MAX_CHARS
 * so topics stay stable identities for dedupe and dismissal.
 */
export function deriveTopic(note: string): string {
  if (typeof note !== "string") return "";
  const line = firstLine(note);
  if (line.length === 0) return "";
  return normalizeTopic(line.slice(0, TOPIC_MAX_CHARS));
}

/** Derive the human-readable title: the first line, capped at TITLE_MAX_CHARS. */
export function deriveTitle(note: string): string {
  if (typeof note !== "string") return "";
  return firstLine(note).slice(0, TITLE_MAX_CHARS);
}

/** Register the heads_up tool against the shared pending-note store. */
export function registerHeadsUpTool(pi: ExtensionAPI, store: NoteStore): void {
  pi.registerTool({
    name: HEADS_UP_TOOL_NAME,
    label: "Heads-up note",
    description:
      "Record a 'you should know' note about a hidden decision, silent assumption, or " +
      "architectural blind spot from this conversation. Notes surface as a non-blocking " +
      "HUD widget above the user's prompt; they are NOT added to the conversation context. " +
      "Use it when you notice the user may be unaware of something important.",
    promptSnippet: "Surface a 'you should know' note to the user via the HUD widget",
    promptGuidelines: [
      "Use heads_up sparingly for genuinely hidden decisions, silent assumptions, or blind spots the user should be aware of.",
    ],
    parameters: Type.Object({
      note: Type.String({
        minLength: 1,
        description: "The note text: what the user should know and why (1-4 sentences). The first line becomes the topic.",
      }),
      severity: Type.Optional(
        Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("critical")], {
          default: "info",
          description: "How urgent the note is. Default: info.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const noteText = typeof params?.note === "string" ? params.note : "";
        const topic = deriveTopic(noteText);
        if (topic.length === 0) {
          return errorResult("heads_up requires a non-empty note (the first line becomes the topic).");
        }
        const severity: Severity = coerceSeverity(params?.severity);
        const note: Note = {
          topic,
          severity,
          title: deriveTitle(noteText) || topic,
          detail: noteText.trim(),
        };
        const added = store.add(note);
        const text = added
          ? `Recorded heads-up note (${severity}): ${note.title}`
          : `A pending note with this topic already exists; not duplicated: ${note.title}`;
        return { content: [{ type: "text" as const, text }], details: { topic, severity, added } };
      } catch (error) {
        return errorResult(`heads_up failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}

/** Failure result: the model sees an error; the runtime sees no throw. */
function errorResult(text: string): { content: { type: "text"; text: string }[]; details: { error: string }; isError: true } {
  return { content: [{ type: "text", text }], details: { error: text }, isError: true };
}
