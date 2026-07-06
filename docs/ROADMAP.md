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

### Context-loading latency — IMPLEMENTED 2026-07-06 (co-resident copilot + prefix cache)
Plan: `docs/plans/2026-07-06-context-loading-speedups.md` (adversarially reviewed: REVISE →
fixed → APPROVE). What shipped:
- **Copilot 27B** (`crow-local-27b-copilot/qwen3.6-27b`, port 8010, 65536 ctx, TEXT-ONLY,
  `--cache-reuse 256`, `~30GB`) co-resides with the 35b. `critic.refuteModel` +
  `critic.diverseModel` point at it → refute-pass/probe/diverse critiques no longer evict
  the session model at all. Solo full-262k 27b (port 8006) unchanged.
- **Eviction matrix** now has a `"solo"` group: 35b + copilot evict `["heavy","solo"]`,
  solo evicts `["heavy","standard"]` (one-tap 35b restore preserved), heavies evict all
  three groups. Only the 35b+copilot pair ever co-resides.
- **Measured**: copilot start = 20s warm, ZERO 35b interruption (was: full 35b eviction +
  ~2-3 min reload per refute/probe); prefix cache on the copilot = 8,453-token prefill
  30.2s on call 1 → 515-token tail 2.1s on call 2 (**~14x**); steady state both-up =
  22GB available, swap stable; bot service on :8003 uninterrupted throughout.
- **Deliberately NOT done**: `--cache-reuse` on the 35b/solo (llama-server hard-disables it
  under `--mmproj` — verified in the image binary; a restart would have bought nothing),
  critic task-ordering for shared prefixes (per-slot cache + concurrency — measure first),
  KV slot save/restore (mostly obsoleted by co-residency; revisit for heavies).
- Follow-ups: the recall probe's idle-only gating is now conservative (a probe no longer
  evicts the session model) — could relax after observing the pair under load; consider a
  pair-restore helper after heavy runs (copilot self-heal measured at 20s, acceptable).

### (superseded pin — original exploration notes, kept for the ranked list)
The harness swaps the single local slot constantly (critics / refute-pass / probe /
fix-dispatch restore), and every swap pays weight load PLUS cold-KV re-prefill of large
contexts. Ranked ideas, cheapest first:
1. **Co-resident standards (config-only, biggest win).** Both standards currently carry
   `evicts: ["heavy","standard"]` — the 35b and 27b evict EACH OTHER, yet the box shows
   ~49GB available WITH the 35b loaded and the 27b needs ~25GB. Change both standards to
   `evicts: ["heavy"]` and the refute-pass/probe swaps disappear entirely (35b stays
   serving bots on :8003 while the 27b refutes). Validate RAM headroom under concurrent
   load before committing; heavies keep evicting everything.
2. **llama.cpp prefix caching.** Confirm `cache_prompt` is on (default in recent servers)
   and add `--cache-reuse 256` to the compose commands — repeated prompt prefixes skip
   prefill. Biggest effect on the interactive session (each turn re-sends the whole
   conversation; with reuse the server prefills only the delta) and on critic re-runs.
3. **Shared-prefix task ordering.** Critic units start with the per-agent system prompt
   (differs per critic) followed by the big shared artifact — inverting the TASK-side
   content so the shared artifact leads would let unit 2 hit unit 1's prefix cache.
   Caveat: prefix cache is per-slot; concurrency spreads units across slots, so measure
   before restructuring prompts.
4. **KV slot save/restore across swaps.** `--slot-save-path` + `POST /slots/{id}?action=
   save|restore` can persist the SESSION model's KV to NVMe before an eviction and restore
   it after, so the session's next turn skips re-prefilling the whole conversation.
   Same-model only (KV is architecture-specific); files are GB-scale but NVMe-fast.
5. Cloud legs: use provider-side context caching where offered (GLM planner) — minor here.
Measurement hooks already exist: telemetry `durationMs`, llama.cpp `prompt eval` log lines.
Start with (1): flip the config, time a refute-pass before/after.

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
- **Live-run hardening round (2026-07-06, from the first end-to-end loop on the life
  testbed)** — the full critique→fix-dispatch→fix-review loop ran live and exposed five
  failure modes, each now closed: (1) **raw-output dump** — a review unit that yields no
  parseable verdict persists its final output + message tail to `~/.pi/agent/critic-debug/`
  (pruned to 30) and the dump path rides the parseError string; (2) **one-turn verdict
  recovery** — a completed-but-driftful critic run gets one budgeted retry ("emit only the
  fenced verdict for your own analysis"), success marked `recovered` in TUI + telemetry
  (a 2.5h double-parse-error run motivated both); (3) **fixer hard rules** — run the FULL
  suite, never change production code/schema solely to make a test writable (a leg added
  `.unique()` to a prod column for a rollback test), every finding fixed or explicitly
  disputed else `ok:false` (a leg silently skipped its cluster's top finding);
  (4) **invariant severity** — a demonstrated violation of a declared `.pi/critique.json`
  invariant is always a blocker (the drain-race invariant violation was filed as a warn);
  (5) **sidecar protection** — an all-parse-error run no longer overwrites the findings
  sidecar (it had erased the prior round's findings and disarmed fix-review). Telemetry
  rows gain `durationMs` and `recovered`; the fix-dispatch completion message now says
  "legs completed", steering to the judging critique instead of implying fixes are proven.
  Round-3 validation added two more: (6) **carried findings** — a recent failed run's
  unresolved findings ride into the next failed save (tagged `[carried]`, capped 30, cleared
  by a pass, never resurrected past a refute) because recall proved stochastic run-to-run:
  the drain-race P0 was found in round 1 and NOT re-found by round 3 on the same artifact;
  (7) **no-edit leg warning** — a fixer leg that completes with zero file edits triggers a
  warning + `noEditClusters` telemetry (fail-open verdicts hid a leg that skipped its top
  finding). Also: `.ts/.tsx` edits now syntax-gate through esbuild (~6ms, pinned devDep —
  the D1 v2 checker half), and `scripts/critic-gate-report.py` evaluates the six flip
  criteria in one command (currently: keep `tournament.auto` OFF, 11/30 rows).
- **Follow-up round (2026-07-06, review minors M1/M2/M4)** — cited file tokens are
  canonicalized against the changed-file list before subsystem-matching/keying (the same file
  cited two path-forms keys ONE cluster; a bare basename now matches full-path subsystem
  globs — the live run's 5 clusters would have been ~2-3); the cap folds overflow into a
  single `misc` bucket (the old merge-two-smallest loop could emit several clusters all
  named `misc`); and a `startModel(fixModel)` failure now background-restores the session's
  model (startModel evicts peers before starting, and the early return skipped the restore).
  The model-slot mutex (Workstream 1 note above) remains the durable fix for lifecycle races.
