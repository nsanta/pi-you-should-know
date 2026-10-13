# Feature: ysk-inline-actions (keyboard-driven note interaction)

Status: in_progress
Branch: feature/you-should-know (continues after ca2ab84; ESC fix is the first work unit)
Created: 2026-02-18
Engram mirror: engram observation 4237, project pi-you-should-know (auto-detected via git root), topic ysk-inline-actions/tasks.

## Goal

Rework the you-should-know note surface from a passive widget + `/ysk` commands into the
screenshot-specified inline interaction: a `✦ Heads up · <summary>` band above the prompt
with number-key actions (1/2/0), in-place expansion of the full explanation, and
prompt-fill for handing the note to the main session.

## Product decisions (user-confirmed 2026-02-18, from screenshots + prose)

- Keys and `/ysk` coexist: number keys are the primary interaction; `/ysk` stays as
  fallback for discovery/scripting.
- Key 2 ("Chat in main session") FILLS the prompt editor with the composed explanation
  (`setEditorText`); the user reviews/edits and presses Enter themselves. It does NOT
  auto-send.
- Key 1 expands the note IN PLACE inside the widget band; the `ctx.ui.custom` modal
  overlay is removed; `/ysk learn` opens the same expanded state.
- Presentation timing: a pending note becomes visible when the chat answer completes —
  implemented on pi's `agent_end` / `agent_settled` loop boundary (user-approved "on turn
  end" intent = answer completion; pi's literal `turn_end` fires between tool rounds
  mid-task, which would leak notes mid-task). The agent loop stays uninterrupted.
- Key maps (from screenshots):
  - collapsed: `1: Learn more  2: Knew this already  0: Dismiss`
  - expanded:  `1: Understood  2: Chat in main session  0: Dismiss`
- Keys act on the newest pending note (resolveNote default).
- Notes persist until explicitly dismissed (no auto-clear); "clears when the task
  completes" is interpreted as: the note is presented at completion, dismissal stays
  explicit.

## Architecture (fixed by orchestrator)

- Primitive: `ctx.ui.onTerminalInput(handler)`; handler returns `{ consume: true }` for
  1/2/0 while a note is displayed, so the editor never sees the digit. Unsubscribed when
  no note is displayed. TUI-only (guarded by `ctx.hasUI && ctx.mode === "tui"`).
- Widget: two render states in `widget.ts` — collapsed (summary + hint line) and
  expanded (summary, blank, bold title, detail lines, blank, expanded hint). Severity
  coloring unchanged (info=accent, warning=warning, critical=error).
- Editor fill: `ctx.ui.setEditorText(composedExplanation)`; composition format shared
  with the old chat path (`formatNotesForChat`-based "Re: heads-up" body).
- `/ysk learn` toggles the same expanded state via the widget, not `ctx.ui.custom`.
- Turn-end gating: reviewer keeps running on `tool_execution_end` steps; `rerender` calls
  are deferred to `turn_end` when the turn is active. Headless/RPC unaffected.
- ESC-fix regression test stays green; overlay code path is deleted with its wiring.

## Non-goals

- No auto-dismiss timers, no note history, no mouse support, no multi-note key targets
  (keys act on newest note only; older notes remain reachable via `/ysk <action> <n>`).

## Tasks

### T1. Widget two-state rendering
`src/widget.ts`: collapsed layout (`✦ Heads up · <summary>` 1-2 lines + numbered hint)
and expanded layout (summary, title, detail lines, expanded hint); width-safe; severity
tokens kept; exported pure helpers for hint labels + state. Unit tests red first.
Acceptance: both layouts covered; truncation respected; no theme import.

### T2. Key interception layer
`src/index.ts`: terminal-input handler (consume 1/2/0 when a note is displayed), state
machine collapsed->expanded->closed, actions wired to store/editor/rerender; unsubscribe
on empty pending, session_shutdown, non-TUI. Wiring tests with fake ctx.ui.
Acceptance: digits consumed only while a note is shown; editor filled on 2; keys ignored
headless.

### T3. Action remap + /ysk parity + overlay removal
`src/actions.ts` + `src/index.ts`: `/ysk learn` -> expanded state (no modal); chat action
fills editor; ActionDeps updated (showOverlay replaced by expandNote, sendChat ->
fillEditor); widget.ts/actions docs updated. Tests updated.
Acceptance: no `ctx.ui.custom` references remain; all actions covered; green.

### T4. Answer-completion presentation
`src/index.ts`: queue widget updates while the agent loop is active (`agent_start`);
render on `agent_end` and `agent_settled` (idempotent, dirty-flag); `tool_execution_end`
still drives review. Wiring test: note created mid-loop renders only after agent_end.
Acceptance: mid-loop setWidget calls asserted absent; completion renders; green.

### T5. README + verification + review
README interaction section (keys, /ysk parity, timing); full suite + typecheck;
gentle-ai-verify delegation; native review candidate = accumulated feature work unit(s).
Acceptance: verify PASS or documented follow-ups; review approved or correction handled.

## Evidence

| Task | Commit | Result |
| ---- | ------ | ------ |
| T1 widget two-state | 4ea8c72 | 125/125 vitest green, tsc clean; KEY_ACTIONS exported; collapsed/expanded layouts per screenshots; wiring assertions updated minimally |
| T2 key interception | f55563e | 136/136 green, tsc clean; 1/2/0 consumed only while a note is shown; editor fill on 2; expansion topic tracking; subscribe/unsubscribe lifecycle covered |
| T3 overlay removal + remap | 903ff89 | 137/137 green, tsc clean; no ui.custom/matchesKey/pi-tui refs in src; /ysk learn expands in place, /ysk chat fills editor; unused pi-tui dep removed |
| T4 answer-completion gating | 6044e26 | 141/141 green, tsc clean; mid-loop renders deferred (dirty flag), agent_end/agent_settled flush; boundary decision corrected from literal turn_end to agent_end (turn_end fires mid-task) |
| T5 docs + verify | 143d8d3 | README keys/timing/parity documented; gentle-ai-verify PASS at 143d8d3: 141/141, tsc clean, installed-API cross-check clean, no wedge/double-render/leak; 2 non-blocking notes (mid-loop key capture on deferred band; fixed width 100) |
