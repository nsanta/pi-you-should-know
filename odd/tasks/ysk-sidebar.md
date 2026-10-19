# Feature: ysk-sidebar (tally sidebar + detail popup)

Status: in_progress
Branch: feature/you-should-know (continues after 23db1be)
Created: 2026-02-18
Engram mirror: engram observation 4243 (sync obs-086561ba6d95d683), topic ysk-sidebar/tasks; judged related (not duplicate) to ysk-inline-actions obs 4237.

## Goal

Replace the above-editor note band and its global number-key layer with a compact
right-edge sidebar showing pending-note counts per severity; clicking a count opens a
mid-size popup with the note list/detail and the established actions. Understood and
Chat now mark a note as processed (removed from the tally, session-scoped).

## Product decisions (user-confirmed 2026-02-18)

- Sidebar REPLACES the band and the global 1/2/0 key layer entirely; `/ysk` stays as
  fallback (keyboard path, and for terminals without mouse delivery).
- Sidebar shows COUNTS per severity (not a note list). Counting rules (delegated to
  orchestrator): header `✦ <total> heads-up`; one row per severity with count > 0,
  ordered critical > warning > info; counts reflect the pending store (cap 3 applies
  upstream in NoteStore).
- Click severity row -> mid-size popup. Count == 1 -> detail view directly; count > 1
  -> list stage (newest first, numbered, clickable rows) -> pick -> detail.
- Popup open paths (user clarification): clicking the sidebar box (severity row -> that
  severity; header -> all notes) OR the `/ysk` command. Bare `/ysk` now opens the popup
  (all pending notes: list stage if >1, else newest detail); `/ysk status` keeps status
  text; `/ysk learn [n]` keeps targeting specific notes.
- Popup detail actions: exactly 1 Understood, 2 Chat in main session, 0 Dismiss. Keys
  and mouse clicks both work; Esc closes the popup.
- Processed semantics: Understood AND Chat mark the note processed -> removed from the
  sidebar tally, SESSION-SCOPED. Chat still fills the editor first (same composition).
  Processed reuses dismissSession (topic-scoped, consistent with quiet-by-design).
  Dismiss unchanged. Knew-this-already (permanent) remains available via /ysk known.
- Sidebar docks RIGHT edge, anchor right-center, ~26 cols, maxHeight ~80%, margin 1.
- Presentation timing preserved: mid-loop note arrival still defers sidebar updates to
  agent_end/agent_settled (dirty flag). Clicking/popup actions are allowed anytime.

## Architecture (fixed by orchestrator)

- Sidebar: long-lived `ctx.ui.custom` overlay, `overlayOptions: { anchor:
  "right-center", width: 26, maxHeight: "80%", margin: 1, nonCapturing: true }`;
  component implements `render` + `handleMouse` (component-local y hit-testing per
  rendered row); promise kept pending while unprocessed notes exist, `done()` when the
  tally empties (hides sidebar). OverlayHandle retained for cleanup on session events.
- Popup: second `ctx.ui.custom` overlay (capturing, center, width ~60%, maxHeight 60%),
  component with `handleInput` (1/2/0/Esc) + `handleMouse` (row/button clicks); two
  stages (list/detail) internal to one component; `done()` closes and refreshes sidebar.
- tui capture: the custom factory receives the live TUI; keep a session-scope ref for
  `fillEditor` repaint (replaces the widget-factory widgetTui mechanism).
- Keyboard: global onTerminalInput layer DELETED (keys handled inside the popup only).
- Modes: sidebar + popup strictly `ctx.hasUI && ctx.mode === "tui"` (custom components
  are not supported over RPC). /ysk actions no-op UI-wise in non-TUI modes.
- Store: no schema change; processed == dismissSession(topic). Status text updated.
- widget.ts: band builders removed; new pure builders: `sidebarRows(counts)` +
  `popupListRows(notes)` + `popupDetailRows(note)` (+ severity order/tally helpers);
  all width-truncated, theme tokens per row (severity colors + muted).

## Non-goals

- No hover states, no scrollbars (popup maxHeight + truncation only), no persistence of
  processed notes, no sidebar in headless/RPC, no drag/resize.

## Risks / watchpoints

- Long-lived pending custom() stretches the "one interaction" doc contract; mitigated
  by nonCapturing + OverlayHandle cleanup + doom-overlay precedent. If pi misbehaves
  (focus leaks), fallback design: re-show a fresh sidebar overlay per note change.
