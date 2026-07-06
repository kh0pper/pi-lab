# Context-Loading Speedups (co-resident refute model + llama.cpp prefix cache) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **NOTE for this run:** executed INLINE by the orchestrating session (infra changes + live-run
> coordination on a prod box do not suit fresh subagents). Adversarial review applied (see ## Review).

**Goal:** Eliminate the 35b↔27b model swap from every refute-pass/probe/diverse-critique and enable llama.cpp prefix caching where it can actually engage — without touching the production 35B server or the solo full-context 27B workflow.

**Architecture:** Add a SECOND llama.cpp entry for the 27B ("copilot", port 8010, 65536 ctx, **text-only — no `--mmproj`**, `--cache-reuse 256`) that co-resides with the 35B. Introduce a distinct `"solo"` eviction group for the full-262k 27B so the matrix can express "evict the big solo, spare the copilot". Point `critic.refuteModel`/`critic.diverseModel` at the copilot. **No changes to the 35B or solo-27B composes at all** (their `--mmproj` disables cache-reuse server-side, and the 35B must not restart).

**Tech Stack:** docker compose (llama.cpp, kyuz0 Strix Halo image), `~/.pi/agent/settings.json` (`localModels`, `critic`), `~/.pi/agent/models.json` (providers), crow repo `docs/developers/port-allocation.md`.

## Global Constraints

- **Round-4 critique is LIVE on the 35b (`life-r3` tmux). The 35B compose file is not edited and the 35B container is never restarted by this plan.** (Reviewer: even editing that compose pre-completion is unsafe — restore closures / PIR scripts run `docker compose up -d` in that dir at any time and would apply drift.)
- **Memory budget (measured at review time): 47GB available with the 35b serving, 12GB swap already used.** Copilot realistic footprint ~30-32GB (24GB weights + ~4GB KV @65536 + buffers) → expected steady headroom ~15-17GB. **Abort gate: available <12GB OR swap grows >2GB from baseline during/after load → rollback.** Expect a transient dip during the 24GB GGUF read.
- **Do not change the solo 27b's context, flags, or one-tap-restore semantics.** Its full-262k capability and "restart the 35b to restore bots (evicting solo)" flow are deliberate.
- **Eviction matrix (reviewer-corrected, distinct groups):**
  - solo-27b: group `"solo"`, evicts `["heavy","standard"]` (unchanged list — still clears 35b + copilot to claim its ~41GB)
  - 35b: group `"standard"`, evicts `["heavy","solo"]` (was `["heavy","standard"]` — now spares the copilot, still evicts a running solo = one-tap restore preserved)
  - copilot-27b: group `"standard"`, evicts `["heavy","solo"]` (a refute while the user is on the solo evicts the solo — required: solo+copilot cannot co-fit; rare, documented)
  - all four heavies: evicts `["heavy","standard","solo"]` (each gains `"solo"` — a heavy still clears everything)
  - Mid-flight safety: the 35b's evicts change only ADDS the not-running `"solo"` group and REMOVES `"standard"` — round 4's in-flight restore closures behave identically or better (they stop evicting the copilot). Its cfg snapshot predates `critic.refuteModel`, so round 4's refute still uses the solo (expected: it will bounce the copilot once; copilot restarts in Task 4 Step 5 / self-heals on the next refute).
- **`--cache-reuse` engages ONLY on the copilot** — llama-server hard-disables it under multimodal (`cache_reuse is not supported by multimodal`, verified in the image binary). The copilot is text-only (refuter/probe/diverse-critique are diff reviews), so `--mmproj` is dropped there.
- **Port 8010** (tailscale-IP namespace, matches 8003/8006/8008/8009/8011 pattern; tailnet-only, no exposure change) — document in crow `docs/developers/port-allocation.md` with the binding IP explicit.
- **Copilot provider metadata:** `contextWindow: 65536`, `maxTokens: 8192` (critic/refuter outputs are verdicts — reserving 32k for generation would shrink the prompt budget below the ~40k-token worst-case fix-review artifact), `name` distinguishes it from the solo on model cards.
- **Un-restored copilot is accepted:** restore closures bring back exactly one model, so a heavy/solo session leaves the copilot down; it self-heals on the next refute (~2-3 min reload, once). Documented, plus validated in Task 4 Step 6.
- **PIR worst case noted:** `pir_model_swap.sh 27b` runs a third 27B (`:8003`, 65536 ctx, ~28GB, separate `--no-mmap` copy) with the 35B stopped: pir-27b (~28GB) + copilot (~30GB) ≈ 58GB — fits without the 35B; if the 35B is later restored by the PIR deadman, evicts `["heavy","solo"]` spares both → ~88GB models total; tight but within 124GB. Watch it; not a blocker.
- One local *slot* is no longer literally true for the standard pair — update stale wording only where touched.
- All `~/.pi/agent/settings.json` / `models.json` edits via python json round-trip, never sed. Back up `models.json` first.

---

### Task 1: Baseline measurements (read-only)

- [ ] **Step 1:** Record `free -g` (available + swap used), `docker stats --no-stream`, `ss -tlnp | grep 8010` (expect free) with the 35b serving.
- [ ] **Step 2:** Record the swap-cost baseline: round-3's refute swap (35b→27b→35b) wall-clock from `life-r3` scrollback/notify timestamps; today's `durationMs` rows.

### Task 2: Copilot 27b compose (new dir, port 8010, 65536 ctx, text-only, cache-reuse)

**Files:**
- Create: `/home/kh0pp/crow-addons/llamacpp-vulkan-qwen36-27b-copilot/docker-compose.yml`

**Interfaces:**
- Produces: llama.cpp server `qwen3.6-27b` on `${CROW_TAILSCALE_IP}:8010` (backend 8000 in-container), `/health` gate.

- [ ] **Step 1:** Write the compose file:

```yaml
services:
  llamacpp-vulkan-qwen36-27b-copilot:
    image: kyuz0/amd-strix-halo-toolboxes:rocm-7.2.1
    container_name: llamacpp-vulkan-qwen36-27b-copilot
    devices:
      - /dev/kfd
      - /dev/dri
    group_add:
      - "${VIDEO_GID}"
      - "${RENDER_GID}"
    env_file:
      - ${HOME}/.crow/env/rocm.env
    volumes:
      - ${LLM_CACHE}:/models
    ports:
      - "${CROW_TAILSCALE_IP}:8010:8000"
    entrypoint: ["llama-server"]
    command:
      # COPILOT instance of Qwen3.6-27B (2026-07-06): co-resides with the 35b
      # (group "standard", evicts heavy+solo) so the critic refute-pass /
      # recall probe / diverse critique stop paying a 35b eviction + reload
      # per run. 65536 ctx keeps KV ~4GB (262144 = 16GB measured on the solo
      # — too big to co-reside in the ~47GB headroom next to the 35b). The
      # SOLO 27b entry (port 8006, full 262144, vision) is unchanged.
      # TEXT-ONLY on purpose: no --mmproj, because llama-server disables
      # --cache-reuse under multimodal ("cache_reuse is not supported by
      # multimodal") — and cache-reuse (prefix KV reuse across requests with
      # mid-prompt divergence) is half the point of this instance. Refuters/
      # probe review diffs; they never need vision.
      # -np 1: concurrent refuters serialize server-side; acceptable latency
      # tradeoff to keep the whole 65536 window per request.
      - -m
      - /models/qwen36-27b/Qwen3.6-27B-UD-Q6_K_XL.gguf
      - --alias
      - qwen3.6-27b
      - --host
      - "0.0.0.0"
      - --port
      - "8000"
      - -ngl
      - "999"
      - -fa
      - "on"
      - --no-mmap
      - -c
      - "65536"
      - --cache-reuse
      - "256"
      - -np
      - "1"
      - --jinja
    restart: "no"
    ipc: host
    shm_size: 16g
```

- [ ] **Step 2:** Validate: `docker compose -f /home/kh0pp/crow-addons/llamacpp-vulkan-qwen36-27b-copilot/docker-compose.yml config -q` (expect silence). Do NOT start yet.

### Task 3: Register the copilot (settings.localModels + eviction groups, models.json, critic bindings)

**Files:**
- Modify: `~/.pi/agent/settings.json` (`localModels` + `critic`)
- Modify: `~/.pi/agent/models.json` (add provider `crow-local-27b-copilot`)

**Interfaces:**
- Produces: ref `crow-local-27b-copilot/qwen3.6-27b` resolvable by pi (provider) and manageable by `lib/local-models.mjs`.

- [ ] **Step 1:** `cp ~/.pi/agent/models.json ~/.pi/agent/models.json.bak.20260706`
- [ ] **Step 2 (python json round-trip)** in `settings.json`:
  - `localModels["crow-local-27b-copilot/qwen3.6-27b"] = { "composeDir": "/home/kh0pp/crow-addons/llamacpp-vulkan-qwen36-27b-copilot", "url": "http://100.118.41.122:8010/v1", "group": "standard", "evicts": ["heavy","solo"] }`
  - `localModels["crow-local-27b/qwen3.6-27b"].group = "solo"` (evicts stays `["heavy","standard"]`)
  - `localModels["crow-local/qwen3.6-35b-a3b"].evicts = ["heavy","solo"]`
  - each heavy (`crow-local-122b/...`, `crow-local-oss/...`, `crow-local-nemotron/...`, `crow-local-nano/...`): `evicts = ["heavy","standard","solo"]`
  - `critic.refuteModel = "crow-local-27b-copilot/qwen3.6-27b"`; `critic.diverseModel = "crow-local-27b-copilot/qwen3.6-27b"`
- [ ] **Step 3 (python json round-trip)** in `models.json`: clone the `crow-local-27b` provider as `crow-local-27b-copilot` — `baseUrl: "http://100.118.41.122:8010/v1"`, model `name` → `"Qwen3.6-27B copilot (co-resident, text)"`, `contextWindow: 65536`, `maxTokens: 8192`.
- [ ] **Step 4:** JSON sanity: both files `json.load` clean.
- [ ] **Step 5:** Eviction-matrix assertion via `node -e` on `lib/local-models.mjs`: 35b `["heavy","solo"]`; copilot `["heavy","solo"]`; solo group `"solo"` evicts `["heavy","standard"]`; every heavy contains `"solo"`.

### Task 4: Co-residency validation (live, memory- and swap-gated)

- [ ] **Step 1:** Record `free -g` (available + swap) baseline. `node -e` `startModel("crow-local-27b-copilot/qwen3.6-27b")` from `lib/local-models.mjs` — expect NO eviction lines for the 35b (solo/heavies not running).
- [ ] **Step 2:** Gate: `curl :8003/health` AND `curl :8010/health` → 200; `free -g` available ≥12GB AND swap grew ≤2GB. Below gate → rollback section.
- [ ] **Step 3:** 1-token completion against the 35b (bot service proof) and a 20-token completion against the copilot.
- [ ] **Step 4:** Prefix-cache measurement on the copilot: two chat requests sharing an ~8k-token prefix with different final questions; compare `prompt eval` tokens/time in `docker logs llamacpp-vulkan-qwen36-27b-copilot` (call 2 should prefill only the divergent tail; record numbers).
- [ ] **Step 5:** After round 4 completes: if its refute bounced the copilot (expected — stale cfg uses the solo), re-run Step 1-2 to bring the pair back and confirm steady-state numbers.
- [ ] **Step 6:** Un-restored-copilot drill: with both up, `stopModel(copilot)`, then `startModel(copilot)` — self-heal path timing (the "next refute" cost after a heavy ran).

### Task 5: Documentation + commits

**Files:**
- Modify: `/home/kh0pp/crow/docs/developers/port-allocation.md` (+8010 row, binding IP explicit)
- Modify: `~/pi-lab/docs/ROADMAP.md` (exploration → implemented, with measured numbers + what was NOT done and why: no 35b/solo cache-reuse (mmproj), task-ordering + KV save/restore deferred)
- Modify: `~/pi-lab/CLAUDE.md` (Local model orchestration: standards pair co-resides; solo group; copilot binding; refute/diverse default)
- Memory: `pi-lab-context-loading-ideas` → implemented state + numbers.

- [ ] **Step 1:** port-allocation.md row `| 8010 | 100.118.41.122 | llamacpp-vulkan-qwen36-27b-copilot (co-resident critic refute/probe model) | 2026-07-06 |`; commit in the crow repo (user identity, no Claude attribution).
- [ ] **Step 2:** ROADMAP + CLAUDE.md; commit pi-lab, push, `grackle git pull`.
- [ ] **Step 3:** Memory updates.

### Rollback (single step, safe any time)

`docker compose down` the copilot dir; restore `~/.pi/agent/models.json.bak.20260706`; revert the settings.json keys (delete copilot entry; 35b evicts → `["heavy","standard"]`; solo group → `"standard"`; heavies drop `"solo"`; delete `critic.refuteModel`/`critic.diverseModel`); delete the copilot compose dir. **No 35b restart involved in rollback** (its compose was never touched).

## Review

- **Reviewer verdict: REVISE** (adversarial Plan-subagent review, 2026-07-06). All five critical issues addressed:
  1. `--cache-reuse` dead under `--mmproj` (verified in the image binary) → copilot is now text-only (no mmproj) so the flag engages; **all 35b/solo compose changes dropped** — no production restart at all; measurement redesigned to shared-prefix/divergent-tail.
  2. Editing the live 35b compose pre-completion unsafe (restore closures/PIR run `up -d` anytime) → moot; file untouched.
  3. Mid-flight `evicts` flip OOM path (restore no longer evicting a 262k solo) → fixed by the distinct `"solo"` group: 35b evicts `["heavy","solo"]`, so restores still clear the solo.
  4. Broken one-tap-restore / copilot-vs-solo co-fit → same group fix; copilot also evicts `"solo"`; heavies gain `"solo"`.
  5. Memory-budget inconsistency → single gate (≥12GB available AND swap growth ≤2GB), measured 47GB/12GB-swap baseline recorded, load transient noted.
- Suggestions folded in: copilot provider `maxTokens: 8192` + distinct `name`; un-restored-copilot drill (Task 4 Step 6) + self-heal documented; PIR third-instance worst case quantified; `-np 1` tradeoff commented; registry staleness note (refuters spawn fresh `pi` with `--model` — no session restarts needed); rollback needs no 35b restart.
- Reviewer questions answered: copilot needs no vision (text-only diff work); prompt budget fixed via `maxTokens: 8192`; copilot self-heal on next refute accepted (+drill).
