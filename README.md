# pi-you-should-know

A [pi](https://github.com/earendil-works/pi-coding-agent) extension implementing the
"You should know" background-reviewer pattern: a quiet second agent reviews the
conversation every N tool steps and surfaces hidden decisions, silent assumptions,
and architectural blind spots as **non-blocking notes above the prompt** — each with
per-note user actions. It never interrupts a run, never writes to the transcript,
and fails quiet by design.

## How it works

- Every `reviewEvery` completed tool executions (default: 6), the extension sends a
  bounded transcript digest to a nested model call (`ctx.modelRegistry.streamSimple`).
- The reviewer returns at most 2 notes; notes whose topic was dismissed are dropped
  before they are ever stored.
- A pending note becomes visible **when the current agent answer completes**
  (`agent_end`/`agent_settled`) — mid-loop findings stay queued so the card never
  interrupts work — and are surfaced in a severity-colored **heads-up card** that docks
  into gentle-pi's fullscreen right rail when available, or renders as a compact tally
  at the right edge otherwise (keyboard-focus-free in both cases).
- The agent can also record notes directly through the `heads_up` tool.
- Pending notes are **persisted per session** in
  `.pi/you-should-know-notes/<session-id>.json`: resuming the same session restores its
  notes, and a new session starts clean (see below).
- Reviews are fire-and-forget: a slow or broken reviewer never blocks or breaks the
  session. `session_shutdown` and session replacement abort in-flight reviews.

## Note interaction (sidebar + popup)

While unprocessed notes exist, a compact tally is docked to the **right edge**:

```
✦ 3 heads-up
■ 2 critical
■ 1 info
```

One row per non-zero severity, priority order (critical > warning > info); the sidebar
never takes keyboard focus.

### Where the heads-up card shows up

The card has two surfaces, and it never shows in both places at once:

- **In gentle-pi's fullscreen shell**, the card docks into the experimental right rail
  (below the Status/Todos cards) titled `✦ Heads up · N`, with one severity-colored
  `■ <title>` row per pending note — newest first, long titles wrapped, never truncated.
  Clicking a note row opens that note's detail popup directly. Note changes refresh the
  rail automatically; `Esc`/popup actions work exactly as described below.
- **Everywhere else** (regular pi sessions, other runtimes, terminals without the rail),
  the same card renders as a compact tally docked to the right edge — the severity
  counts shown above in a card spanning 30% of the terminal (at least 24 columns).

While the fullscreen rail hosts the card, the right-edge overlay deliberately paints
nothing (so the tally is never shown twice), and switching between fullscreen and
regular mode needs no reopen. The rail integration is best-effort: if the rail is
unavailable or its internals change, the extension silently falls back to the
right-edge tally, and `/ysk` keeps working everywhere.

- **Click a severity row** (or the header for all notes) to open the popup. With one
  matching note it opens the detail directly; with several it shows a numbered list
  first (newest first), then the detail.
- **Or run `/ysk`** to open the same popup over all pending notes; `/ysk learn [n]`
  targets a specific note.
- Popup detail actions (keys or clicking the action rows):

| Action | Effect |
| --- | --- |
| `1: Understood` | Marks the note **processed** — it leaves the sidebar for this session. |
| `2: Chat in main session` | Fills the prompt editor with the composed explanation (review, then press Enter yourself) and marks the note processed. |
| `0: Dismiss` | Hides the note for this session. |

`Esc` closes the popup without processing anything. Mouse clicks require a
fullscreen/alt-screen terminal (pi enables mouse there); in plain terminals use `/ysk`.

### Pending notes persist per session

The pending store is mirrored to a per-session state file,
`.pi/you-should-know-notes/<session-id>.json` (plain JSON, `{ "notes": [...] }`, oldest
first). Resuming the same session restores its unprocessed notes, so the tally survives
closing and reloading pi; a new session starts clean and fills its own tally. A note
leaves the file — and never resurfaces — once it is processed (`Understood`/`Chat`),
dismissed (`0`), permanently known, or evicted by the 3-note cap. Permanently dismissed
topics are additionally blocked from ever being re-raised (see `dismissedTopics` below).

The files are pure state: gitignore them freely, and delete a session's file (or the
whole directory) to reset its pending notes. Housekeeping is automatic: the 20 most
recent session files are kept, files older than 14 days are pruned, and the current
session's file is never touched. A pre-per-session install's global
`.pi/you-should-know-notes.json` is adopted once — by the next session that starts,
which inherits those notes — and then removed, so old notes migrate exactly once and
never leak into other sessions.

## Subagent relay

pi-you-should-know loads in every pi process — including gentle-pi subagent children
(headless `pi --mode rpc`). Notes raised inside a child (background reviewer or
`heads_up`) are relayed to parent sessions over a file convention, so they surface in
the parent's usual card, popup, and `/ysk` surfaces, marked `subagent`:

- A **child** process (`GENTLE_PI_AGENTS_CHILD=1`) appends one JSON line per new note
  to `<agentHome>/you-should-know/relay/<sessionId>.jsonl`.
- A **parent** session watches the shared relay dir, ingests fresh lines (24 h window
  by default), skips already-seen and permanently dismissed topics, and shows relayed
  notes with a muted `subagent` marker (a trailing `■ <n> subagent` pool row in the
  card, `· subagent` in popup lists, `via subagent · <dir>` in note details, and
  `(via subagent)` in composed chat text).

Relay files live under the agent home resolved like gentle-pi's
(`GENTLE_PI_AGENT_HOME` > `PI_CODING_AGENT_DIR` > `~/.pi/agent`):
`<agentHome>/you-should-know/relay/`. Files idle for 7 days are garbage-collected.

Two config keys (user + project layers, project wins):

