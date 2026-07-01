# pi-lab

Extensions for [pi-coding-agent](https://github.com/badlogic/pi-mono) that add Claude-Code-style workflows plus a self-hosted remote-access stack.

## Extensions

**Planning & delegation**

- **plan-mode** — `/plan` toggles a read-only exploration mode. On entry it pops a **planning-model picker** (run a frontier cloud model while you plan); choosing **Execute** pops an **execution-model picker** (drop to a cheap/local model with the whole planning conversation still in context). Accepted plans persist to `<repo>/.pi/plans/`. `/deep-plan <goal>` drives a scout→planner subagent chain.
- **subagent** — `subagent` tool spawning isolated child `pi` processes: single, parallel, and chain modes; per-agent `model:` frontmatter; `/agent-models` re-binds any agent's model interactively (persisted to settings `subagent.modelOverrides`).
- **critic** — `/critique [base-ref]` runs independent fresh-context critics (code-critic + test-critic) over your diff in parallel. Critics never see the authoring conversation — they judge the artifact, with an oracle-problem checklist for tests. Fenced-JSON verdicts, fail-closed, all-blocking.
- **todo** — LLM-managed todo tool + `/todos` command.

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

## Install

```bash
git clone https://github.com/kh0pper/pi-lab ~/pi-lab
# add "../../pi-lab" to the packages array in ~/.pi/agent/settings.json
bash ~/pi-lab/scripts/install-bridges.sh   # symlink agents/prompts into ~/.pi/agent
```

There is no build step — pi loads the TypeScript directly at startup.

Verify extensions load:

```bash
npm run test:extensions
```

## Configuration

Each extension reads its own key from `~/.pi/agent/settings.json`; every key is optional. See the doc comment at the top of each extension file for its settings.

## License

MIT. `extensions/web/` contains MIT-licensed code by Espen Nilsen — see `extensions/web/THIRD_PARTY.md`.
