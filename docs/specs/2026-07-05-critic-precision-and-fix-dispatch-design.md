# Critic precision + structured fix-dispatch — design (2026-07-05)

Follow-up to the life-app phase-0 validation (`docs/critic-postmortem-life-2026-07.md`).
The upgraded critics caught the incomplete drain-race fix (the goal), but the round
surfaced two weaknesses to address:

1. **A false-positive blocker** — the test-critic claimed `shell.spec.ts` fails because
   `+page.svelte` has no redirect logic, missing the server-side redirect in the sibling
   `+page.server.ts`. Two failure modes: an *unverified runtime claim*, and *cross-file
   framework blindness*.
2. **Mega-turn fix dispatch** — send-findings handed all ~11 findings to one 35B turn.
   It worked, but the drain-race fix came out wrong; a single turn has no per-fix
   checkpoint, no traceability, and no isolation.

Two independent workstreams, implemented as two plans. Ship Workstream 1 first — better
findings make better fix legs.

Decisions locked with the user (2026-07-05):
- Refute model: **configurable, default diverse-local** (`critic.refuteModel`).
- Fix dispatch: **K2 — editor-leg chain** (per-cluster subagent legs).
- Framework knowledge (idea D): **deferred (YAGNI)** — route-bundle context (E) should
  cover the observed miss; revisit only if a false positive slips past E.

Non-goals: no frontier-model dependency (local-only, per standing decision); no change to
the tournament path; no N-vote refute ensemble in v1 (single refuter, config knob later).

---

## Workstream 1 — Critic precision (`extensions/critic/index.ts`, critic agent prompts)

### 1A. Evidence-or-downgrade rule (prompt-only)

Add to **both** `code-critic.md` and `test-critic.md`:

> A finding marked **blocker** that asserts a runtime outcome — a test fails, code
> crashes, a call returns the wrong value — MUST include one of: (a) the exact command
> you ran and its actual output, or (b) a verbatim quote of the code lines that make the
> claim true. A blocker asserting runtime behavior with neither is not a blocker —
> downgrade it to `warn` and say you could not verify it. Reading is not running: if a
> cheap test command exists, run it before claiming a test fails.

- Scope: severity gate only. Warns are unaffected (they may be speculative).
- No code change. Testing: re-run the life critique; the shell.spec claim should either
  carry a run/quote or drop to warn.

### 1B. Route-bundle context (E) — sibling-file inclusion

**Behavior:** when the diff touches a file, include its *sibling files in the same
directory* in the critic's context, so behavior that spans a framework's file-group
(SvelteKit `+page.svelte` + `+page.server.ts` + `+layout*` + `+server.ts`; Next
`page.tsx` + `route.ts`; etc.) is visible without the critic having to guess the
framework's collaboration model.

**Design:**
- New helper `siblingContext(cwd, changedFiles, lsFiles)` in `critic/index.ts`.
- For each changed file, find same-directory files (from `git ls-files`) that are NOT
  themselves in the diff, cap per directory and overall (e.g. ≤ 6 siblings/dir, ≤ 40KB
  total across the note — bounded like fix-review), skip binary (reuse the BINARY_EXT
  guard) and lock/generated (reuse `DEFAULT_EXCLUDES`).
- Emit a note: "Sibling files in the same directory as changed files (read them — behavior
  may span them): <list>. Their current contents:\n<bounded inline or a read-with-tools
  pointer>." Appended to `sharedNote` alongside subsystem/fix-review.
- Config `critic.siblingContext` (default true), `critic.siblingMaxBytes` (default 40000).
- Interaction with fan-out: like fix-review, the *inline* form is single-artifact only; in
  fan-out mode emit the pointer/list form (names only) to avoid per-chunk multiplication.

**Testing:** unit-test `siblingContext` file selection (same-dir, excludes diff files,
excludes binary/lock, caps). Runtime: a diff touching only `+page.svelte` must surface
`+page.server.ts` in the note.

### 1C. Refute-pass on blockers (B)

**Behavior:** after the main critique, if there are blockers, run a refutation stage. Each
blocker is handed to a critic on a *different* model, prompted to refute it. A blocker that
is refuted is **downgraded to warn**, with both the original claim and the refutation shown
(never silently dropped).

**Design:**
- New critic agent `refuter` (`agents/refuter.md`): input = one blocker (severity, category,
  detail, cited files) + the changed-file list + sibling/subsystem context; tools =
  read/grep/find/ls/bash. Instruction: "Try to prove this blocker WRONG — behavior
  implemented in another file, a framework mechanism that handles it, an existing test that
  covers it, a false assumption about the runtime. Read the cited and sibling files; run a
  cheap reproduction if one exists. Verdict fenced JSON: `{"refuted": bool, "reason": "…"}`.
  Default `refuted:false` if you cannot find a concrete reason — do not refute on vibes."
- Fail-*open-to-blocker*: a refuter that errors / produces no parseable verdict leaves the
  blocker STANDING (opposite of the leg-verdict fail-open — a broken refuter must not erase
  a real blocker). Mirror critic's fail-closed instinct.
