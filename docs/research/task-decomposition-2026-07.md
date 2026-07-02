# Task decomposition & long-horizon agentic coding — research report

_Deep-research run 2026-07-02: 5 search angles, 22 sources fetched, 110 claims extracted,
25 adversarially verified (3 independent refutation votes each) → 20 confirmed, 5 refuted.
Commissioned to guide pi-lab's long-horizon upgrades (the critics gave us verification;
this asks what the planning/decomposition layer should look like on local 30–120B models)._

## Ranked findings (by evidence strength)

### 1. Per-step verification gates — HIGH confidence
SWE-agent (NeurIPS 2024) ablation: removing the lint gate on edits drops SWE-bench Lite
resolution 18.0% → 15.0% (no structured edit interface at all: 10.3%). Edits succeed 90.5%
overall but only 57.2% after one failed edit; 51.7% of trajectories contain a failed edit;
cascading failed edits cause 23.4% of all task failures. Independently, task horizon scales
roughly as ceil(ln(s)/ln(p)) in per-step accuracy p — small per-step reliability gains past
~80% yield super-linear horizon gains.
**pi-lab**: `extensions/edit-gate.ts` (landed with this round) — syntax feedback on every
edit/write, incl. subagent workers. Honesty note: the cited ablation is for the stronger
*blocking* variant (reject before apply); ours is feedback-after-apply, revert-as-v2.
Sources: arxiv.org/abs/2405.15793, arxiv.org/html/2509.09677v3

### 2. Tree search / best-of-N over trajectories — HIGH confidence
SWE-Search (ICLR 2025): MCTS over agent trajectories = +23% mean relative resolve rate
across five models vs the identical agent without search. Open ~70B models gained MOST
(Qwen-2.5-72B +27%, lifting it above GPT-4o-on-baseline-scaffold: 24.7% vs 24.3%).
In a separate single-removal ablation (CodePilot, preprint), MCTS was the largest single
contributor (+4.34pp). Gains scale with inference-time compute — the trade a self-hosted
harness can happily make.
**pi-lab**: deferred to D5 (see ROADMAP.md) — sequential best-of-N using checkpoints as
backtracking and critics as the value function. Deferred because verifier quality is the
binding constraint (see open questions) and the checkpoint bus API must be designed first.
Sources: arxiv.org/abs/2410.20285, arxiv.org/pdf/2602.00129

### 3. Structure narrows but does NOT close the local↔frontier gap — HIGH confidence
For: the SWE-Search numbers above. Against: with planning removed entirely (model handed
the knowledge AND the plan), larger models still execute accurately over significantly more
sequential steps; GPT-4o with search (31.0%) still beats Qwen-72B with search (24.7%).
**pi-lab**: expect structure to buy ~a model tier on searchable tasks; keep individual
subagent legs SHORT (the per-leg turn budget enforces this).
Sources: arxiv.org/abs/2410.20285, arxiv.org/html/2509.09677v3

### 4. Failure-triggered recursive decomposition — HIGH confidence (transfer assumed)
ADaPT (NAACL 2024 Findings): decompose a subtask ONLY when the executor fails it — up to
+28.3pts vs plan-then-execute/ReAct baselines; decomposition depth adapts to executor
strength (weakest executor 3.3% → 41.7%). Fixed upfront fine-grained planning was the
WEAKEST strategy tested. Caveat: embodied/web/crafting benchmarks, not coding — transfer
to coding is an assumption to validate.
**pi-lab**: deferred to D4 (ROADMAP.md) — needs a worker failure-verdict protocol first.
Upfront plans stay coarse (planner/architect prompts say so).
Source: arxiv.org/abs/2311.05772

### 5. Architect/Editor role split — MEDIUM confidence
Aider's architect mode (reasoning pass proposes, editor pass converts to strict edits) set
then-SOTA 85% on its benchmark; biggest gains exactly in the weak/local-model regime
(community report: Qwen2.5-Coder-32B 92% → 100% well-formed edits; a cheap editor loses
little). Medium: vendor self-benchmark, short-horizon tasks, gains don't generalize to all
newer frontier models.
**pi-lab**: `architect`/`editor` agents landed this round; `/implement` now defaults to
scout → architect → editor (`/implement-worker` keeps the old path).
Sources: aider.chat/2024/09/26/architect.html, github.com/Aider-AI/aider/issues/2401

