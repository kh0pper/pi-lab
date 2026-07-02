# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. Pi also reads it natively (it loads AGENTS.md or CLAUDE.md at session start).

## What this repo is

A "pi package" loaded by [pi-coding-agent](https://github.com/badlogic/pi-mono) at runtime (the installed fork is `@earendil-works/pi-coding-agent`; source imports use the old `@mariozechner/*` scope, resolved by pi's runtime alias map). It turns pi into a full Claude-Code-style harness: plan mode with plan/execute model pickers, subagents, independent critics, permission modes with a local classifier, ntfy push notifications, and a self-hosted remote-access stack (the **Perch** hub + mobile PWA).

Pi discovers this package via `package.json` → `pi.extensions: ["./extensions"]`, importing every `.ts` file in `extensions/` and each subdir's `index.ts` **via jiti at runtime**. No build step — edit, save, restart pi.

## Layout

```
extensions/
  plan-mode/          /plan (+ model pickers), /deep-plan, plan persistence to .pi/plans/
  subagent/           subagent tool (single/parallel/chain), agents/*.md, run.ts spawn runner,
                      /agent-models re-binding; prompts/*.md become slash commands (incl. /init)
  critic/             /critique — independent fresh-context critics; auto-runs after plan execution
  permission-modes.ts /mode ask|accept-edits|auto|bypass; auto uses a local classifier model
  permission-gating.ts catastrophic-op backstop (always active, all modes)
  web/                vendored fork of @e9n/pi-webserver + pi-mobile (MIT, see THIRD_PARTY.md):
                      shared loopback HTTP server + the Perch session PWA + send_user_file tool
  session-web/        /sessions page + API (list/resume/spawn/teleport)
  remote-register.ts  per-session glue: registers with the pi-hub daemon (opt-in via settings)
  notify.ts           ntfy pushes (run finished / needs input / web-initiated replies)
  mcp-client.ts, todo.ts, bash-error-hint.ts, tool-hint.ts,
  structured-compaction.ts, session-state-loader.ts, local-models.ts (/serve)
hub/                  Perch daemon (standalone Node, systemd user service) + install.sh
lib/                  sessions.mjs, local-models.mjs — plain ESM shared by extensions AND the hub
scripts/install-bridges.sh   symlinks agents/prompts/skills into ~/.pi/agent (re-runnable)
bin/pi-extension-check       jiti load-check for a single extension
```

## Common commands

```bash
npm run test:extensions            # loader gate — run before every commit
./bin/pi-extension-check extensions/<name>.ts
bash scripts/install-bridges.sh    # after pulling or adding agents/prompts/skills
bash hub/install.sh                # (re)install the pi-hub systemd user service
```

The gate SKIPs files that value-import pi internals or pi-ai (`todo.ts`, `subagent/index.ts`, `plan-mode/index.ts`, `web/index.ts`, `critic/index.ts`, `permission-modes.ts`) — the standalone jiti has no runtime alias map, so those are known false negatives, fine at pi runtime. Prefer **type-only imports** in new extensions so the gate stays meaningful. Runtime-verify event-driven code through a tmux session, never `-p` (see Don't break).

## Extension authoring contract

Every `extensions/*.ts` (or subdir `index.ts`) must default-export `(pi: ExtensionAPI) => void`. Anything else silently doesn't load.

- **`before_agent_start`**: to modify the system prompt, RETURN `{ systemPrompt: event.systemPrompt + … }` — the runner chains results across extensions. `event.systemPromptOptions` looks mutable but isn't.
- **`tool_call`**: return `{ block, reason }` to gate; mutate `event.input` in place to modify args (plan-mode injects `toolsOverride` into subagent calls this way).
- **`tool_result`**: return `{ content, details, isError }` to transform what the LLM sees.
- **Web-dispatched slash commands arrive as BUS events (`command:<name>`), not via `registerCommand`** — pi's web prompt route emits them. Any command that should work from the phone needs a `pi.events.on("command:<name>", …)` bridge with a captured ctx (see plan-mode, critic, todo). Unknown command-shaped input from the web is rejected before it can reach the model (it used to freelance into MCP tools).
- **Bot-exclusion invariant**: every extension with ambient side effects (servers, notifications, hub registration, subagent user-agent discovery, permission modes) must no-op when `PI_BOT_PERMISSION_POLICY` is set or `PIBOT_SUBAGENT_DEPTH >= 1`. Bots have their own policy system; breaking this exposes bot sessions or burns paid quota.
- Per-extension config lives under its own key in `~/.pi/agent/settings.json`; read it fresh (live edits should apply without restart where cheap).

## Key subsystems

- **Model pickers / bindings**: `/plan` snapshots tools + model, pops a planning-model picker; Execute pops an execution-model picker (whole planning conversation carries over). Always use `provider/id` form — bare ids can be ambiguous across providers. `/agent-models` persists re-binds to `settings.subagent.modelOverrides`, applied per spawn by `subagent/run.ts` (`forceModel` > settings override > frontmatter).
- **Critics** (tenet port): fresh pi process per critic, sees the diff + optional `.pi/plans/` spec, never the conversation. Fail-closed fenced-JSON verdicts. Local models by default; `/critique frontier` for GLM. Auto-runs on the `plan-mode:complete` bus event (`critic.auto`).
- **Permission modes**: `auto` classifies commands/tools via `permissionModes.classifierUrl` (a small always-on local model — e.g. a 4B via vLLM with `enable_thinking:false`, ~0.2s verdicts) with fallback to the session's current model, then fail-closed prompting. `permission-gating.ts` stays active in every mode as the catastrophic backstop.
- **Local model orchestration**: `settings.localModels` maps `provider/id` → compose dir + health URL + evicts list. Policy: one local model at a time (each evicts all others). Readiness gates on llama.cpp `/health` — `/v1/models` answers 200 while weights are still loading. MTP-flagged composes need image `kyuz0/amd-strix-halo-toolboxes:vulkan-radv-mtp`.
- **Perch hub** (`hub/server.mjs`): public listener :4200 (Bearer = `pi-webserver.apiToken`, cookie login) behind your HTTPS reverse proxy; registry listener :4201 loopback-only and NEVER in the Serve config (Serve traffic arrives from 127.0.0.1 — not exposing the port is the only protection). Proxies `/s/<pid>/…` to per-session servers with Bearer injected.

## Deployment

Clone to `~/pi-lab`, add `"../../pi-lab"` to the `packages` array in `~/.pi/agent/settings.json`, run `bash scripts/install-bridges.sh`, restart pi. Update = `git pull` + rerun the bridge script + restart pi sessions (and the pi-hub service if hub/web changed). **Never load this alongside the original `npm:@e9n/*` packages** — they dual-load against the vendored `extensions/web/` and race for port 4100.

## Don't break

- **Don't end a JSDoc line with `*/` inside shell-command examples** (e.g. `dd of=/dev/...`) — TypeScript ends the comment. Past real bug.
- **No shell-string spawning** — use `execFile`/argv arrays (hook enforces this). When spawning `pi` for tmux sessions, resolve binaries absolutely and wrap with `env PATH=…` — systemd's bare PATH kills the pi shim's `#!/usr/bin/env node` (past real bug in hub spawns).
- **`before_agent_start` chain pattern** — see contract above; only a smoke test catches violations.
- **No lifecycle events in print mode** (`pi -p`, v0.74.2): extensions load, tools register, but `session_start`/`agent_start`/`agent_end`/bus-from-handlers never fire. Test event-driven behavior via `tmux send-keys`. Verified empirically 2026-07-01.
- **Files served on the authenticated web origin**: only inert raster images render inline; everything else must be attachment + nosniff (XSS). File-access ids come from `crypto.randomBytes`.
- **The exec-time tool restore** must use the `getActiveTools()` snapshot, never a hardcoded list — hardcoding once dropped subagent/todo/MCP tools for the rest of the session.
