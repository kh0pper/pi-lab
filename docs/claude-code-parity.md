# pi-lab vs Claude Code — parity evaluation

_Assessed 2026-07-02 against Claude Code's current feature set and pi v0.74.2 + pi-lab.
Updated the same day after landing the four gap-closers (superpowers, hooks,
checkpoints, background tasks)._

## Summary

pi-lab reaches or exceeds Claude Code on every day-to-day workflow surface.
The remaining deltas are output styles, @-file mentions, and a plugin
marketplace runtime — all deliberately deferred (low value for this setup).

## At parity or beyond

| Feature | Claude Code | pi-lab | Notes |
|---|---|---|---|
| Plan mode | plan mode + ExitPlanMode | `/plan`, `/deep-plan` | **Beyond CC**: separate planning-model and execution-model pickers; plans persist to `.pi/plans/` |
| Subagents | Task/Agent tool, agents dir | `subagent` tool | single / parallel (≤8) / chain modes, per-agent model binding via `/agent-models`; agents in `~/.pi/agent/agents/` |
| Independent critics | (no direct equivalent) | `/critique` | **Beyond CC**: fresh-context code-critic + test-critic judge the diff, never the conversation; auto-runs after plan execution |
| Permission modes | default / acceptEdits / bypassPermissions / plan | `/mode` ask / accept-edits / auto / bypass (Shift+Tab cycles) | **Beyond CC**: `auto` mode classifies commands with a dedicated always-on local model (~0.2 s) with fail-closed prompting; catastrophic-op backstop active in every mode |
| Skills | Skill tool + skills dirs + plugins | pi-native skills (`/skill:<name>`, prompt injection) | ~40 skills bridged from Claude user skills, Claude plugin skills, and Crow skills via `scripts/install-bridges.sh` |
| **Superpowers plugin** | plugin + SessionStart hook | **pi package** (landed 2026-07-02) | Upstream ships native pi support; wired via stable symlink `~/.pi/agent/pkg/superpowers` + `packages` entry. All 14 skills load; the using-superpowers bootstrap injects once per session and is stripped from subagents/critics/bots by `extensions/superpowers-guard.ts` |
| Slash commands from markdown | `~/.claude/commands/*.md` | `~/.pi/agent/prompts/*.md` | CC commands bridged in; `$@` / `{previous}` substitution |
| **Hooks** | settings.json shell hooks | `extensions/hooks.ts` (landed 2026-07-02) | CC-shaped config under settings key `hooks`; PreToolUse (blocking), PostToolUse, UserPromptSubmit, SessionStart (context inject), SessionEnd, Stop, Notification. CC-field-named stdin payload so existing CC hooks port over. Config snapshots at session start (`/hooks-reload` to re-read) — deliberate anti-self-escalation choice |
| **Checkpoints / rewind** | auto checkpoints + /rewind | `extensions/checkpoint/` (landed 2026-07-02) | Shadow-git snapshots per session (user repo untouched), one per mutating prompt; `/rewind` restores files and/or conversation (conversation via pi's native `navigateTree`); redo point saved before every restore |
| **Background tasks** | Bash run_in_background + TaskOutput/KillShell | `extensions/background-tasks.ts` (landed 2026-07-02) | `bash_background` / `task_output` / `task_kill`; completion actively wakes the agent (steers if mid-run); same permission gating as bash |
| MCP | .mcp.json | `~/.pi/agent/mcp.json` (same schema) | stdio + streamable-HTTP + SSE via `extensions/mcp-client.ts`; tools appear as `mcp__<server>__<tool>` |
| Memory / context files | CLAUDE.md hierarchy | AGENTS.md / CLAUDE.md at session start (pi-native) | plus `/init` prompt for generating one |
| Compaction | auto-compact | pi-native + structured-compaction | **Beyond CC**: decisions/open-items/next-steps parsed to `session-state.json` and re-injected next session |
| Todo list | TodoWrite | `todo` tool + `/todos` | branch-safe state in tool-result details |
| Web / remote | claude.ai/code (cloud) | Perch hub + mobile PWA (self-hosted) | **Beyond CC for this setup**: session list/resume/spawn/teleport from any tailnet device, session rename/archive |
| Notifications | (limited) | ntfy push | run-finished + needs-attention pushes to phone |
| Session branching | /rewind (conversation) | pi-native fork / tree / switch | |

## Deferred (documented, not planned)

| Feature | Why deferred |
|---|---|
| Output styles | Cosmetic; system-prompt hints in `tool-hint.ts` cover the practical need |
| @-file mentions | pi's read tool + prompts cover it; TUI autocomplete would need upstream work |
| Plugin marketplace runtime | pi packages already provide the loading mechanism; install-bridges.sh covers Claude-plugin skill reuse. A full marketplace is upstream (pi) territory |
| Hooks: SubagentStop / PreCompact events, JSON `updatedInput` | v2 of `extensions/hooks.ts` if a use-case appears |
| Per-project hooks file (`.pi/hooks.json`) | Supply-chain hazard without an interactive trust/approval flow; revisit with a trust prompt |

## Known deltas / caveats

- **Stop hooks can't block stopping** (pi's `agent_end` has no continuation result) — CC's Stop hook can force continuation.
- **Checkpoints skip `.gitignore`d files** (intentional, matches CC) — an ignored `.env` edit does not rewind.
- **A pi crash orphans background tasks** (no `session_shutdown`); logs remain under `~/.pi/agent/tasks/<session>/`.
- **Superpowers bootstrap adds ~10k tokens** to the first prompt of each session; on the local 35B this is amortized by llama.cpp context checkpoints after the first turn.
- **`pi -p` (print mode) fires no lifecycle events** — hooks/checkpoints/notifications are interactive-session features (subagents intentionally excluded anyway).

## Verification record (2026-07-02)

- Superpowers: 14 skills listed in-session; bootstrap present exactly once interactively; absent under `PIBOT_SUBAGENT_DEPTH=1` and `PI_BOT_PERMISSION_POLICY` (guard + package order verified live).
- Hooks: PreToolUse payload captured with CC field names; exit-2 block reason reached the model and the command did not run; SessionStart stdout (CTX marker) quotable by the model; `sleep 120` hook with `timeout: 2` did not stall the tool; no hook fired in subagent env.
- Background tasks: task started + immediate return; completion woke the agent which reported the task output unprompted; log file captured output; `sleep 300` task killed on `/quit`.
- Checkpoints: see `extensions/checkpoint/` header; verified live in a scratch repo (snapshot on mutating prompt, none on read-only, files restore reverts edits and deletes created files, user repo `git status` unchanged).