### 6. Fresh-context isolation + error-scrubbing are load-bearing — HIGH confidence
Models self-condition on their own past mistakes: injecting errors into history degrades
later-turn accuracy monotonically, and scaling model size does NOT mitigate it (even 200B+).
Successful agent runs are SHORT (median 12 steps / $1.21) vs failures (21 steps / $2.52) —
abort-and-retry-fresh beats budget extension.
**pi-lab**: validates the existing fresh-context subagents/critics architecture; landed this
round: error-scrubbing in structured-compaction (one-line summaries, bodies dropped) and the
per-leg turn budget with one fresh retry (`subagent.maxStepsPerLeg`, default 24).
Sources: arxiv.org/html/2509.09677v3, arxiv.org/abs/2405.15793

### 7. Compaction as structured plan-reconsolidation — MEDIUM confidence
Confucius Code Agent (Meta/Harvard preprint): a dedicated compaction call rewriting history
into {goals, decisions, open TODOs, critical error traces} + raw recent tail = +6.6pp
Resolve@1 in a controlled ablation.
**pi-lab**: BLOCKED-ON-UPSTREAM for the full mechanism — pi v0.74.2's auto-compaction
hard-codes customInstructions:undefined and `SessionBeforeCompactResult` has no instruction
field; extensions can only fully take over compaction (own LLM call — too big for now).
What landed instead: opportunistic `## Errors` parsing + error-scrubbing of persisted state.
Revisit if upstream adds instruction pass-through.
Source: arxiv.org/pdf/2512.10398

### 8. What open harnesses actually do (context) — MEDIUM confidence
Source-code taxonomy of 13 open coding agents: five composable control-loop primitives
(ReAct, generate-test-repair, plan-execute, multi-attempt retry, tree search); 11 of 13
layer several, yet 7 of 13 keep sequential ReAct as the PRIMARY loop. pi-lab's shape
(ReAct core + plan mode + subagents + critics as layers) matches the field's revealed
preference; the wins are additional gate/retry/search layers, not loop replacement.
Source: arxiv.org/abs/2604.03515

## Refuted in verification (do not build on these)

- "Tree search lets a small 8B model beat bigger scaffolds" (Qwen3-8B/24.67% claim) — 0-3.
- "Static one-shot decomposition fails BECAUSE single sub-task failure kills the task" — 0-3 (mechanism claim unsupported).
- "Bug localization is the bottleneck / early test generation predicts success" (as cited) — 0-3.
- "SWE-agent's gains are pure ACI, no decomposition" — 1-2 (partially unsupported).
- "Weaker model + strong scaffold beat stronger model + proprietary scaffold (CCA vs Anthropic)" — 0-3.

So: **"structure compensates for scale" is solid at ~70B and UNPROVEN below ~30B** on
repo-level tasks — the 35B stays pi-lab's floor for agentic legs.

## Open questions (re-check in 6–12 months)

1. Does trajectory tree search pay off at/below ~30B on real repo tasks, at what cost multiple?
2. How good must the critic/value function be for search to help rather than mislead?
   (Best@K vs Pass@K gaps say verifier quality is the binding constraint.) → D5 telemetry.
3. Do the techniques compose additively? (No study measured gates + search + compaction +
   role split together.)
4. Does ADaPT-style failure-triggered decomposition transfer to coding, and does
   weaker-executor-needs-deeper-decomposition hold for 30–70B coding models? → D4.

## Caveats

Benchmark horizon mismatch (SWE-bench Lite is tens of turns, not METR-style hours); several
key numbers are GPT-4-Turbo-era; ADaPT/self-conditioning results are non-coding; absolute
gains are single-digit pp on 300-instance benchmarks. Field moves fast — findings reflect
late-2024 → early-2026 literature.
