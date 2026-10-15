# Feature: ysk-subagent-relay (surface subagent heads-ups on the parent)

Status: in_progress
Branch: feature/you-should-know (continues after ysk-sidebar)
Created: 2026-10-15
Engram mirror: not created (no memory tools callable in this session)

## Goal

pi-you-should-know runs in every pi process, including gentle-pi subagent
children (headless `pi --mode rpc`). Children generate heads-up notes
(reviewer loop + heads_up tool) that are invisible: the child has no TUI and
notes live in a per-process in-memory store. This feature relays child notes
to parent sessions so they surface in the parent's existing tally sidebar,
popup, and /ysk status. Self-contained inside pi-you-should-know (option 1);
no gentle-pi changes. Known limitation: notes cannot be attributed to a
specific agents-card task (sessionPath->taskId mapping is gentle-pi
internal); the relay is a pool, not per-card rows.

## User decision (2026-10-15)

- User chose option 1 (file-based relay inside this package) over the
  gentle-pi extension point (option 2, future upstream fix).

## Design (fixed by orchestrator)

- Shared convention (`src/relay.ts`):
  - Agent home: `GENTLE_PI_AGENT_HOME || PI_CODING_AGENT_DIR || ~/.pi/agent`
    (mirrors gentle-pi lib/agent-home.ts resolution).
  - Relay dir: `<agentHome>/you-should-know/relay/`; one JSONL file per
    child session `<sessionId>.jsonl`, single appender per file.
  - Line schema: `{ v: 1, id, ts, cwd, sessionId, note: { topic, severity,
    title, detail } }`; `id = "<sessionId>:<seq>"`.
  - Child detection: `GENTLE_PI_AGENTS_CHILD === "1"` (gentle-pi
    agents-runner.ts child marker).
- Note origin: `Note.origin?: { via: "subagent"; cwd?; sessionId? }`,
  attached by the relay layer only; round-tripped by the notes file
  (defensive parse); never set for local notes.
- NoteStore gains optional `onAdd` hook: fired on real adds only (never on
  replacePending), so the child writer mirrors reviewer + heads_up notes and
  restore never echoes.
- Child writer: active when child marker present AND `subagentRelay` config
  on; appends one line per real add through a serialized promise chain;
  every failure swallowed (quiet by design).
- Parent watcher: active when NOT a child AND relay on (all modes; rendering
  stays TUI-gated). Initial scan + fs.watch (debounced) + `scanNow()`.
  Ingest = parse new bytes per-file (byte-offset cursor, in-memory), filter
  by age window (`subagentRelayMaxAgeHours`, default 24) and consumed-id set
  (in-memory, capped), skip dismissed topics, `store.add` with origin, then
  gated requestRender. GC: relay files with mtime older than 7 days are
  unlinked (best-effort); cursor entries dropped with them.
  Restart semantics (documented): cursors are session-scoped, so unprocessed
  recent relay notes resurface after a parent restart; consumed recent ones
  may resurface once per restart (bounded by the age window).
- Display: subagent notes join the existing severity tallies (one pool).
  Sidebar gains a trailing `■ <n> subagent` row (token "subagent", themed
  muted) when any pending note is subagent-origin; click opens the popup
  filtered to subagent notes. Popup list lines get a `· subagent` marker;
  detail stage gets a muted `via subagent · <cwd basename>` row. Chat
  composition appends `(via subagent)` on subagent entries. /ysk status
  reports relay state (writing file on child; dir + ingested count on
  parent).
- Config (`you-should-know.json`, user + project layers, project wins):
  `subagentRelay: boolean` (default true), `subagentRelayMaxAgeHours:
  number` (default 24, floored, min 1).
- Testability: extension factory gains an optional second parameter
  `{ env?, relayDir? }` (pi calls it with one argument) so wiring tests
  inject a fake env and a tmp relay dir without touching process.env or the
  real agent home.

## Non-goals

- No per-agent-card attribution (needs the gentle-pi extension point).
- No cross-machine relay; local filesystem only.
- No intercom involvement (would violate the quiet, non-transcript design).

## Tasks

1. [x] Relay foundations: `src/relay.ts` (home/dir/child detection, line
   schema, encode/decode), `Note.origin`, NoteStore `onAdd`, config fields.
2. [x] Child writer + wiring (child mode relays reviewer and heads_up adds).
3. [x] Parent watcher + ingest wiring + widget/status surface.
4. [x] README section + this doc closed with commit evidence.

## Evidence

(commit hashes recorded per task as they land)
