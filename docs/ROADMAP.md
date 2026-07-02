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
After ≥30 telemetry rows from normal use, review them (plus ~10 raw critic outputs) and check:
1. inter-critic disagreement < 20% (`agree:false` rate, 2-parsed-verdict runs)
2. ≥70% of failed-runs-with-followup flip to pass on overlapping files (`prior` linkage)
3. `userSentFindings:false` on < 30% of failed runs (false-positive proxy)
4. `parseError` rate < 10%

All four hold → flip `tournament.auto` default to true in `extensions/tournament.ts` (one line),
record the evidence here. jq starters:
`jq -s '[.[] | select(.verdicts|length==2)] | (map(select(.agree==false))|length) / length' ~/.pi/agent/critic-telemetry.jsonl`

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
