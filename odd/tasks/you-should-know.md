# Feature: you-should-know (pi extension)

Status: completed
Branch: feature/you-should-know (5 commits, 2487093..c6e125b)
Created: 2026-02-14
Engram mirror: DEFERRED — engram rejects unknown project `pi-you-should-know`;
retry after the project is registered (first commit).

## Goal

A pi extension implementing Claude Code's "You should know" background-reviewer pattern:
a quiet second agent that reviews the conversation every N steps and surfaces hidden
decisions, silent assumptions, and architectural blind spots as non-blocking notes above
the prompt, each with per-note user actions.

## Product decisions (user-confirmed 2026-02-14)

- Standalone project, sibling to okf_god. Not part of okf_god.
- Generation: background LLM digest (nested model call) + agent-invocable `heads_up` tool.
  No rule detectors, no manual review command in v1.
- Surface: HUD widget above the editor. No transient notifications, no transcript entries.
- Mechanism reference (Claude Code v2.1.287 builtin): review every ~6 steps, non-blocking,
  note options = learn more / knew-this-already (permanent topic dismissal) / chat in main
  session / dismiss.

## Architecture (fixed by orchestrator)

- IDs: extension prefix `ysk`; widget id `ysk`; command `/ysk`; tool `heads_up`; entries `ysk:*`.
- Step counter: `tool_execution_end` events; review when count >= `reviewEvery` (default 6).
- Reviewer: `ctx.modelRegistry.streamSimple()` with a bounded transcript digest
  (tail of `ctx.sessionManager.getBranch()`, per-entry truncation, total cap).
  Output contract: JSON array, max 2 notes: `{topic, severity: info|warning|critical,
  title, detail}`. Defensive parse: malformed output is dropped, never thrown.
- Non-blocking: fire-and-forget async with in-flight guard; abort on `session_shutdown`
  and session replacement. Quiet failure by design.
- Dedupe: skip notes whose normalized topic is dismissed (persisted) or already pending.
- Widget: `ctx.ui.setWidget("ysk", ...)` above editor; severity-colored via theme tokens
  (info=accent, warning=warning, critical=error); shows up to 3 pending notes + action hint.
- Actions via `/ysk <action>`:
  - `learn`  -> full-detail overlay (`ctx.ui.custom()`, ESC closes)
  - `known`  -> permanent topic dismissal, persisted
  - `chat`   -> compose note into a user message for the main session
  - `dismiss`-> hide for this session only
  - `status` -> show reviewer state (steps, in-flight, pending, dismissed count)
- Config: project `.pi/you-should-know.json` overrides user `~/.pi/agent/you-should-know.json`.
  Fields: `reviewEvery` (number), `model` (optional string), `dismissedTopics` (string[]).
- Modes: core logic must work headless (`ctx.hasUI === false` skips widget/overlay only).
- Renderer hygiene: theme-aware, width-safe (visibleWidth/truncateToWidth), invalidate on change.

## Non-goals (v1)

- Rule-based detectors, notifications, transcript persistence of notes, keyboard shortcuts
  for note actions (documented as future work), auto-dismiss heuristics, note history view.

## Tasks

### T1. Scaffold project
package.json (type: module, deps: typebox; devDeps: pi-coding-agent 1.2.0, typescript,
vitest, @types/node), tsconfig, vitest.config, .gitignore, README stub, git init,
bootstrap commit on main, then branch feature/you-should-know.
Acceptance: `npm install` succeeds; `npm run typecheck` and `npm test` pass on empty skeleton.

### T2. Core: config + notes
`src/config.ts` (load/merge/save, ~ expansion, missing files tolerated, corrupt JSON
tolerated with defaults), `src/notes.ts` (note store: add, pending list capped, topic
normalize/key, dismissal persist+reload, session dismiss, chat/dedupe helpers) + unit tests.
Acceptance: vitest green; corrupt/missing config never throws; dismissal round-trips.

### T3. Core: step counter + reviewer
`src/steps.ts` (count completed tool executions, reset semantics), `src/reviewer.ts`
(bounded digest builder from branch entries; reviewer system prompt; streamSimple call;
strict-but-tolerant JSON note parsing; severity normalization; topic skip filtering)
+ unit tests with a fake model runtime.
Acceptance: digest is bounded and truncation-marked; parser handles valid/invalid/mixed
output; no throw paths; tests green.

### T4. UI: widget + actions
`src/widget.ts` (render pending notes, severity colors, action hint, invalidate discipline),
`src/actions.ts` (`/ysk` command parsing + handlers; learn overlay via ctx.ui.custom;
known/chat/dismiss/status) + tests for pure logic (command parse, note selection).
Acceptance: widget lines never exceed width; all four actions covered by tests; green.

### T5. Tool + wiring
`src/tool.ts` (`heads_up` tool, TypeBox schema, severity default info, routes through
note store), `src/index.ts` (factory: config load, session_start widget setup, event
hooks, tool registration, shutdown cleanup; guard non-UI modes) + wiring tests.
Acceptance: full `npm test` + `npm run typecheck` green; headless mode safe.

### T6. README + verification
Document install, config, actions, reviewer behavior, non-goals. Then independent
verification (gentle-ai-verify) and close.

## Evidence

| Task | Commit | Result |
| ---- | ------ | ------ |
| T1 scaffold | 2487093 (main, bootstrap; branch feature/you-should-know created) | typecheck + vitest green on skeleton |
| T2+T3 core | 8872c8a | 55 vitest tests green; tsc --noEmit clean; worker noted streamSimple adapter integration check deferred to T5 |
| T4 widget+actions | 788b868 | 36 focused tests green; pi-tui width utils deferred (undeclared transitive dep) — conservative truncation documented |
| T5 tool+wiring+README | 0b23d94 | 82 new tests, suite 118 green; typecheck clean; streamSimple adapter verified against installed types |
| T6 verify+close | c6e125b | Independent verify PASS (118/118, tsc clean, lifecycle/adapter/widget/parser checked vs installed types; headless/RPC safe). Minor notes: orphaned in-flight call on session replacement (wasted call, gen-guarded); char-count truncation vs wide glyphs (accepted, documented). Engram mirror still deferred (project unknown to engram). |
| Native review | lineage review-dc2c8810f174ede6, target sha256:4eb3011e… | APPROVED (reliability lens); authority burned, burn evidence gentle-ai.review-acknowledged/v1. 4 advisory SUGGESTIONS (non-blocking, follow-ups): digest includes custom_message entries (reviewer.ts:197), negative /ysk index parsing (actions.ts:44), saveDismissed non-atomic write (config.ts:67), /ysk status omits session dismissals (index.ts:292). |
| ESC-overlay fix (post-close, 2026-02-18) | 19e2c32 | ESC broken under kitty keyboard protocol (CSI-u \x1b[27u vs raw \x1b); matchesKey normalization + ctrl+c close; pi-tui declared as direct dep; regression test legacy+kitty+regular-key. Native review lineage review-b12cf3ea2088c5f5 APPROVED (reliability lens), authority burned; 2 informational suggestions (tests/wiring.test.ts:299, src/index.ts:256). 119/119 green, tsc clean. |

## Residual (post-close, by decision)
- Advisory review suggestions above = future hardening work.
- No real-TUI manual smoke test yet (all tests are fake-pi): try `pi --extension /home/nicolas/projects/pi-you-should-know`.
- Push / PR / merge to main = user decision; branch left local.
