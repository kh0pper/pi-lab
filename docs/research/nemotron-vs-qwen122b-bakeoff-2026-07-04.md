# Nemotron 3 Super 120B vs Qwen3.5 122B — crow bake-off, 2026-07-04

Head-to-head for the long-horizon orchestrator seat (`planMode.execModel`).
Both models ran on crow (Ryzen AI Max+ 395, 128 GB unified, llama.cpp Vulkan,
one heavy model at a time), same test battery, same haystack generator
(seeded RNG, needle at 40% depth, temperature 0).

## Summary

| | Nemotron 3 Super 120B-A12B | Qwen3.5 122B-A10B |
|---|---|---|
| Quant / weights | UD-IQ4_XS, **60 GB** | UD-Q4_K_XL, **75 GB** (+mmproj) |
| Configured ctx (`-c`) | **262,144** (native 1M) | 131,072 (native 262k) |
| 100k needle (40% depth) | **PASS** (exact) | **PASS** (exact) |
| Prompt processing @100k | **168.9 t/s** (10.1 min) | 154.8 t/s (11.0 min); 178 t/s on 73k |
| Generation @0 ctx | 14.4 t/s | **30.0 t/s** |
| Generation @100k ctx | 13.7 t/s (flat) | **25.8 t/s** |
| Reasoning discipline | **Excellent** — needle answer in 158 tokens; complete code module in 990 tokens | Poor at temp 0 — burned a 6,000-token budget on pure reasoning, **zero code emitted**; needle took 403 tokens |
| Effective code-gen wall | **71 s** (task done) | 201 s (task not done) |
| pi tool test (write/bash/ask_user) | PASS (2026-07-04 ntest) | PASS (2026-07-04 qtest) |
| System RAM, model loaded | 103 GB used / **21 GB avail** | 119.6 GB used / **8 GB avail** (94%!), 13 GB swap |
| RAM floor during 100k fill | 14 GB avail | 4.2 GB avail |

## The tests

**Needle retrieval.** 102k-token pseudo-journal haystack, planted passphrase at
40% depth, "reply with just the passphrase." Both models retrieved it exactly,
and both correctly located it in their reasoning. Nemotron's llama.cpp prefix
cache made the re-ask 11.8 s (102,502 cached tokens).

**Timed code generation.** Identical prompt (thread-safe token-bucket rate
limiter module). Nemotron reasoned briefly and delivered a complete 3 KB module
in 990 tokens / 71 s. Qwen3.5-122B at temperature 0 never stopped reasoning —
5,626 reasoning tokens against a 6,000 cap with no code emitted. (Its needle
answer, a smaller ask, did terminate.) At sampled temperatures in a real pi
session it does finish, but the overthinking tax is real: its 2× raw speed is
cancelled several times over by token burn on tasks Nemotron dispatches
concisely.

