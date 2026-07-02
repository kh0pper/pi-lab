# pi-lab

Extensions for [pi-coding-agent](https://github.com/badlogic/pi-mono) that add Claude-Code-style workflows plus a self-hosted remote-access stack.

## Extensions

**Planning & delegation**

- **plan-mode** — `/plan` toggles a read-only exploration mode. On entry it pops a **planning-model picker** (run a frontier cloud model while you plan); choosing **Execute** pops an **execution-model picker** (drop to a cheap/local model with the whole planning conversation still in context). Accepted plans persist to `<repo>/.pi/plans/`. `/deep-plan <goal>` drives a scout→planner subagent chain.
- **subagent** — `subagent` tool spawning isolated child `pi` processes: single, parallel, and chain modes; per-agent `model:` frontmatter; `/agent-models` re-binds any agent's model interactively (persisted to settings `subagent.modelOverrides`).
- **critic** — `/critique [base-ref]` runs independent fresh-context critics (code-critic + test-critic) over your diff in parallel. Critics never see the authoring conversation — they judge the artifact, with an oracle-problem checklist for tests. Fenced-JSON verdicts, fail-closed, all-blocking.
- **permission-modes** — Claude-Code-style `/mode ask|accept-edits|auto|bypass` (Shift+Tab cycles). `auto` judges commands/tools with a small local classifier model — only risky ones prompt. A separate catastrophic-op guard stays on in every mode.
- **local-models** — `/serve`: start/stop local llama.cpp servers and switch to them; configured servers swap each other out to fit in RAM. The phone UI's model sheet does the same with live server state.
- **todo** — LLM-managed todo tool + `/todos` command. `/init` generates the repo's AGENTS.md.

**Remote access (self-hosted)**

- **web** — vendored fork of [@e9n/pi-webserver + @e9n/pi-mobile](https://github.com/espennilsen/pi) (MIT, see `extensions/web/THIRD_PARTY.md`): a shared loopback HTTP server per session + a mobile PWA for live chat/steering. Hardened: loopback-only binds, listen error handling, same-origin policy, Bearer-authenticated pages.
- **hub/** — the *Perch* daemon (systemd user service): every interactive pi session registers itself; a phone-friendly hub page shows live sessions with model/state data bars, proxies each session's UI at `/s/<pid>/`, resumes on-disk sessions into tmux, and spawns new ones. Front it with your reverse proxy of choice (Tailscale Serve works great).
- **remote-register** — the per-session glue (opt-in via settings `remoteRegister.hubUrl`).
- **session-web** — `/sessions` page + API (list, resume, spawn, teleport commands).
- **notify** — [ntfy](https://ntfy.sh) push notifications when a run finishes or a permission prompt blocks, with deep-links back to the hub.

**Harness improvements**

- **mcp-client** — bridges MCP servers from `~/.pi/agent/mcp.json` (stdio + HTTP), registering tools as `mcp__<server>__<tool>`.
- **permission-gating** — confirmation prompts for genuinely destructive operations only.
- **structured-compaction / session-state-loader** — structured session state across compactions and restarts.
- **bash-error-hint / tool-hint** — small quality-of-life hints.

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
