# pi-lab roadmap

Deferred work with its prerequisites. Each item was design-reviewed 2026-07-02
(see the plan review notes in `docs/research/task-decomposition-2026-07.md` for the
evidence) and deferred deliberately — NOT dropped. **Both must land as automatic
defaults, not manual commands** (user requirement).

## D4 — Failure-triggered recursive decomposition (research rank 4)

Decompose a chain step ONLY when the executor fails it; deeper splitting for weaker
executors. Must become the DEFAULT chain retry policy.

Prerequisites surfaced in review:
- **Worker failure-verdict protocol** — today only critics emit parseable verdicts;
  `getFinalOutput()` is the entire inter-leg contract. Without a defined, parseable
  failure signal (plus prompt changes to worker/editor agents), the decompose trigger
  never fires. Spec fail-open/fail-closed behavior.
- Retry policy lives in the chain loop in `extensions/subagent/index.ts` (~lines 258–310
  pre-round; search for the chain executor), NOT run.ts.
- `{previous}` semantics after a split: step N+1 receives the LAST sub-step's output.
- One-recursion-level flag per step + a GLOBAL expansion cap (2–4 sub-steps × several
  failing steps balloons a 5-step chain).

## D5 — Best-of-N step tournament (research rank 2 — biggest measured gains)

Sequential best-of-N: checkpoint → attempt → critics score → rewind → next attempt →
re-apply the winner's diff. Auto-triggered (critic-fail or hard-step heuristic), not
command-only.

Prerequisites surfaced in review:
- **Shared checkpoint access path** (`pi-lab:checkpoint-*` bus API) — a second ShadowGit
  instance on the same gitDir bypasses the per-instance mutex and races the checkpoint
  extension. Tournament must also suspend checkpoint arming for its duration.
- Diff capture in the SHADOW repo (`git diff --binary startSha..endSha`) — captures
  untracked files; clean-apply-by-construction after reset; excluded paths documented
  as invisible.
- Reuse the /rewind background-task confirm; handle redo-record noise (k attempts = k
  redo entries); progress UX (`ctx.ui.notify` + `command_result` per phase — k attempts
  on local models ≈ 15–40 min).
- **Gate on verifier quality**: first instrument critic-score vs eventual-outcome
  telemetry (from normal /critique use) to confirm local critics can guide search
  (research open question #2). If they can't, tournament is wasted compute.

## Also blocked-on-upstream

- **Confucius-schema compaction** (research rank 7): pi's auto-compaction accepts no
  custom instructions from extensions (verified v0.74.2). Options when revisited:
  upstream PR for instruction pass-through, or full compaction takeover (own LLM call).

## D1 v2 (small)

- Blocking/revert edit gate (the variant the SWE-agent evidence actually measured) —
  needs coordination with checkpoint for cheap revert.
- TypeScript checker when the lab's node ≥ 22.6 (`--experimental-strip-types`) or a
  fast external TS parser lands.