- `subagentRelay` (default `true`): the child writes and the parent ingests; set
  `false` to turn the relay off entirely.
- `subagentRelayMaxAgeHours` (default `24`, whole hours, minimum 1): how old a
  relayed note may be and still surface.

Restart semantics: the parent's read cursors and seen-ids live in memory, so after a
parent restart unprocessed recent relay notes resurface; a note processed before the
restart may resurface at most once (bounded by the age window). Dismissing or
permanently knowing a topic stops its notes for good.

Known limitation: the relay is a **global pool** — relayed notes cannot be attributed
to a specific agents-card task in gentle-pi's rail (that mapping is gentle-pi
internal), so they appear as one `subagent` group rather than per-task rows.

## Install

As a pi package (recommended):

```bash
pi package add pi-you-should-know
```

Or copy/symlink this directory into your extensions directory and pi picks up
`src/index.ts` (or load it directly while developing):

```bash
pi --extension /path/to/pi-you-should-know/src/index.ts
```

Pi loads extensions via `jiti`, so no build step is needed. Node dependencies
(`typebox`) resolve from the package's `node_modules`.

## Configuration

Two JSON files; **project overrides user** for scalars, `dismissedTopics` is the
union of both:

| File | Path |
| --- | --- |
| Project | `<project>/.pi/you-should-know.json` |
| User | `~/.pi/agent/you-should-know.json` |

```jsonc
// .pi/you-should-know.json
{
  "reviewEvery": 6,          // run the reviewer every N completed tool steps (>= 1)
  "model": "anthropic/claude-haiku-4-5",  // optional reviewer model override
  "subagentRelay": true,     // relay subagent notes to the parent session
  "subagentRelayMaxAgeHours": 24,  // ingest window for relayed notes (>= 1)
  "dismissedTopics": []      // permanently dismissed topics (managed via /ysk known)
}
```

- Missing files, missing fields, and corrupt JSON are tolerated: defaults stand in
  (`reviewEvery: 6`, session model, relay on with a 24 h window, no dismissals).
- `saveDismissed` writes only to the **project** file and preserves its other fields.
- `model` accepts either `"provider/model-id"` (looked up with the model registry)
  or a bare `"model-id"` matched across all known models. An unknown model falls
  back to the session's current model.

Pending notes live in per-session **state** files,
`.pi/you-should-know-notes/<session-id>.json`, written entirely by the extension (one
`{ "notes": [...] }` object per session, oldest first). A missing or corrupt file
simply starts empty; delete a session's file (or gitignore the directory) to reset
that session's pending notes. Old session files are pruned automatically (20 most
recent kept, 14-day age cap); a pre-per-session global notes file is adopted once by
the next starting session and removed.

## `/ysk` actions

The `/ysk` command set stays as a fallback (discovery, scripting, older notes):

| Command | Effect |
| --- | --- |
| `/ysk` | Open the popup over all pending notes (list stage when several, newest otherwise). |
| `/ysk status` | Multi-line status: cadence, steps since last review, in-flight flag, pending count, dismissed count, subagent relay state. |
| `/ysk learn [n]` | Open the popup for a specific note (1-based, oldest = 1). |
| `/ysk known [n]` | "Knew this already": dismiss the topic **permanently** (persisted); the reviewer will skip it from now on. |
| `/ysk chat [n]` | Fill the prompt editor with the composed note and mark it processed; you review and send it yourself. |
| `/ysk dismiss [n]` | Hide the note for **this session only** (the dismissal itself is not persisted; the note is removed from the pending-notes file, though the reviewer may re-raise the topic in a later session). |

Notes are addressed newest-first by default; `n` is a 1-based index in the widget's
display order (oldest = 1). A bare number (`/ysk 2`) is shorthand for `/ysk learn 2`.

## `heads_up` tool

The model can surface a finding itself:

```
heads_up({ note: "Deployment gate is manual", severity: "warning" })
```

- `note` (string, required): 1–4 sentences; the **first line becomes the topic**.
- `severity` (optional): `info` (default) | `warning` | `critical`.

The note goes through the same store as background reviews (dedupe by topic,
3-note cap, dismissal filtering) and shows up on the same widget. The tool never
throws: bad input returns an error result to the model instead.

## Reviewer cadence and costs

- One step = one completed tool execution (`tool_execution_end`).
- At most one review in flight; the in-flight flag plus an `AbortSignal` (aborted on
  shutdown/session switch) bound concurrent cost.
- The digest is bounded (newest ~40 entries, ~500 chars each, ~6000 chars total), so
  each review is a small, cheap side call. Set `reviewEvery` higher — or a cheaper
  `model` — to spend less.
- Reviews never enter the transcript and their token usage is not added to session
  totals; they are invisible background calls by design.

## Non-goals (v1)

- Rule-based detectors (everything comes from the reviewer model or `heads_up`).
- Transient notifications or transcript entries for notes.
- Persisting processed notes, note history, or session-dismissal state (only
  *pending* notes and *permanent dismissals* persist).
- Keyboard shortcuts for note actions, auto-dismiss heuristics, note history view.

## Troubleshooting

The extension **fails quiet by design**: a failed review (missing API key, network
error, unknown model) is swallowed and the widget simply stays as it was. If the HUD
seems stuck, run `/ysk status` — it shows the cadence, whether a review is in
flight, and the pending/dismissed counts. Permanently dismissed topics live in
`.pi/you-should-know.json`; delete an entry there to un-dismiss it. Pending notes
live in `.pi/you-should-know-notes/<session-id>.json`; delete the session's file (or
the whole directory) to clear the tally.

Design and task breakdown: [odd/tasks/you-should-know.md](odd/tasks/you-should-know.md).
