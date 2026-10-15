/**
 * Shared note types and the pending-note store for you-should-know.
 *
 * The store is deliberately pure-ish: persistence is injected via callbacks
 * so callers decide how and where to save — permanently dismissed topics
 * via `persistDismissed` and the pending list via `persistPending` (see
 * config.saveDismissed / config.savePendingNotes). All topic matching is
 * done on normalized topics.
 */

import { parseOrigin, type NoteOrigin } from "./relay.ts";

/** Severity of a "you should know" note. Unknown severities normalize to "info". */
export type Severity = "info" | "warning" | "critical";

/** A single background-review finding, ready to surface above the prompt. */
export interface Note {
  /** Normalized identity of the finding; used for dedupe and dismissal. */
  topic: string;
  severity: Severity;
  title: string;
  detail: string;
  /**
   * Where the note came from: absent for session-local notes (reviewer and
   * heads_up findings raised in this process), set only by the relay
   * ingester for notes relayed from subagent children, and round-tripped
   * through the notes file so a restored note keeps its subagent marker.
   */
  origin?: NoteOrigin;
}

/** Maximum number of pending notes kept/shown at once. */
export const PENDING_CAP = 3;

const SEVERITIES: readonly Severity[] = ["info", "warning", "critical"];

/**
 * Normalize a topic for dedupe and dismissal matching: trim, collapse
 * internal whitespace to single spaces, and lowercase. Non-string input
 * normalizes to "" (defensive; callers pre-validate).
 */
export function normalizeTopic(topic: string): string {
  if (typeof topic !== "string") return "";
  return topic.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Check a raw severity value against the known set; anything else falls back
 * to "info" so a misbehaving model can never break rendering.
 */
export function coerceSeverity(value: unknown): Severity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value)
    ? (value as Severity)
    : "info";
}

/** Options for constructing a NoteStore. */
export interface NoteStoreOptions {
  /** Max pending notes; oldest is evicted beyond this. Defaults to PENDING_CAP. */
  capacity?: number;
  /**
   * Called after every permanent dismissal with the full normalized dismissed
   * list, so the caller can persist it (see config.saveDismissed).
   */
  persistDismissed?: (topics: string[]) => void;
  /**
   * Called exactly once at the end of every public mutation with the full
   * current pending list (oldest first), so the caller can persist it (see
   * config.savePendingNotes). Mutations that change the pending list always
   * fire: add (real adds only), replacePending (only when the resulting
   * list differs), dismissSession (removals only), clearPending (only when
   * items were dropped). dismissPermanently always fires too — even when it
   * removes nothing from pending — so the persisted list always reflects
   * the current pending store. Remaining no-ops (duplicate adds,
   * unknown-topic dismissals, clearing an already-empty list, replacing a
   * list with itself) never fire.
   */
  persistPending?: (notes: Note[]) => void;
  /**
   * Fired on REAL adds only — add() when the note actually lands, never on
   * replacePending() (and never for duplicate adds) — so the relay writer
   * mirrors genuinely new notes while restore/reseed flows never echo.
   */
  onAdd?: (note: Note) => void;
}

/**
 * Pending-note store: add with topic dedupe, capped pending list, and
 * per-session plus permanent dismissal tracking.
 */
export class NoteStore {
  private readonly capacity: number;
  private readonly persistDismissed?: (topics: string[]) => void;
  private readonly persistPending?: (notes: Note[]) => void;
  private readonly onAdd?: (note: Note) => void;
  private items: Note[] = [];
  private readonly permanent = new Set<string>();
  private readonly session = new Set<string>();

  constructor(options: NoteStoreOptions = {}) {
    const capacity = options.capacity ?? PENDING_CAP;
    this.capacity = Number.isFinite(capacity) && capacity >= 1 ? Math.floor(capacity) : PENDING_CAP;
    this.persistDismissed = options.persistDismissed;
    this.persistPending = options.persistPending;
    this.onAdd = options.onAdd;
  }

  /**
   * Add a note unless a pending note with the same normalized topic exists.
   * Returns true when the note was added, false when it was a duplicate.
   * Evicts the oldest pending note once over capacity. Real adds hand the
   * new pending list to the persistPending callback and fire the onAdd
   * hook; duplicates do neither.
   */
  add(note: Note): boolean {
    const added = this.push(note);
    if (added) {
      this.persistPending?.(this.pending);
      this.onAdd?.(note);
    }
    return added;
  }

