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
  (`agent_end`/`agent_settled`) — mid-loop findings stay queued so the band never
  interrupts work — and renders as a HUD widget above the editor, severity-colored
  (`info` → accent, `warning` → warning, `critical` → error).
- The agent can also record notes directly through the `heads_up` tool.
- Reviews are fire-and-forget: a slow or broken reviewer never blocks or breaks the
  session. `session_shutdown` and session replacement abort in-flight reviews.

## Note interaction (keyboard)

While a note is displayed above the prompt, single-digit keys act on the **newest**
note and are consumed (they never reach the editor). Collapsed band:

```
✦ Heads up · The expiration time a user picks is read in the server's timezone, …
1: Learn more   2: Knew this already   0: Dismiss
```

| Key | Effect |
| --- | --- |
| `1` | Expand the full explanation **in place** (same band): title, detail lines, and `1: Understood  2: Chat in main session  0: Dismiss`. |
| `1` (expanded) | Understood — collapse back to the summary band; the note stays pending. |
| `2` (expanded) | Fill the prompt editor with the composed explanation — you review/edit and press Enter yourself; nothing is sent automatically. |
| `2` (collapsed) | "Knew this already": dismiss the topic permanently (persisted). |
| `0` | Dismiss the note for this session only. |

Keys work only in TUI mode with a pending note; typed digits pass through untouched
when no note is displayed or when input is multi-character (paste-safe).

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
  "dismissedTopics": []      // permanently dismissed topics (managed via /ysk known)
}
```

- Missing files, missing fields, and corrupt JSON are tolerated: defaults stand in
  (`reviewEvery: 6`, session model, no dismissals).
- `saveDismissed` writes only to the **project** file and preserves its other fields.
- `model` accepts either `"provider/model-id"` (looked up with the model registry)
  or a bare `"model-id"` matched across all known models. An unknown model falls
  back to the session's current model.

## `/ysk` actions

The `/ysk` command set stays as a fallback (discovery, scripting, older notes):

| Command | Effect |
| --- | --- |
| `/ysk` or `/ysk status` | Multi-line status: cadence, steps since last review, in-flight flag, pending count, dismissed count. |
| `/ysk learn [n]` | Expand the note **in place** in the widget band (same state as key `1`). |
| `/ysk known [n]` | "Knew this already": dismiss the topic **permanently** (persisted); the reviewer will skip it from now on. |
| `/ysk chat [n]` | Fill the prompt editor with the composed note ("Re: heads-up — please address"); you review and send it yourself. |
| `/ysk dismiss [n]` | Hide the note for **this session only** (not persisted). |

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
- Persisting notes across sessions (notes are session-only; only *dismissals* persist).
- Keyboard shortcuts for note actions, auto-dismiss heuristics, note history view.

## Troubleshooting

The extension **fails quiet by design**: a failed review (missing API key, network
error, unknown model) is swallowed and the widget simply stays as it was. If the HUD
seems stuck, run `/ysk status` — it shows the cadence, whether a review is in
flight, and the pending/dismissed counts. Permanently dismissed topics live in
`.pi/you-should-know.json`; delete an entry there to un-dismiss it.

Design and task breakdown: [odd/tasks/you-should-know.md](odd/tasks/you-should-know.md).
