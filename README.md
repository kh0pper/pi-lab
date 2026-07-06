# pi-lab

Extensions for [pi-coding-agent](https://github.com/badlogic/pi-mono) that add Claude-Code-style workflows plus a self-hosted remote-access stack.

The design goal behind most of what's here: **make 27B–35B local models produce the outcomes you'd expect from a frontier model, by supplying structure instead of parameters.** How that works — task decomposition, independent critics, adversarial refutation, structured fix dispatch — is written up in [How this harness makes local models punch above their weight](#how-this-harness-makes-local-models-punch-above-their-weight) below.

## Extensions

**Planning & delegation**

- **plan-mode** — `/plan` toggles a read-only exploration mode. On entry it pops a **planning-model picker** (run a frontier cloud model while you plan); choosing **Execute** pops an **execution-model picker** (drop to a cheap/local model with the whole planning conversation still in context). Accepted plans persist to `<repo>/.pi/plans/`. `/deep-plan <goal>` drives a scout→planner subagent chain.
- **subagent** — `subagent` tool spawning isolated child `pi` processes: single, parallel, and chain modes; per-agent `model:` frontmatter; `/agent-models` re-binds any agent's model interactively (persisted to settings `subagent.modelOverrides`). Chain legs carry a verdict contract with **decompose-on-failure**: a failed leg is split 2–4 ways by a local splitter agent and retried (see writeup).
- **permission-modes** — Claude-Code-style `/mode ask|accept-edits|auto|bypass` (Shift+Tab cycles). `auto` judges commands/tools with a small local classifier model — only risky ones prompt. A separate catastrophic-op guard stays on in every mode.
- **local-models** — `/serve`: start/stop local llama.cpp servers and switch to them; configured servers swap each other out to fit in RAM, and all lifecycle operations are serialized through one queue so concurrent swap points can't strand the slot. The phone UI's model sheet does the same with live server state.
- **todo** — LLM-managed todo tool + `/todos` command. `/init` generates the repo's AGENTS.md.

**Quality gates & recovery**

- **critic** — `/critique [base-ref]` runs independent fresh-context critics (code-critic + test-critic) over your diff in parallel. Critics never see the authoring conversation — they judge the artifact. Fenced-JSON verdicts, fail-closed. On top of that: fix-review mode (re-reviews of a failed run are judged against the original invariant, not the fix's wording), subsystem review (a project `.pi/critique.json` declares multi-file flows + invariants), an adversarial refute-pass that challenges blockers on a *different* local model, oversized-diff fan-out, a cross-model recall probe, and structured fix dispatch (findings cluster into per-subsystem fixer legs, with a warning when a leg completes without editing anything). Verdict-failure handling: a critic that works for a long time and ends without the fenced verdict gets one budgeted retry ("emit only the verdict for your own analysis"), and if that also fails, the raw output is dumped for diagnosis. Findings from a recent failed run *carry forward* into the next run's context until a passing run clears them — recall is stochastic run-to-run, so continuity is structural, not assumed. Auto-runs after plan execution.
- **tournament** — `/tournament [k] <task>`: best-of-N attempts, each snapshotted and rolled back via the checkpoint layer, scored by the same critics over the isolated diff; ranked by verdicts, then blockers, warns, and diff size before you apply the winner.
- **checkpoint** — a shadow git repo (never your repo) snapshots the working tree once per mutating prompt; `/rewind` restores files and/or conversation.
- **edit-gate** — syntax-checks every edit/write (js/py/sh/json) at tool time, so a subagent's broken edit is bounced back with the parser error instead of landing.
- **hooks** — Claude-Code-shaped shell hooks (same payload field names, so CC hooks port over); PreToolUse exit-2 blocks.
- **background-tasks** — `bash_background`/`task_output`/`task_kill`; completion wakes the agent instead of polling.
- **ask-user** — an AskUserQuestion-style tool: the agent blocks on a question, TUI selector and phone card race, first answer wins.
- **handoff** — `/handoff` summarizes the session, persists it per-project, clears context, and re-injects; a fresh session in the same directory auto-loads a recent handoff.

**Remote access (self-hosted)**

- **web** — vendored fork of [@e9n/pi-webserver + @e9n/pi-mobile](https://github.com/espennilsen/pi) (MIT, see `extensions/web/THIRD_PARTY.md`): a shared loopback HTTP server per session + a mobile PWA for live chat/steering. Hardened: loopback-only binds, listen error handling, same-origin policy, Bearer-authenticated pages.
- **hub/** — the *Perch* daemon (systemd user service): every interactive pi session registers itself; a phone-friendly hub page shows live sessions with model/state data bars, proxies each session's UI at `/s/<pid>/`, resumes on-disk sessions into tmux, and spawns new ones. Front it with your reverse proxy of choice (Tailscale Serve works great).
- **remote-register** — the per-session glue (opt-in via settings `remoteRegister.hubUrl`).
- **session-web** — `/sessions` page + API (list, resume, spawn, teleport commands).
- **notify** — [ntfy](https://ntfy.sh) push notifications when a run finishes or a permission prompt blocks, with deep-links back to the hub.

**Harness improvements**

- **mcp-client** — bridges MCP servers from `~/.pi/agent/mcp.json` (stdio + HTTP), registering tools as `mcp__<server>__<tool>`. Per-project opt-in and a router mode (one gateway tool per server instead of every schema) keep the system-prompt token cost down.
- **permission-gating** — confirmation prompts for genuinely destructive operations only.
- **structured-compaction / session-state-loader** — structured session state across compactions and restarts.
- **bash-error-hint / tool-hint** — small quality-of-life hints.

## How this harness makes local models punch above their weight

Everything below was built for, and validated on, dense/MoE local models in the 27B–35B class running on a single workstation. The premise: at this scale the *model* is rarely the bottleneck — **context discipline is**. A 35B that has drifted through forty turns of tool output misses things a fresh 35B with a two-paragraph mandate catches instantly. So the harness spends its effort manufacturing fresh, narrow contexts, and wiring them together with contracts that don't trust any single model output.

The empirical grounding for this section is a real failure: a small offline-first PWA was built end-to-end by local models with two critique rounds applied, and an independent full-codebase review afterwards still found P0 data-loss bugs — several *inside the fixes the critics had already approved*. The full analysis is in [docs/critic-postmortem-life-2026-07.md](docs/critic-postmortem-life-2026-07.md); each mechanism below either predates that episode or exists because of it.

### 1. Decompose until each step fits the model

The `/implement` path never hands a local model the whole feature. A **scout** leg maps the relevant code, an **architect** leg turns that map into a concrete edit plan, an **editor** leg applies it — each a fresh process with only the previous leg's structured summary (`{previous}`) as inherited context. Each leg runs under a turn budget (`subagent.maxStepsPerLeg`) with one fresh retry, because a local model that has been going in circles for 24 turns does not recover by getting more turns.

When a chain leg *does* fail — explicit failure verdict, hard error, or a double budget kill — **decompose-on-failure (D4)** hands the step to a small local `splitter` agent that splits it into 2–4 sub-steps, re-run with the same agent and the original context, one recursion level deep. The research behind the defaults is in [docs/research/task-decomposition-2026-07.md](docs/research/task-decomposition-2026-07.md).

One design choice worth copying: the leg verdict contract is **fail-open**. A leg ends with a fenced verdict block; a *missing* verdict counts as success. A forgotten verdict must cost nothing, or every slightly-forgetful local model run would cascade into pointless decompositions. The critics (below) make the exactly opposite choice — and the asymmetry is the point: fail open where forgetting must be free, fail closed where silence must block.

### 2. Review with independent, fresh-context critics

`/critique` spawns critics as fresh processes that see the diff (plus the plan spec, when one exists) and **never the authoring conversation**. The author's rationalizations don't transfer; the critic re-derives what the code does from the code. Verdicts are fenced JSON and **fail-closed**: output that doesn't parse is a FAILED review, because an unreadable verdict must never silently pass a change.

Two scope mechanisms keep a small model's attention where the bugs are:

- **Oversized-diff fan-out** — a diff too big for one context is split by file into byte-bounded chunks and every critic reviews *every chunk's real inline diff*, verdicts merged per critic. The previous behavior ("diff too large — open the files yourself") let coverage depend on which files the model chose to open; in the post-mortem, the misses were precisely in the unopened files.
- **Sibling context** — same-directory files are surfaced alongside the diff, so cross-file framework behavior (a `+page.server.ts` beside the `+page.svelte` under review) is visible instead of guessed at.

### 3. Close the recall gaps a real post-mortem exposed

The post-mortem sorted the escaped bugs into five classes, and each got a structural answer rather than a prompt tweak:

| Escaped defect class | Harness answer |
|---|---|
| Fixes judged by their wording ("patch matches the finding text") | **Fix-review mode**: findings persist to a sidecar; a re-review after a failed run carries the original findings, the FULL contents of overlapping files, and an instruction to judge against the restated *invariant* — a fix that satisfies the sentence but not the invariant fails |
| Multi-file protocol bugs invisible in any one hunk | **Subsystem review**: the project declares flows in `.pi/critique.json` (`{"subsystems": {"sync": {"globs": [...], "invariants": [...]}}}`); when a diff touches one, critics read the whole declared file set and check the invariants end-to-end |
| Framework-semantics traps (async lifecycle cleanup, GET side effects, unchecked `res.ok`) | An explicit framework-semantics checklist in the code-critic prompt — 35B-class models pattern-match generic JS and miss framework contracts unless told to look |
| Tests that share the executor's blind spot (fetch mocks with no `ok`/`status` at all) | A **mock-fidelity** check in the test-critic prompt: test doubles must be able to represent the real interface's failure modes |
| Test suites that were written, "fixed", and never once executed | The **chain test-run gate**: a leg whose observed tool calls edited test files without any observed test-command execution gets one follow-up leg that must run them and report counts. Ground truth is the tool-call log — never the model's claim that it ran something |

### 4. Keep precision up with cheap adversarial skepticism

Recall improvements are worthless if they drown you in false blockers, so blockers face structural resistance:

- **Evidence or downgrade** — a blocker asserting runtime behavior must carry a run or a quote, or it's demoted to a warning.
- **The refute-pass** — every surviving blocker is handed to a `refuter` agent running on a **different local model** than the one that raised it, prompted to *disprove* it. A refuted blocker downgrades to a warning with the rebuttal attached. The direction of failure is chosen deliberately: an uncertain or unparseable refuter leaves the blocker **standing** (fail-open-to-blocker), and a verdict that failed to parse can never be flipped to passed by refutation.
- Race claims must name the interleaving point — the post-mortem's worst false positive was a "read-modify-write race" in fully synchronous single-threaded code.

Model diversity here is *local* diversity (e.g. a 27B dense model refuting a 35B MoE's blockers). You don't need a frontier model to be a useful skeptic; you need a model with different failure modes.

### 5. Turn findings into structured fixes, not one giant prompt

The traditional failure mode after review: paste all findings into the chat and hope. Instead, **fix dispatch** clusters the failed verdicts' findings by declared subsystem (falling back to file), and dispatches **one `fixer` chain leg per cluster** — through the *same* chain executor `/implement` uses, so the test-run gate and decompose-on-failure fire per cluster, and a bad fix in one cluster can't corrupt the others. Cited paths are canonicalized against the changed-file list first, so the same file cited two ways can't split a cluster. In the validation run, five clustered fixer legs on a 35B fixed every confirmed blocker and added regression tests, unattended.

### 6. Select instead of iterate when variance is high

For tasks where local-model attempts vary wildly in quality, `/tournament` runs best-of-N: each attempt executes against a checkpoint snapshot and is rolled back; the critics score each attempt's isolated diff; ranking is verdict passes, then blocker count, then warnings, then diff size. Selection sidesteps a weakness of iteration — a local model asked to fix its own mediocre attempt tends to defend it, while the best of five independent attempts is often simply *good*.

Notably, tournament auto-trigger ships **disabled**. The post-mortem showed why: the obvious telemetry (critics agree, verdicts parse, user accepted findings) would have scored that failed episode perfectly — same-family critics agreeing measures consistency, not correctness. The flip is gated on cross-model recall-probe data accumulating first (criteria in [docs/ROADMAP.md](docs/ROADMAP.md)).

### The result that justified all of this

After the harness upgrades, the same review was re-run two ways on the codebase the original critics had passed twice:

- A **27B** with the upgraded prompts and declared subsystem invariants caught **all five** P0 data-loss classes the original rounds had missed.
- A **35B** on the identical harness caught those five **plus two more** (an e2e config that could never run, and a cursor-reset edge), warm in a fraction of the wall-clock.

Same models that had missed everything before; the recall gain came from the harness, not from parameters. That — plus the fail-open/fail-closed asymmetry, tool-call logs as the only ground truth, and one-concern-per-context — is the whole strategy.

A closing observation from running the full loop end-to-end: **recall is stochastic run-to-run.** The same critic that found a P0 data-loss bug in one round failed to re-find it two rounds later on the same artifact. You cannot prompt that away — you engineer around it: findings persist and carry forward across failed runs until a passing review clears them, verdict parse failures get a recovery retry instead of discarding hours of analysis, and every "it worked" claim is checked against observed tool calls rather than the model's say-so. Treat any single local-model review as a sample, never a proof, and make the harness accumulate what the samples find.

## Setup with pi-coding-agent

**Prerequisite:** a working [pi](https://github.com/badlogic/pi-mono) install (`npm install -g @mariozechner/pi-coding-agent`, or the scope your distribution uses) with at least one model provider configured.

**1. Clone the package:**

```bash
git clone https://github.com/kh0pper/pi-lab ~/pi-lab
```

**2. Register it with pi.** Add the clone to the `packages` array in `~/.pi/agent/settings.json` (path is relative to that file, so `../../pi-lab` = `~/pi-lab`):

```json
{
  "packages": ["../../pi-lab"]
}
```

**3. Install the agent/prompt symlinks** (subagent definitions, slash-command prompts, and any Claude Code skill bridges you have):

```bash
bash ~/pi-lab/scripts/install-bridges.sh
```

**4. Bind models.** The bundled agents reference example providers (`zai-coding`, `crow-local`). Point them at *your* providers either by editing the `model:` frontmatter in `extensions/subagent/agents/*.md`, or interactively with `/agent-models` inside pi. Providers live in `~/.pi/agent/models.json`, e.g.:

```json
{
  "providers": {
    "openai": {
      "name": "OpenAI",
      "baseUrl": "https://api.openai.com/v1",
      "api": "openai-completions",
      "apiKey": "OPENAI_API_KEY",
      "models": [{ "id": "gpt-5.2", "name": "GPT-5.2", "contextWindow": 400000, "maxTokens": 32000 }]
    }
  }
}
```

Any OpenAI-compatible endpoint works the same way (local llama.cpp, z.ai, …) — set `baseUrl` accordingly. `apiKey` accepts a literal key, an env-var name, or a `!command` that prints the key.

**5. Restart pi.** Extensions load at session start (no build step — pi imports the TypeScript directly). You should see `plan-mode, subagent, critic, notify, web, …` in the startup extensions list.

**6. Verify:**

```bash
cd ~/pi-lab && npm run test:extensions   # loader gate
# then inside pi: /plan  →  the planning-model picker should appear
```

**Optional — remote hub (Perch):** `bash ~/pi-lab/hub/install.sh` installs the per-machine hub as a systemd user service, and setting `"remoteRegister": { "hubUrl": "http://127.0.0.1:4201" }` in settings.json makes every interactive session appear in it. Set `"pi-webserver": { "apiToken": "<openssl rand -hex 32>" }` for auth, and front `127.0.0.1:4200` with your HTTPS proxy (Tailscale Serve, Caddy, …).

**Optional — push notifications:** run an [ntfy](https://ntfy.sh) server and set `"notify": { "url": "https://your-ntfy-host", "topic": "pi", "token": "tk_..." }`.

## Configuration

Each extension reads its own key from `~/.pi/agent/settings.json`; every key is optional. See the doc comment at the top of each extension file for its settings.

## License

MIT. `extensions/web/` contains MIT-licensed code by Espen Nilsen — see `extensions/web/THIRD_PARTY.md`.