- Click hit-testing depends on overlay bounds + local coords (verified in pi-tui 1.2.0:
  dispatchMouseToOverlay translates to component-local x/y).
- Non-alt-screen terminals: no mouse delivery; /ysk fallback documented.

## Tasks

### T1. Pure view models (sidebar tally + popup rows)
`src/widget.ts`: ADD tallyBySeverity, sidebarRows, popupListRows, popupDetailRows +
pure hit-test helpers (severityAtSidebarRow, noteIndexAtPopupRow,
popupActionAtRow); keep band builders temporarily so index.ts keeps compiling (marked
superseded; T3 deletes them with the band wiring). Width-safe; tests red first.
Acceptance: new builders covered; full suite green.

### T2. Sidebar overlay wiring
`src/index.ts`: sidebar lifecycle (show on first pending note, refresh on changes,
hide when empty), agent-gated updates, tui capture for fillEditor repaint, session
cleanup; delete band writeWidget + onTerminalInput layer; wiring tests with fake
ui.custom capturing factory+options. Acceptance: nonCapturing options asserted; hides
when empty; headless never opens.

### T3. Popup component + processed semantics
`src/index.ts` (+ actions.ts parity): popup stages, keys, click routing, 1/2/0 actions
(understood/chat -> processed; chat fills editor + repaint), popup open paths (sidebar
header/rows, bare `/ysk` -> all-notes popup, `/ysk learn [n]`); remove expandedTopic
machinery; tests. Acceptance: all actions covered; processed removes from tally;
headless no-ops; bare /ysk opens popup.

### T4. README + status + verification + review
README sidebar/click docs; /ysk status wording; gentle-ai-verify; native review of the
feature range. Acceptance: verify PASS; review approved or corrections handled.

### T5. Card-frame sidebar restyle (user-requested 2026-10-14)
`src/widget.ts` + `src/index.ts`: replace the bare tally rows with a gentle-pi-style
rounded card (reference: user screenshot of gentle shell Status/Todos cards; geometry
mirrors gentle-pi lib/shell-card.ts): `╭─ ✦ N heads-up ─╮` top rule (frame painted
with the theme `border` role, title with accent), `│ ■ <count> <severity> │` body
rows, `╰──╯` bottom rule; SIDEBAR_WIDTH stays 26. New pure builders:
`sidebarCardRows` (CardRow segments with tokens incl. new `border` SeverityToken;
width-required) + `severityAtSidebarCardRow` (y=0 title -> all, body rows ->
severity, bottom rule -> null); superseded `sidebarRows`/`severityAtSidebarRow`
deleted. Popup unchanged. Tests red first. Acceptance: card geometry exact at
SIDEBAR_WIDTH; click hit-tests still pass (row shift accounted); suite + tsc green.

### T6. Full-width sidebar card (user-requested 2026-10-14)
`src/index.ts`: the card should span the terminal width like the reference cards.
Overlay `width: "100%"` (pi-tui clamps to terminal − margins and passes the resolved
width to render); the card is built per frame from a snapshotted notes array at that
render width (fallback `SIDEBAR_FALLBACK_WIDTH` = 26 when a frame has no width), with
the built rows cached for mouse hit-testing (same pattern as the popup). Supersedes
the fixed 26-col snapshot; widget.ts builders unchanged. Tests red first. Acceptance:
overlay options assert "100%"; renders at other widths produce exact-width cards;
click routing unchanged; suite + tsc green.

### T7. Full-brief popup card (user-requested 2026-10-15)
`src/widget.ts` + `src/index.ts`: popup (both stages) becomes the same rounded card as
the sidebar, larger (overlay width/maxHeight 60% -> 80%), and text WRAPS instead of
truncating so the full title + detail brief is always visible (screenshot evidence:
bare truncated rows, titles cut with "…"). Shared pure `frameCardRows(rows, title,
width)` framer (extracted from sidebarCardRows, which delegates and keeps byte-identical
output); new pure `wrapLine` (greedy word wrap, hard-breaks overlong words, no
ellipsis in popup bodies); popupListRows/popupDetailRows return framed CardRow[] with
"✦ Heads up" rule titles (list: numbered severity rows + hint; detail: severity title
row, detail lines, hint block); noteIndexAtPopupRow/popupActionAtRow operate on CardRow
and the action guard excludes the bottom rule (block = last A rows above it); index.ts
overlay "80%"/"80%", popupRowWidth = floor/fallback of the render width pi-tui already
provides (drops the wrong 0.6 re-ratio), render maps segments like the sidebar. Tests
red first. Acceptance: no "…" in any popup body row; both stages framed at exact
overlay width; click/keyboard routing preserved; suite + tsc green. Known cap:
maxHeight still bounds height (pi-tui slices overflow; scrolling stays a non-goal).