- Model policy: `critic.refuteModel` (default: pick a model *different* from the one the
  main critique ran on — if main ran on `crow-local/qwen3.6-35b-a3b`, refute on
  `critic.diverseModel` 27B; if main ran on the diverse/other model, refute on the default
  35B). Managed-local refute models reuse `ensureCriticModel` (start + background restore);
  since this serializes on the single slot, only run when blockers exist.
- Pipeline: refutation runs inside `critiqueArtifact` (or a wrapper) AFTER verdicts merge,
  BEFORE the telemetry row is finalized. Refuted blockers move to warns in the displayed
  verdict AND in the telemetry counts. Telemetry row gains `refuted: [{agent, detail,
  reason}]` and per-verdict `blockersRefuted`.
- Config `critic.refutePass` (default true). One refuter per blocker; `critic.refuteVotes`
  (default 1) reserved for later N-vote.
- Cost control: cap blockers refuted per run (e.g. `critic.refuteMax` default 8); beyond
  that, leave standing (log the cap).

**Display:** verdict shows surviving blockers, then a "Refuted (downgraded to warn)" section
listing claim + refutation, so the human sees what was knocked down and can override.

**Testing:** `parseRefuterVerdict` unit tests (fail-open-to-blocker on missing/garbled).
Runtime: re-run the life critique — the shell.spec blocker should be refuted (the refuter
reads `+page.server.ts`), while the real drain-race blocker should survive.

---

## Workstream 2 — Structured fix-dispatch, K2 editor-leg chain (`extensions/critic/index.ts` send-findings path)

**Today:** on "Send findings", `pi.sendUserMessage(all findings)` → one main-session turn.

**New:** cluster the findings, then run one **editor subagent leg per cluster** via the
existing chain runner, so each cluster fixes in fresh context with the test-run gate and
D4 decompose-on-failure active.

**Design:**
- **Clustering** (`clusterFindings(verdicts, subsystems)`): group by declared subsystem
  first (a finding whose cited file matches a subsystem's globs → that subsystem's cluster);
  remaining findings group by primary cited file (first `path`-looking token in the detail,
  or a `file` field if we start capturing it). Findings with no locatable file → one
  "general" cluster. Cap cluster count (`critic.fixMaxClusters`, default 6); merge smallest
  beyond the cap.
- **Dispatch:** build a subagent **chain**, one `editor` leg per cluster. Each leg's task =
  the cluster's findings + the cluster's files + the relevant subsystem invariants +
  "fix these; run the tests for these files; add a regression test where a blocker names a
  testable failure; end with the verdict block." `{previous}` threads a short summary so a
  later cluster sees what earlier ones changed. Runs through the same path `/implement`
  uses (chain → `runLegWithBudget` → test-run gate → D4).
- **Where it runs:** spawned from the critic extension via the subagent chain (like the
  tournament calls `critiqueArtifact`). Not the main-session agent — isolation is the point.
  The main session shows progress and the final per-cluster summary.
- **Guardrails:** honor the same bot-exclusion / plan-mode / handoff guards the other
  spawn paths use. Respect `toolsOverride` (none here — editors need write+bash).
- Config `critic.fixDispatch` = `"chain"` (K2, new default) | `"message"` (K1 legacy, the
  current single-message behavior) | `"off"`. Keeping `"message"` gives a fallback if chain
  dispatch misbehaves.
- **Traceability:** each cluster leg is labelled by cluster name; the decompose-log /
  progress shows which findings each leg addressed.

**Interaction with fix-review:** after the chain completes, the NEXT `/critique` naturally
runs in fix-review mode (sidecar has the failed findings) and judges the fixes — the loop we
already validated. Optionally (later) a per-cluster micro-critique before moving on
(`critic.fixReviewPerCluster`, default off) — deferred, not in v1.

**Testing:** unit-test `clusterFindings` (subsystem grouping, file grouping, cap/merge,
no-file general cluster). Runtime: dispatch the life findings; confirm N editor legs, each
naming its cluster, test-gate firing per leg, and a coherent final diff.

---

## Sequencing & rollout

1. **Plan 1 = Workstream 1** (1A prompt, 1B sibling context, 1C refute-pass). Validate by
   re-running the life critique: shell.spec refuted-or-downgraded, drain-race survives.
2. **Plan 2 = Workstream 2** (K2 chain dispatch). Validate by dispatching the life findings
   through clustered editor legs, then a fix-review critique of the result.
3. Docs: CLAUDE.md critic bullet + ROADMAP note per workstream. Telemetry additions
   (`refuted`, cluster labels) feed the existing flip-gate analysis.

## Risks / open items

- Refute-pass adds a model round on the single local slot — mitigated by blockers-only +
  cap + only-when-blockers-exist. Watch wall-clock on big reviews.
- Clustering heuristic quality depends on findings citing files; the evidence/quote rule
  (1A) increases citation rate, so 1A helps 2's clustering — nice compounding.
- Sibling-context + fix-review + subsystem notes could re-inflate task size; all are
  bounded and fan-out uses pointer-form. Keep an eye on the `@file` task sizes.
