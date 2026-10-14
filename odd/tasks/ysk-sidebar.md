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

## Evidence

| Task | Commit | Result |
| ---- | ------ | ------ |
| T1 view models | 2c04c5f | 165/165 green, tsc clean; tally/sidebar/list/detail builders + row-index hit-tests; detail hint = three per-action rows (click targets); band builders kept compiling, superseded; flagged: detail text starting "N: Label" could hit-test as action — guard positionally in T3 wiring |
| T2 sidebar wiring | e14bc7a | 172/172 green, tsc clean; nonCapturing right-center overlay, snapshot-first render, done-capture close, generation guards, session cleanup, fillEditor repaint via sessionTui; band coexists until T3; risk noted: sync factory invocation assumed (same as band) |
| T3 popup + processed | 0ef86bb | 165/165 green, tsc clean, grep acceptance met (no band/key remnants in src); popup list/detail stages, mouse+keys, kitty-safe Esc, positional hit-guard, processed semantics (understood+chat -> dismissSession), /ysk popup parity, smoke test updated via approved unblock (smoke surface added by parent decision); pi-tui re-added for matchesKey |
| Verify corrections | 6c514ce | gentle-ai-verify CONDITIONAL PASS -> three gaps fixed: sidebar click-to-popup wired (severityAtSidebarRow -> openPopup all/severity), list stage newest-first, strict mode===tui sidebar guard + rpc test. 168/168 green, tsc clean |
| Native review | lineage: NONE — blocked | START over committed range b742e691..HEAD rejected 3x: controller returns empty-candidate workspace status (empty_candidate_base_ref_required) without creating a lineage; untracked selection (.pi/you-should-know.json) resolved via select-intended-untracked; START loop stopped per contract. No authority created or burned. Feature otherwise verified (168/168, tsc clean, API cross-check, adversarial sweep clean). Retry in a fresh session or via maintainer CLI. |