  /**
   * Replace the pending list wholesale, applying the same dedupe and cap,
   * then hand the resulting list to the persistPending callback once — but
   * only when the pending list actually changed: replacing an identical
   * list (including empty with empty) is a no-op that never fires, so
   * restoring nothing on top of an empty store cannot create or rewrite
   * the state file.
   */
  replacePending(notes: Note[]): void {
    const before = this.items;
    this.items = [];
    for (const note of Array.isArray(notes) ? notes : []) this.push(note);
    const changed =
      before.length !== this.items.length ||
      before.some((note, index) => normalizeTopic(note.topic) !== normalizeTopic(this.items[index]!.topic));
    if (changed) this.persistPending?.(this.pending);
  }

  /** Pending notes, oldest first. Returns a defensive copy. */
  get pending(): Note[] {
    return [...this.items];
  }

  /** Permanently dismissed topics (normalized, insertion order). */
  get dismissedTopics(): string[] {
    return [...this.permanent];
  }

  /**
   * True when the topic was dismissed for this session or permanently.
   * The reviewer skips dismissed topics before they ever reach `add`.
   */
  isDismissed(topic: string): boolean {
    const key = normalizeTopic(topic);
    return this.permanent.has(key) || this.session.has(key);
  }

  /**
   * Hide a note for this session only. Returns true if a pending note was
   * removed; removals hand the remaining list to the persistPending
   * callback, unknown topics are no-ops.
   */
  dismissSession(topic: string): boolean {
    const key = normalizeTopic(topic);
    this.session.add(key);
    const before = this.items.length;
    this.items = this.items.filter((note) => normalizeTopic(note.topic) !== key);
    const removed = this.items.length < before;
    if (removed) this.persistPending?.(this.pending);
    return removed;
  }

  /**
   * Dismiss a topic permanently: record it, drop any pending note, and
   * hand both persistence callbacks their state — the full dismissed list
   * via persistDismissed and the remaining pending list via persistPending.
   */
  dismissPermanently(topic: string): void {
    const key = normalizeTopic(topic);
    if (key.length === 0) return;
    this.permanent.add(key);
    this.items = this.items.filter((note) => normalizeTopic(note.topic) !== key);
    this.persistDismissed?.(this.dismissedTopics);
    this.persistPending?.(this.pending);
  }

  /**
   * Drop all pending notes; dismissals are kept. A non-empty pending list
   * is handed to the persistPending callback; clearing an empty store is a
   * no-op that never fires.
   */
  clearPending(): void {
    const hadItems = this.items.length > 0;
    this.items = [];
    if (hadItems) this.persistPending?.(this.pending);
  }

  /** Push with dedupe + FIFO eviction; shared by add() and replacePending(). */
  private push(note: Note): boolean {
    const key = normalizeTopic(note?.topic ?? "");
    if (key.length === 0) return false;
    if (this.items.some((existing) => normalizeTopic(existing.topic) === key)) return false;
    this.items = [...this.items, note];
    if (this.items.length > this.capacity) this.items = this.items.slice(this.items.length - this.capacity);
    return true;
  }
}

const SEVERITY_LABELS: Record<Severity, string> = { info: "info", warning: "warning", critical: "critical" };

/**
 * Format notes for composition into a main-session chat message (the
 * `/ysk chat` action). Returns "" when there is nothing to format.
 */
export function formatNotesForChat(notes: Note[]): string {
  const list = Array.isArray(notes) ? notes : [];
  if (list.length === 0) return "";
  const lines = list.map((note) => {
    const severity = SEVERITY_LABELS[note.severity] ?? "info";
    const title = typeof note.title === "string" && note.title.trim().length > 0 ? note.title.trim() : note.topic;
    const suffix = note.origin?.via === "subagent" ? " (via subagent)" : "";
    const line = `- [${severity}] ${title}${suffix}`;
    return typeof note.detail === "string" && note.detail.trim().length > 0 ? `${line}\n  ${note.detail.trim()}` : line;
  });
  return ["**You should know** (background reviewer)", "", ...lines].join("\n");
}