**pi tool-calling.** Scratch pi session per model (tmux, mobile-API driven):
write → bash → ask_user, answered via `/api/mobile/chat/answer`. Both passed
all three. Note for future scratch tests: a full pi session's system prompt on
this box is **~73k tokens** (333 tools' schemas), so the first turn costs ~7
minutes of prompt processing on either heavy model.

## RAM analysis — the 1M question

Measured, not estimated:

- Nemotron at `-c 262144`: 103 GB used at load (60 GB weights + ~24 GB
  KV/compute + system). Filling 100k of context consumed ~7 GB more
  (context-checkpoint growth), floor 14 GB available.
- Extrapolated to a **full** 262k context: ~121 GB used, ~3–7 GB available —
  already marginal.
- `-c 1048576` (4× the KV/compute allocation, ≈ +72 GB): **~175 GB total. Does
  not fit in 128 GB. Do not attempt.**
- Even 512k (~+24 GB) would OOM under deep fill. Absolute experimental ceiling
  is ~320–384k in a supervised window with an out-of-process watchdog; there is
  no unattended-safe setting above 262k.

**Verdict: keep `-c 262144`.** `models.json` already declares
`contextWindow: 262144` — config is correct as-is, nothing to raise. The
"native 1M" capability is unreachable on a 128 GB box with 60 GB of weights.

## Recommendation

**Nemotron 3 Super takes the long-horizon orchestrator seat.** Against the
122B it wins on everything that matters for plan execution: double the usable
context (262k vs 131k), disciplined reasoning (it finishes tasks in ~⅓ the
wall time despite half the raw t/s), flat generation speed at 100k depth, a
passing needle, and 21 GB of RAM headroom where the 122B leaves 5–8 GB and
pushes the box to 94%.

Caveats before flipping `planMode.execModel` to
`crow-local-nemotron/nemotron-3-super-120b-a12b`:

- **14 t/s generation** is slow when the executor writes a lot of code
  directly. The scout → architect → editor delegation path mitigates this
  (legs run on smaller bound models); pure `/implement-worker`-style direct
  execution would feel it.
- **Cold start**: swap-in (evict 35B, load 60 GB) ≈ 1–2 min, plus ~7 min
  first-turn system-prompt processing in a fresh session. Fine for long
  sessions, poor for quick one-offs — the 35B stays the right resident
  default.
- Not applied automatically; flip it in the PWA Session tab or set
  `planMode.execModel` when wanted.

## Side findings

- **ntest SSE oddity — resolved, not a bug.** The scratch session's web server
  moved ports during setup (early `/web` command bound 4102; the full stack's
  4-mount server ended on 4100). The pings-only stream was a watcher on a
  stale/wrong port. Today's qtest run captured the complete event stream
  (`agent_start`/`tool_start`/`tool_end`/`ask_user`/`turn_end`) on the correct
  port, first try.
- llama.cpp `/v1/models` answers 200 while weights load; `/health` is the real
  readiness gate (already encoded in `lib/local-models.mjs`).
- Both models hide answers in `reasoning_content` — API clients must read it
  or budget `max_tokens` ≫ 100 (Nemotron's first needle "answer" was empty
  because 100 tokens all went to reasoning).

## End state (verified)

35B resident and healthy on :8003, Nemotron and 122B composes down, GTT back
to 59 GB, 56 GB available. Scratch tmux sessions (`ntest`, `qtest`) killed;
the deadman restore watchdog was disarmed after verification.

---

## Addendum (same day): Nano 30B 1M bake-off + speculative decoding + prompt diet

### Nemotron 3 Nano 30B-A3B (UD-Q5_K_XL, 27.5 GB, port 8009)

| | result |
|---|---|
| Load at `-c 524288` | GTT 55.6 GB total, 61 GB RAM free |
| Load at `-c 1048576` | GTT **61.5 GB** (KV only +6 GB for +512k — the Mamba hybrid's 6 attention layers), 57.8 GB free. 1M *fits* with huge margin. |
| Gen speed | 62.9 t/s at zero ctx, 33.8 t/s at 450k, 21.7 t/s at 984k |
| Prompt speed | ~440 t/s early → ~45 t/s at 900k depth (avg 43–226 t/s depending on depth) |
| Needle 100k-class | (not run — superseded by deeper tests) |
| Needle **450k** @40% | temp 0: FAIL (repetition loop — greedy artifact); **temp 0.6: PASS exact** |
| Needle **984k** @40% | **FAIL twice** at temp 0.6 (confabulated once, budget-exhausted reasoning once) |

**Verdict: reliable to ~500k, unreliable at ~1M.** Config committed at
`-c 524288` (`crow-local-nano/nemotron-3-nano-30b-a3b`, models.json matches).
The 1M allocation is RAM-safe if ever needed, but the model can't dependably
retrieve at that depth. Practical notes: cold-loading ~1M costs ~3.5 h of
prompt processing on this box — the window is for *incremental accumulation*
(each turn pays only its delta; prefix cache confirmed working, 984k cached
re-ask answered in ~3 min). Always sample Nemotron reasoning at temp ~0.6;
temp 0 degenerates at depth.

### Speculative decoding on Super 120B — both angles dead-ended (for now)

- **External draft (Nano 4B Q8)**: llama.cpp rejected the pairing —
  `add_bos_token` differs between the unsloth 4B GGUF and the Super, "target
  and draft vocabs are not compatible". Retry options: nvidia's own 4B GGUF,
  or flip the metadata bit with gguf-py (not installed).
- **ngram-simple self-speculation**: 15.3 vs 14.4 t/s baseline (+6%) on fresh
  code gen. Might do better on edit-heavy agent work (quotes existing text),
  not worth keeping as default. Super compose reverted to clean config.
- Native MTP remains the real prize — blocked on llama.cpp support + GGUFs
  lacking MTP tensors (ggml-org/llama.cpp#24145).

### System-prompt diet (shipped, pi-lab 671e116 + 3dd2662)

Default pi session: **333 tools / ~73k tokens → 110 tools / ~36k tokens.**
google-workspace ×2 now `optIn` (re-enable per project with
`{ "google-workspace": { "enabled": true } }` in `.mcp.json`); crow-browser +
crow-bots-sql now behind `router: true` gateway tools (list/describe/call,
smoke-tested with the 35B driving a real browser-status call). Nearest
`.mcp.json` now wins over global (was inverted).
