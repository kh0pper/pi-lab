# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A "pi package" loaded by [pi-coding-agent](https://github.com/badlogic/pi-mono) at runtime. Provides MCP-client bridging, plan-mode, sub-agents, todos, plus a set of harness-improvement extensions (permission gating, structured compaction, system-prompt hints, bash error hints) and a verifier script.

Pi discovers this package via `package.json` → `pi.extensions: ["./extensions"]`. It then imports every `.ts` file in `extensions/` (and `index.ts` of each subdir) using **jiti at runtime**. There is **no build step** — edit, save, restart pi, done.

## Common commands

```bash
# Verify a single extension parses + loads + exports a function
./bin/pi-extension-check extensions/<name>.ts

# Run the verifier across every extension (gate before commit/push)
npm run test:extensions

# Install / update on a machine that uses this package
git clone https://github.com/kh0pper/pi-lab ~/pi-lab   # then add "../../pi-lab" to packages
cd ~/pi-lab && git pull                            # subsequent updates
```

There is no `npm test`, no linter, no type-checker configured. Type-checking happens implicitly via jiti's parse step (which is what `pi-extension-check` invokes) and via pi's own runtime when an extension's event handler fires.

The `npm test:extensions` script intentionally skips `extensions/todo.ts` — it imports `@mariozechner/pi-ai`, whose `exports` field only declares `import` (no `require`), and jiti's standalone resolver falls through to a CJS path that doesn't match. Pi's own runtime resolver handles it fine. If a new extension fails the verifier with `No "exports" main defined in @mariozechner/pi-ai/package.json`, the file is fine — add it to the skip list.

## Extension authoring contract

Every file in `extensions/` (or the `index.ts` of a subdir) **must default-export a function** of shape:

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.on("event_name", (event, ctx) => { /* ... */ });
  // or pi.registerTool(...), pi.registerCommand(...)
}
```

Anything else (no default export, wrong type) silently doesn't load.

### `before_agent_start`: chain `systemPrompt`, don't mutate options

Known footgun (caught us once already). The event has `event.systemPromptOptions: BuildSystemPromptOptions`, which **looks** mutable but is purely informational — pi has already built the system prompt by the time the event fires.

To modify the system prompt, **return** `{ systemPrompt: event.systemPrompt + "..." }`. The runner chains across extensions: each one sees the previous extension's result as its own `event.systemPrompt`, and the final result is what the LLM sees.

Both `tool-hint.ts` and `session-state-loader.ts` use this pattern. See `dist/core/extensions/runner.js` (`emitBeforeAgentStart`) in pi for the chain implementation.

### `tool_call` for guarding, `tool_result` for transforming

`tool_call` handlers return `{ block?: boolean, reason?: string }` to gate execution (used by `permission-gating.ts`). To modify args, mutate `event.input` in place — that one IS mutable.

`tool_result` handlers return `{ content?, details?, isError? }` to transform the result the LLM sees (used by `bash-error-hint.ts`). Doesn't have to block; can just augment.

### `session_compact` for post-compaction work

Fires AFTER pi's default compaction completes. `event.compactionEntry.summary` is the markdown narrative. `structured-compaction.ts` parses its `## Decisions` / `## Open Items` / `## Next Steps` headers and writes a structured JSON state file — without making its own LLM call.

### Per-extension config

Each extension that has settings reads its own key out of `~/.pi/agent/settings.json`:

```json
{
  "bashErrorHint": { "enabled": true },
  "toolHint":      { "enabled": true },
  "structuredCompaction": { "enabled": true, "stateFilePath": "~/.pi/agent/session-state.json" },
  "sessionStateLoader":   { "enabled": true, "stateFilePath": "~/.pi/agent/session-state.json", "maxContextLength": 2000 }
}
```

All settings are optional. Default is enabled.

## Architecture

### Two extension shapes

- **Single `.ts` file**: small, single-purpose extensions. Examples: `bash-error-hint.ts`, `tool-hint.ts`, `permission-gating.ts`, `session-state-loader.ts`, `structured-compaction.ts`, `mcp-client.ts`, `todo.ts`.
- **Subdirectory with `index.ts`** (and helper files): for compound extensions with multi-file logic. Examples: `plan-mode/` (utils.ts, README.md), `subagent/` (agents.ts, agents/, prompts/, README.md).

Pi discovers `extensions/*.ts` and `extensions/*/index.ts` indistinguishably. Use a subdir when the helpers would clutter the main file.

### `mcp-client.ts` — the MCP bridge

