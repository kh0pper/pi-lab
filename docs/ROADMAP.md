# pi-lab roadmap

## LANDED 2026-07-02 (second long-horizon round)

### D4 — failure-triggered recursive decomposition ✅
Chain legs carry a fenced ```verdict contract (fail-open — `extensions/subagent/verdict.ts`);
on explicit `ok:false` / hard error / double-budget-kill the local `splitter` agent splits the
step 2–4 ways and the same agent executes the sub-steps (one structural recursion level,
`subagent.decomposeMaxExtraLegs` cap, `toolsOverride` propagated). **Automatic default**
(`subagent.decomposeOnFailure: true`). Telemetry: `~/.pi/agent/decompose-log.jsonl` —
`outcome:"rescued"` rates tell us whether decomposition earns its keep.

### D5 — best-of-N tournament (Phases 0–3) ✅ machinery / ⏳ auto-default
- Phase 0: critic-quality telemetry (`~/.pi/agent/critic-telemetry.jsonl`) accumulates from
  every /critique run (verdicts, inter-critic agreement, diff stats, userSentFindings human
  label, prior-run linkage).
- Phases 1–2: `pi-lab:checkpoint-*` bus API + `/tournament [k] <task>` (checkpoint-suspended
  attempts, shadow-diff critic scoring via `critiqueArtifact`, exact ranking tuple, binary
  patch apply with 3-way + confirm fallbacks).
- Phase 3: auto-trigger on failed post-plan auto-critique — **`tournament.auto` default FALSE**.
  Single-shot terminal state: tournament-sourced verdicts never re-trigger; residual fails
  surface in the summary only.

**THE FLIP CRITERION (the remaining step to full "automatic by default")**

Revised 2026-07-05 after the life-app phase-0 post-mortem (see
`docs/critic-postmortem-life-2026-07.md`): the original four criteria all measure
*precision* proxies. That episode would have scored perfectly on every one —
two critics agreed, verdicts parsed, the user acted on the findings — while
P0 data-loss bugs (unchecked `res.ok` before outbox drain, fix-introduced
revert regression, drain-key race) sailed through. Agreement between two
critics running the SAME model family measures consistency, not correctness.
Recall now has to be measured before ranking-by-critics gets autonomy.

After ≥30 telemetry rows from normal use, review them (plus ~10 raw critic outputs) and check:
1. inter-critic disagreement < 20% (`agree:false` rate, 2-parsed-verdict runs)
2. ≥70% of failed-runs-with-followup flip to pass on overlapping files (`prior` linkage) —
   meaningful now that prior-linked re-runs mechanically get fix-review context
   (original findings + full files + invariant restatement), not the fix diff alone
3. `userSentFindings:false` on < 30% of failed runs (false-positive proxy)
4. `parseError` rate < 10%
5. **Cross-model recall (NEW, precondition)**: ≥8 `source:"probe"` rows (or
   card-picked diverse-model runs — `modelOverride` set + `prior` linkage), and
   the diverse model finds a blocker the default critics missed on < 25% of
   probed diffs. Enable with `critic.recallProbeEvery: 5` while building the
   evidence; each probe costs a local-model swap + restore, so expect it on
   auto-critiques, not interactive ones.
6. **Fix-review regression check (NEW)**: zero cases in the window where a
   `fixReview:true` run passed and a later run (or human) found the original
   invariant still violated. One counterexample resets the clock — this is the
   exact failure mode that shipped the res.ok bug.

All six hold → flip `tournament.auto` default to true in `extensions/tournament.ts` (one line),
record the evidence here. jq starters:
`jq -s '[.[] | select(.verdicts|length==2)] | (map(select(.agree==false))|length) / length' ~/.pi/agent/critic-telemetry.jsonl`
`jq -s '[.[] | select(.source=="probe")] | length' ~/.pi/agent/critic-telemetry.jsonl`
`jq -s '[.[] | select(.fixReview==true)]' ~/.pi/agent/critic-telemetry.jsonl`

## Still open

### Confucius-schema compaction (research rank 7) — blocked on upstream
pi v0.74.2's auto-compaction accepts no custom instructions from extensions
(`customInstructions: undefined` hard-coded; `SessionBeforeCompactResult` has no instruction
field). Options when revisited: upstream PR for instruction pass-through, or full compaction
takeover (own LLM call). Error-scrubbing of persisted state landed as the interim.

### ctx.newSession() TUI wedge — retest after node ≥ 22.19 upgrade
Extension-initiated session replacement permanently wedges the interactive input loop on
pi 0.74.2 once the session has completed turns (see CLAUDE.md Don't-break). `/clear` and
`/handoff` use navigateTree instead. When the lab upgrades node (pi ≥ 0.75 requires 22.19),
retest and consider restoring true new-session semantics for /handoff.

### D1 v2 (small)
- Blocking/revert edit gate (the variant the SWE-agent evidence measured) — needs checkpoint
  coordination for cheap revert.
- TypeScript checker when node ≥ 22.6 (`--experimental-strip-types`) or a fast TS parser.

### Future tournament hooks (documented, not built)
- `[HARD]` marker on a plan step routing that step through /tournament from the plan executor.
- Re-tournamenting a whole plan from its pre-execution checkpoint (needs reliable
  pre-execution checkpoint identification).

### D4 targeted leg-retry (documented, not built)
When a post-plan critique produces a blocker that maps cleanly to ONE plan
step's files, that's a candidate signal to re-execute just that leg with the
finding as context — a targeted retry, far cheaper than a tournament. Decided
2026-07-05 NOT to wire critic verdicts into D4's decompose trigger itself:
D4 is failure-triggered and fail-open by design; "succeeded-wrong" coverage
belongs to critics + run gates (the chain test-run gate landed instead).

## LANDED 2026-07-05 (critic recall round — life-app post-mortem)

Post-mortem source: independent re-review of the life app's phase-0 build
(`docs/critic-postmortem-life-2026-07.md`). Landed, all critic-side:
- **Fix-review mode** — findings sidecar per cwd; prior-failed runs re-reviewed
  against original findings + full-file contents + invariant restatement.
- **Subsystem review** — project `.pi/critique.json` declares multi-file flows
  (globs + invariants); critics read the whole set when the diff touches it.
- **Critic model card** — auto-critique asks (TUI countdown + phone card) which
  model the critics run on: default bindings / diverse locals / frontier.
  Managed local models auto-start with swap + background restore. `/critique model`.
- **Recall probe** — `critic.recallProbeEvery` shadows every Nth critique with
  code-critic on `critic.diverseModel` (qwen3.6-27b), `source:"probe"` telemetry.
- **Prompt upgrades** — race claims need an interleaving point (else warn, never
  blocker); mock-fidelity check (fetch doubles must model ok/status); "were the
  tests ever executed" is in-scope; framework-semantics + protocol-invariant
  checklists; fix-review discipline (invariant over wording).
- **Chain test-run gate** — legs that edit tests without running them get one
  follow-up leg that must run them; verdicts carry optional `"ran"` (telemetry).

- **Critic precision (Workstream 1)** — evidence-or-downgrade rule, sibling-file context,
  adversarial refute-pass (blockers disproven on a different local model → warn). Spec:
  `docs/specs/2026-07-05-critic-precision-and-fix-dispatch-design.md`. Telemetry gains
  `refuted[]` + `blockersRefuted` — a refuted-rate to watch alongside the flip gate.
  Ship-later follow-ups LANDED 2026-07-06: `resolveRefuteModel()` (pure, refute.ts) derives
  the refute model from configured → diverse → first distinct settings.localModels entry —
  no hardcoded lab model; when nothing distinct exists the refute-pass is SKIPPED with a
  notice (never a same-model refute). The unread `CritiqueOutcome.allPassed` was dropped
  (consumers recompute from post-refute verdicts). And the model-lifecycle race is closed:
  startModel/stopModel (background restores included) run through one in-process FIFO queue
  (`enqueueLifecycle`, lib/local-models.mjs, tested by lib/local-models.test.mjs) — a queued
  swap starts only after the previous one settles; rejections propagate to their caller but
  never wedge the queue. Per-process only: the hub / other sessions stay unsynchronized
  (the observed races were all in-session swap points: critics, refute-pass, fix-dispatch).

## LANDED 2026-07-06 (structured fix-dispatch, Workstream 2, K2 fixer-leg chain)

Design: `docs/specs/2026-07-05-critic-precision-and-fix-dispatch-design.md`. Plan:
`docs/plans/2026-07-06-critic-fix-dispatch.md`.
- **Fix-dispatch** (`critic.fixDispatch` = `chain` default | `message` | `off`) — on "Send
  findings", failed verdicts' findings are clustered by subsystem/file and dispatched as one
  `fixer` subagent leg per cluster through a shared `runChain()` extracted from the subagent
  tool's chain executor, so critic and `/implement` walk the same chain path and the test-run
  gate + D4 decompose fire per cluster (a bad fix can't corrupt other clusters). `message`
  keeps the legacy single `sendUserMessage` turn; `off` drops the send-findings offer
  entirely. Falls back to `message` with no `fixer` agent, nothing to cluster, or plan-mode
  active (write-capable fixer legs can't run read-only). `critic.fixMaxClusters` (6, smallest
  merged beyond cap) and `critic.fixModel` (default the `fixer` agent's own model) round out
  the config. Restore target is the session model captured once before critique/refute swap
  anything, closing the model-strand risk flagged in review.
- Telemetry: `~/.pi/agent/fix-dispatch-log.jsonl` (per-cluster names/counts) plus per-leg rows
  in `decompose-log.jsonl`. Cluster labels feed the same flip-gate telemetry the recall probe
  and refute-pass write to — more signal toward the `tournament.auto` flip criteria above.
- **Follow-up round (2026-07-06, review minors M1/M2/M4)** — cited file tokens are
  canonicalized against the changed-file list before subsystem-matching/keying (the same file
  cited two path-forms keys ONE cluster; a bare basename now matches full-path subsystem
  globs — the live run's 5 clusters would have been ~2-3); the cap folds overflow into a
  single `misc` bucket (the old merge-two-smallest loop could emit several clusters all
  named `misc`); and a `startModel(fixModel)` failure now background-restores the session's
  model (startModel evicts peers before starting, and the early return skipped the restore).
  The model-slot mutex (Workstream 1 note above) remains the durable fix for lifecycle races.