### T8. Persist pending notes across restarts (user-requested 2026-10-15)
Product decision (user): pending heads-up notes survive closing/reloading pi.
Pending notes persist per-project in `<cwd>/.pi/you-should-know-notes.json`
(`{ "notes": [...] }`, oldest first); processed (Understood/Chat), Dismiss, and
permanent dismissals still leave the pending store, so they are NOT restored after a
reload (permanent dismissals keep blocking re-raising via the existing config).
Mechanics: config.ts `loadPendingNotes`/`savePendingNotes` (defensive validation:
object entries, non-empty topic, coerceSeverity, string title/detail; corrupt/missing
-> []); NoteStore gains a `persistPending?: (notes: Note[]) => void` option fired
once per public pending mutation (add, replacePending, dismissSession, clearPending,
dismissPermanently), mirroring persistDismissed; index.ts funnels writes through a
serialized promise chain (the clearPending-then-replace race in initSession must
never reorder), loads on session_start (skipping permanently dismissed topics,
generation-guarded), best-effort quiet failures throughout. README documents the
state file and semantics. Tests red first. Acceptance: notes file round-trips;
reload restores the tally; corrupt file degrades to empty; suite + tsc green.

### T9. Dock the heads-up card in the Gentle Shell rail (user-requested 2026-10-15)
Product decision (user): the full-width card covers the whole view; display it like the
todos extension and Status card (screenshot: gentle shell right rail). Integration
(best-effort, quiet degradation): detect gentle-pi's experimental fullscreen rail via
`Symbol.for("gentle-pi.experimental-sidebar.state")` / `.cache` on tui.terminal; when
present, a `you-should-know` setWidget registers a "ysk" rail part (Component +
digest) that renders the heads-up card in the rail column: title `✦ Heads up · N`, one
severity-colored wrapped `■ <title>` row-group per pending note (newest first), click
on a note row -> popup detail; note changes bump the cache revision (invalidate) +
digest revalidation. The tally overlay suppresses its paint while the rail is active
(state.active && ownsHost) so the card never shows twice. Fallback (no rail / regular
mode): the overlay drops to width "30%" + minWidth 24 and keeps the counts-only tally
card (2026-02-18 product decision). All rail access try/catch quiet; absent or changed
gentle-pi internals degrade to the overlay. widget.ts: railHeadsUpRows(notes, {width})
-> { rows, noteAtRow } via frameCardRows + wrappedLines. Tests red first. Acceptance:
rail part renders exact card at rail width, click routes, overlay suppressed when
rail active, fallback intact without gentle-pi; suite + tsc green.

### T10. Per-session note persistence (user-requested 2026-10-15)
Product decision (user): persisted notes must be UNIQUE PER SESSION — resuming the
same session restores its notes; a NEW session starts clean (its reviewer fills its
own). Mechanics: notes move from the global `<cwd>/.pi/you-should-know-notes.json` to
`<cwd>/.pi/you-should-know-notes/<sanitized-session-id>.json` (session id via the
existing sessionManager helper the relay feature introduced; sanitize filename chars;
missing id -> no persistence, memory-only, documented). Migration: on session_start,
if the session file is absent and the legacy global file exists, adopt it into the
starting session and DELETE the legacy file (adopt-once, best-effort; concurrent
starts may race — tolerated). Retention: `pruneSessionNotes(dir, { keep = 20,
maxAgeMs = 14d })` in config.ts deletes other session files by mtime (never the
current one), run quiet on session_start before the read. Ordering keeps the T8-fix
invariant: prune -> read current session file (or legacy adopt) -> gen check ->
mutate. Relay flow unchanged (watcher -> store.add -> persistPending -> session
file). Tests red first. Acceptance: same-session resume restores; different session
id restores nothing from another session's file; legacy adopted once then removed;
prune keeps recent/drops old; suite + tsc green.

## Evidence