Reads `~/.pi/agent/mcp.json` (and `.mcp.json` in cwd ancestors), connects to each server, registers each tool as `mcp__<server>__<tool>`. Two transport shapes in mcp.json:

```json
"name": { "command": "...", "args": [...], "env": {...}, "cwd": "..." }
"name": { "url": "https://host/path/mcp", "headers": {...}, "transport": "streamable" | "sse" }
```

The first shape is stdio. The second is HTTP (Streamable HTTP per the 2025-03-26 MCP spec, or legacy SSE). Default for the URL form is `streamable`. The MCP SDK is bundled as a direct dep so we get a pinned version.

### `structured-compaction` + `session-state-loader` pair

They share `~/.pi/agent/session-state.json`:
- **structured-compaction** writes after each compaction (parses pi's narrative summary into structured fields).
- **session-state-loader** reads on `before_agent_start` and chains a "Previous Session Context" block onto the system prompt.

This gives continuity across compactions and across sessions without an extra LLM round-trip.

### `permission-gating.ts` design rule

Designed to fire *rarely*. Every false-positive trains the user to reflexively approve, defeating the purpose. Patterns are intentionally narrow: catastrophic bash only (`rm -rf` on root/`$HOME`, `sudo rm`, `dd of=/dev/...`, `mkfs`, fork bomb, shutdown), and writes/edits only to actual-secret paths (`.env`, `.key`, `.pem`, `.ssh/`, `.aws/`, `/etc/`, `/usr/`, `/root/`, `/boot/`). Project files (`package.json`, `Dockerfile`, `*.sql`) are intentionally NOT gated — they're version-controlled.

Per-session memory: when the user answers a prompt, the answer is remembered for that exact pattern/path until pi restarts. Each pattern only prompts once.

### `install-bridges.sh`

Symlinks external skill trees into `~/.pi/agent/skills/` so pi auto-discovers them: per-user Claude skills (`~/.claude/skills`), Claude plugin marketplaces, and Crow skills (`~/crow/skills` and per-bundle `~/crow/bundles/*/skills`). Re-runnable; uses `ln -sfn`. Skips skills without `description:` frontmatter (pi refuses those and they'd add startup noise). Run after a fresh install or when adding a new Claude plugin.

### bin/pi-extension-check

Locates the active `pi` binary, follows the symlink to find pi-coding-agent's install dir, then uses pi's bundled `@mariozechner/jiti` to import the target `.ts` file and assert the default export is a function. Falls back to scanning `~/.nvm/versions/node/v*/bin/pi` if `pi` isn't on PATH (which happens in non-login SSH shells). Sets `NODE_PATH` to pi's `node_modules` so peer deps (typebox, MCP SDK) resolve the same way they do at runtime.

## Deployment

This is **not** an npm package. Distribution is via git.

- **First-time install on a machine**: `pi install git:<your-remote>` (pi clones to `~/.pi/agent/git/.../pi-lab/` and adds it to `~/.pi/agent/settings.json`'s `packages` array). Or, for a working clone you want to edit, `git clone` to `~/pi-lab` and add `"../../pi-lab"` to `packages` (settings.json lives at `~/.pi/agent/settings.json`, so `../../` = `~`).
- **Update on a machine**: `cd ~/pi-lab && git pull` (or wherever the clone lives).
- **Restart pi** after pulling — extensions load at session start.

Deployed machines pull from the same git remote. There's no CI; the `npm run test:extensions` gate is what catches load-time errors before they ship.

## Don't break

- **Don't comment-block-end with `*/`** inside JSDoc text describing shell commands like `dd if=...of=...` — TypeScript thinks the comment ended. Past actual bug in `permission-gating.ts`.
- **Don't reach for the unsafe shell-spawning APIs** inside extensions — there's a hook that warns about this. Use `execFile` (or its no-throw wrapper) if you must shell out.
- **Don't forget the chain pattern for `before_agent_start`** — see "Extension authoring contract" above. Verifier won't catch this; only a smoke test will.
- **Don't expect lifecycle events in print mode** — in `pi -p` / `--mode json -p` (pi v0.74.2), extensions LOAD (tools/commands register) but NO lifecycle events fire: no `session_start`, `agent_start`, `agent_end`, `turn_start`, and `pi.events` bus emits from event handlers never run. Verified empirically 2026-07-01 (`dist/modes/print-mode.js` never wires the extension runner into the loop; interactive mode does). Anything event-driven (notify, session registration) only works in interactive/tmux sessions — test event-driven extensions through `tmux send-keys`, not `-p`.
