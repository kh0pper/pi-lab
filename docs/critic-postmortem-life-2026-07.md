# Critic post-mortem — life app phase-0 (2026-07-05)

An independent full-codebase review of `~/life` (phase-0, 18 commits, built by
GLM-5.1 plan → qwen3.6-35b execution, two critique rounds already applied)
found P0 defects the critics missed — several of them *inside or adjacent to
the round-1 fixes*. This doc records what escaped, why, and which harness
changes landed in response. Companion critique record in the life repo:
`docs/critique-phase0-2026-07-04.md`.

## What the critics missed (by defect class)

**A. Incomplete fixes — the headline.** Round 2 reviewed the fix *diff* and
verified the patch matched the finding's text, never re-deriving the invariant:
- `src/lib/client/sync.ts`: "drain only after successful push" fix never checks
  `res.ok` — `fetch` resolves on HTTP 500/401, outbox still drained → the
  original data-loss blocker survives for every non-network failure.
- The pull-first reorder (also a round-1 fix) introduced a NEW bug: blind
  `bulkPut` overwrites newer local pending edits with older server rows —
  visible edit-revert until a later sync.
- The pagination fix covered only the `since>0` branch; initial sync still
  truncates at 1,000 rows.

**B. Cross-file protocol invariants.** Drain deletes outbox keys enqueued
*after* the pre-push snapshot (silent loss); `applyChanges` is non-transactional
and recomputes its cursor via a capped query (wrong past 1,000 rows); keyset
pagination has no tiebreaker on equal timestamps; `sync_cursors` is write-only.
Diff-shaped review physically can't hold a 6-file protocol.

**C. Framework semantics.** Cleanup returned from `async onMount` never
registers (subscription leak); setup-token consumed in a GET `load`
(prefetch can burn it); PWA `navigateFallback` points at a 307 redirect route.
35B-class critics pattern-match generic JS and miss framework contracts.

**D. Executor-written tests share executor blind spots.** The fetch mocks have
no `ok`/`status` field at all — the suite *cannot represent* an HTTP error, so
"36/36 green" was structurally incapable of catching class A. Same author,
same misunderstanding, in code and test.

**E. Nothing ever ran.** The e2e suite cannot pass as written (playwright
config never sets `TEST_SKIP_AUTH`; webServer runs against the real `./data`
DB; a locator targets a button on the wrong page) — it was written, "fixed" in
round 1, and never once executed.

**False positive worth remembering:** round 1's "updateTask read-modify-write
race" blocker is unreachable — better-sqlite3 is synchronous, no `await`
between read and write, single-threaded Node cannot interleave it. Severity
inflation matters: tournament ranking keys on blocker counts.

**What the critics did well:** single-file, in-diff correctness (drain-before-
confirm, missing pagination, env-var bypass, e2e-auth gap) and round 2 catching
the inverted guard in round 1's fix. Iterated critique works; the failure was
*scope*, not iteration.

## The telemetry trap

This episode would have scored perfectly on the original tournament.auto flip
criteria: critics agreed (same model family — consistency, not correctness),
verdicts parsed, user sent the findings. Nothing measured recall. Hence the
revised criteria in ROADMAP.md (cross-model recall probe + fix-review
regression check as preconditions).

## What landed (2026-07-05)

| Gap | Change |
|---|---|
| A — fixes judged by wording | Fix-review mode: findings sidecar (`~/.pi/agent/critic-last-findings.json`); prior-failed runs get original findings + FULL file contents + invariant-restatement instruction |
| B — protocol blindness | Subsystem review: project `.pi/critique.json` (globs + invariants) → critics read the whole flow; prompt gains a protocol-invariants checklist |
| C — framework traps | code-critic prompt: framework-semantics checklist (async-lifecycle cleanup, GET side effects, `res.ok`, SW fallbacks) |
| D — mock infidelity | test-critic prompt: mock-fidelity check (doubles must model the real interface's failure modes) |
| E — unexecuted tests | Chain test-run gate (`subagent.testRunGate`): legs that edit tests without an observed test-command execution get one follow-up leg that must run them; verdicts carry optional `"ran"` (telemetry, not proof); test-critic checks run-preconditions for expensive suites |
| False-positive races | code-critic prompt: race claims must name the interleaving point, else warn |
| Same-family critics | Model diversity via LOCAL models (user decision — no frontier default): auto-critique model card (default / qwen3.6-27b / nemotron-super / frontier as *choices*), `/critique model`, managed-local auto-start with swap + background restore, `critic.recallProbeEvery` shadow probes on `critic.diverseModel` |

**Deliberately NOT changed: D4.** Every leg in this episode "succeeded" —
failure-triggered decomposition cannot fire on succeeded-wrong, and wiring
critic verdicts into the decompose trigger would fight its fail-open design.
Succeeded-wrong coverage belongs to critics + run gates. A targeted leg-retry
on critique blockers is documented as a future hook in ROADMAP.md.