| Task | Commit | Result |
| ---- | ------ | ------ |
| T1 view models | 2c04c5f | 165/165 green, tsc clean; tally/sidebar/list/detail builders + row-index hit-tests; detail hint = three per-action rows (click targets); band builders kept compiling, superseded; flagged: detail text starting "N: Label" could hit-test as action — guard positionally in T3 wiring |
| T2 sidebar wiring | e14bc7a | 172/172 green, tsc clean; nonCapturing right-center overlay, snapshot-first render, done-capture close, generation guards, session cleanup, fillEditor repaint via sessionTui; band coexists until T3; risk noted: sync factory invocation assumed (same as band) |
| T3 popup + processed | 0ef86bb | 165/165 green, tsc clean, grep acceptance met (no band/key remnants in src); popup list/detail stages, mouse+keys, kitty-safe Esc, positional hit-guard, processed semantics (understood+chat -> dismissSession), /ysk popup parity, smoke test updated via approved unblock (smoke surface added by parent decision); pi-tui re-added for matchesKey |
| Verify corrections | 6c514ce | gentle-ai-verify CONDITIONAL PASS -> three gaps fixed: sidebar click-to-popup wired (severityAtSidebarRow -> openPopup all/severity), list stage newest-first, strict mode===tui sidebar guard + rpc test. 168/168 green, tsc clean |
| T10 per-session notes | (this commit) | notes move to .pi/you-should-know-notes/<sanitized-session-id>.json; adopt-once migration deletes the legacy global file; pruneSessionNotes (keep 20 / 14d, keepPath protected) runs before the read; T8 read-before-mutate invariant kept; relay wiring untouched. gentle-ai-verify PASS; 280/280 x2 (worker x3), tsc clean. Known edges (accepted): ids colliding after sanitization share a file (impossible for pi UUIDs); a session replaced during the prune/load await could re-point the path (needs overlapping inits, unreachable in pi); a corrupt legacy file is adopted as empty and deleted (matches delete-to-reset contract) |
| T9 rail docking | (this commit) | gentle rail integration via Symbol.for state/cache (best-effort, silent degradation): "ysk" rail part renders railHeadsUpRows (newest-first per-note wrapped rows, digest + revision-bump freshness, click -> detail popup); overlay suppressed (render + mouse) while rail owns host; fallback compacted to 30% + minWidth 24 counts card; relay-feature preservation honored (teardown lines, factory overrides, setupRelay). Landed around a concurrent relay worker: builder/tests absorbed into ae662f8/a30b9f9, wiring committed here. gentle-ai-verify PASS; 268/268 x2 (worker x3), tsc clean |
| Native review | lineage: NONE — blocked | START over committed range b742e691..HEAD rejected 3x: controller returns empty-candidate workspace status (empty_candidate_base_ref_required) without creating a lineage; untracked selection (.pi/you-should-know.json) resolved via select-intended-untracked; START loop stopped per contract. No authority created or burned. Feature otherwise verified (168/168, tsc clean, API cross-check, adversarial sweep clean). Retry in a fresh session or via maintainer CLI. |
| T5 card restyle | adece77 | gentle-ai-worker TDD (red -> green), gentle-ai-verify PASS (geometry matches gentle-pi shell-card arithmetic; popup untouched); degenerate-width coverage gap closed by parent; 169/169 green, tsc clean |
| T6 full width | 303c77c | overlay width "100%" (pi-tui clamps to terminal - margins, passes resolved width to render); notes snapshot + per-frame card at render width, frame-rows hit-test cache (popup pattern); dynamic-width test at 40/100; gentle-ai-verify PASS; 170/170 green, tsc clean |
| T7 popup card | ee4979a | shared frameCardRows framer (sidebar delegates, tests unmodified as parity net) + wrapLine (hard-break, no ellipsis); popup both stages framed "✦ Heads up" cards at 80%/80%, bodies pre-wrapped at width-4; hit-tests on framed body text, action block above bottom rule; popupRowWidth drops 0.6 re-ratio; gentle-ai-verify PASS; 188/188 green, tsc clean; cap noted: maxHeight still bounds height (scrolling stays non-goal) |
| T8 persistence | (this commit) | config loadPendingNotes/savePendingNotes + NoteStore persistPending callback + serialized notesWriteChain; wiring + README; round-1 gentle-ai-verify FAIL caught a real initSession write/read race (reseed fired empty writes before the off-chain read -> restarts with dismissedTopics could wipe the file); fixed load-before-mutate + flushPendingNoteWrites test drain + regression pin; flagged replacePending change-guard accepted (keeps pristine projects quiet); parent unit pin for the no-op guards; 211/211 green x3, tsc clean |
