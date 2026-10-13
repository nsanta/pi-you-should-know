/**
 * Shared note types and the pending-note store for you-should-know.
 *
 * The store is deliberately pure-ish: persistence of permanently dismissed
 * topics is injected via a callback so callers (T5 wiring) decide how and
 * where to save. All topic matching is done on normalized topics.
 */

/** Severity of a "you should know" note. Unknown severities normalize to "info". */
export type Severity = "info" | "warning" | "critical";

/** A single background-review finding, ready to surface above the prompt. */
export interface Note {
  /** Normalized identity of the finding; used for dedupe and dismissal. */
  topic: string;
  severity: Severity;
  title: string;
  detail: string;
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
}

/**
 * Pending-note store: add with topic dedupe, capped pending list, and
 * per-session plus permanent dismissal tracking.
 */
export class NoteStore {
  private readonly capacity: number;
  private readonly persistDismissed?: (topics: string[]) => void;
  private items: Note[] = [];
  private readonly permanent = new Set<string>();
  private readonly session = new Set<string>();

  constructor(options: NoteStoreOptions = {}) {
    const capacity = options.capacity ?? PENDING_CAP;
    this.capacity = Number.isFinite(capacity) && capacity >= 1 ? Math.floor(capacity) : PENDING_CAP;
    this.persistDismissed = options.persistDismissed;
  }

  /**
   * Add a note unless a pending note with the same normalized topic exists.
   * Returns true when the note was added, false when it was a duplicate.
   * Evicts the oldest pending note once over capacity.
   */
  add(note: Note): boolean {
    return this.push(note);
  }

  /** Replace the pending list wholesale, applying the same dedupe and cap. */
  replacePending(notes: Note[]): void {
    this.items = [];
    for (const note of Array.isArray(notes) ? notes : []) this.push(note);
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

  /** Hide a note for this session only. Returns true if a pending note was removed. */
  dismissSession(topic: string): boolean {
    const key = normalizeTopic(topic);
    this.session.add(key);
    const before = this.items.length;
    this.items = this.items.filter((note) => normalizeTopic(note.topic) !== key);
    return this.items.length < before;
  }

  /**
   * Dismiss a topic permanently: record it, drop any pending note, and
   * hand the full dismissed list to the persistence callback.
   */
  dismissPermanently(topic: string): void {
    const key = normalizeTopic(topic);
    if (key.length === 0) return;
    this.permanent.add(key);
    this.items = this.items.filter((note) => normalizeTopic(note.topic) !== key);
    this.persistDismissed?.(this.dismissedTopics);
  }

  /** Drop all pending notes; dismissals are kept. */
  clearPending(): void {
    this.items = [];
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
    const line = `- [${severity}] ${title}`;
    return typeof note.detail === "string" && note.detail.trim().length > 0 ? `${line}\n  ${note.detail.trim()}` : line;
  });
  return ["**You should know** (background reviewer)", "", ...lines].join("\n");
}
