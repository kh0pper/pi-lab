/**
 * hooks.ts — declarative shell hooks (Claude Code parity).
 *
 * Lets users attach shell commands to harness events without writing a
 * TypeScript extension. Config lives in ~/.pi/agent/settings.json under
 * `hooks`, shaped like Claude Code's hooks config so existing CC hook
 * configs paste over:
 *
 *   "hooks": {
 *     "enabled": true,
 *     "PreToolUse":  [{ "matcher": "bash|write",
 *                       "hooks": [{ "type": "command", "command": "~/.pi/hooks/guard.sh", "timeout": 30 }] }],
 *     "PostToolUse": [ ... ],
 *     "UserPromptSubmit": [ ... ],
 *     "SessionStart": [ ... ],      // matcher matches the start reason (startup|reload|new|resume|fork)
 *     "SessionEnd":  [ ... ],
 *     "Stop":        [ ... ],       // fires on agent_end; cannot block stopping (parity gap)
 *     "Notification":[ ... ]        // fires on pi-lab:attention bus events
 *   }
 *
 * Semantics (CC parity):
 *   - Hook receives a JSON payload on stdin with CC field names
 *     (session_id, transcript_path, cwd, hook_event_name, tool_name,
 *     tool_input, tool_response, prompt, source, message).
 *   - exit 0  = success. stdout is used per-event: PreToolUse may emit JSON
 *     {"decision":"block","reason":...}; UserPromptSubmit/SessionStart stdout
 *     becomes added context.
 *   - exit 2  = block (PreToolUse: tool blocked, stderr is the reason shown to
 *     the model; PostToolUse: stderr appended as [hook feedback]; UserPromptSubmit:
 *     prompt swallowed, stderr shown to the user).
 *   - anything else / timeout / spawn failure = FAIL OPEN with a one-line warning.
 *   - Matchers are anchored, case-insensitive regexes on the tool name
 *     (case-insensitive is a deliberate deviation: pi tool names are lowercase,
 *     so ported CC configs like "Bash|Write" keep working). A matcher that
 *     matches "bash" also applies to "bash_background" — in CC, background-ness
 *     is a parameter of the same Bash tool, so guard hooks must not be
 *     bypassable by the model choosing the background variant.
 *
 * Security: config is snapshotted at session start, NOT re-read per dispatch —
 * live-reload would let the model write a hook into settings.json (edits are
 * auto-approved in accept-edits/auto modes) and execute arbitrary shell ungated
 * on the next tool call. Use /hooks-reload after editing hooks config.
 * permission-gating.ts additionally write-protects ~/.pi/agent/settings.json.
 *
 * Stop hooks skip turns triggered by background-task completion wakes
 * (background-tasks.ts emits "pi-lab:bg-wake" just before waking the agent) so
 * a `notify:"wake"` task finishing at 3am doesn't fire Stop hooks repeatedly.
 *
 * Never runs for bots (PI_BOT_PERMISSION_POLICY) or subagent children
 * (PIBOT_SUBAGENT_DEPTH >= 1) — those have their own policy systems.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface HookCommand {
	type?: string; // "command" (only supported type)
	command: string;
	timeout?: number; // seconds
}

interface HookMatcherGroup {
	matcher?: string;
	hooks: HookCommand[];
}

type HookEventName =
	| "PreToolUse"
	| "PostToolUse"
	| "UserPromptSubmit"
	| "SessionStart"
	| "SessionEnd"
	| "Stop"
	| "Notification";

type HooksConfig = Partial<Record<HookEventName, HookMatcherGroup[]>> & { enabled?: boolean };

const SETTINGS_PATH = resolve(homedir(), ".pi", "agent", "settings.json");
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB per stream
const DEFAULT_TIMEOUT_S = 60;
const SESSION_END_TIMEOUT_S = 5; // shutdown may race process exit — keep short

function loadHooksConfig(): HooksConfig | null {
	if (!existsSync(SETTINGS_PATH)) return null;
	try {
		const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as { hooks?: HooksConfig };
		return raw.hooks ?? null;
	} catch {
		return null; // malformed settings: fail open, warning happens at snapshot time
	}
}

/** Anchored, case-insensitive matcher. Empty/absent matcher = match everything. */
function matcherApplies(matcher: string | undefined, value: string): boolean {
	if (!matcher) return true;
	let re: RegExp;
	try {
		re = new RegExp(`^(?:${matcher})$`, "i");
	} catch {
		return false; // invalid regex: skip this group (warned once at snapshot)
	}
	if (re.test(value)) return true;
	// bash alias: background bash is the same command surface as bash
	if (value === "bash_background" && re.test("bash")) return true;
	return false;
}

// ---------------------------------------------------------------------------
// Hook process runner
// ---------------------------------------------------------------------------

interface HookRunResult {
	code: number; // -1 for timeout/spawn failure (never treated as block)
	stdout: string;
	stderr: string;
	timedOut: boolean;
	json?: { decision?: string; reason?: string; hookSpecificOutput?: { additionalContext?: string } };
}

/**
 * Runs one hook command. The command contractually gets full shell semantics
 * (Claude Code runs hooks via sh -c), so the shell is invoked explicitly as an
 * argv element — this is the repo's sanctioned spawn idiom (argv array,
 * shell:false; see subagent/run.ts), not shell-string interpolation by Node.
 */
function runOneHook(hook: HookCommand, payload: unknown, cwd: string, capTimeoutS?: number): Promise<HookRunResult> {
	return new Promise((resolvePromise) => {
		const timeoutS = Math.min(hook.timeout ?? DEFAULT_TIMEOUT_S, capTimeoutS ?? Number.POSITIVE_INFINITY);
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;

		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			let json: HookRunResult["json"];
			const trimmed = stdout.trim();
			if (trimmed.startsWith("{")) {
				try {
					json = JSON.parse(trimmed);
				} catch {
					// non-JSON stdout is fine
				}
			}
			resolvePromise({ code, stdout, stderr, timedOut, json });
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("/bin/bash", ["-c", hook.command], {
				shell: false,
				cwd,
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env },
			});
		} catch {
			finish(-1);
			return;
		}

		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGKILL");
			} catch {
				// already gone
			}
		}, timeoutS * 1000);

		child.stdout?.on("data", (d: Buffer) => {
			if (stdout.length < MAX_OUTPUT_BYTES) stdout += d.toString("utf8");
		});
		child.stderr?.on("data", (d: Buffer) => {
			if (stderr.length < MAX_OUTPUT_BYTES) stderr += d.toString("utf8");
		});
		child.on("error", () => finish(-1));
		child.on("close", (code) => finish(timedOut ? -1 : (code ?? -1)));

		// Deliver the payload; hooks that don't read stdin cause EPIPE — ignore.
		child.stdin?.on("error", () => {});
		child.stdin?.write(JSON.stringify(payload));
		child.stdin?.end();
	});
}

interface DispatchResult {
	blocked: boolean;
	reason: string;
	stdouts: string[];
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Bots and subagent children never run user hooks.
	if (process.env["PI_BOT_PERMISSION_POLICY"]) return;
	if (Number(process.env["PIBOT_SUBAGENT_DEPTH"] ?? "0") >= 1) return;

	// Snapshot semantics: loaded at extension init + session_start + /hooks-reload.
	let config: HooksConfig | null = loadHooksConfig();
	let warnedInvalid = false;
	let sessionId = "";
	let transcriptPath = "";
	let cwd = process.cwd();
	/** SessionStart hook stdout, waiting to be injected at the next agent start. */
	let pendingContext: string[] = [];
	/** Set by background-tasks.ts just before it wakes the agent; Stop hooks skip that turn. */
	let skipNextStop = false;

	const warn = (ctx: ExtensionContext | null, msg: string) => {
		if (ctx?.hasUI) ctx.ui.notify(`[hooks] ${msg}`, "warning");
		else process.stderr.write(`[hooks] ${msg}\n`);
	};

	function snapshotConfig(ctx: ExtensionContext | null) {
		config = loadHooksConfig();
		if (config && !warnedInvalid) {
			for (const eventName of Object.keys(config)) {
				if (eventName === "enabled") continue;
				const groups = config[eventName as HookEventName];
				if (!Array.isArray(groups)) continue;
				for (const g of groups) {
					if (g.matcher) {
						try {
							new RegExp(g.matcher);
						} catch {
							warn(ctx, `invalid matcher regex "${g.matcher}" in ${eventName} — group skipped`);
							warnedInvalid = true;
						}
					}
				}
			}
		}
	}

	function basePayload(eventName: HookEventName): Record<string, unknown> {
		return {
			session_id: sessionId,
			transcript_path: transcriptPath,
			cwd,
			hook_event_name: eventName,
		};
	}

	async function dispatch(
		eventName: HookEventName,
		matchValue: string,
		payload: Record<string, unknown>,
		ctx: ExtensionContext | null,
		capTimeoutS?: number,
	): Promise<DispatchResult> {
		const none: DispatchResult = { blocked: false, reason: "", stdouts: [] };
		if (!config || config.enabled === false) return none;
		const groups = config[eventName];
		if (!Array.isArray(groups) || groups.length === 0) return none;

		const hooks: HookCommand[] = [];
		for (const g of groups) {
			if (!matcherApplies(g.matcher, matchValue)) continue;
			for (const h of g.hooks ?? []) {
				if ((h.type ?? "command") === "command" && typeof h.command === "string" && h.command) hooks.push(h);
			}
		}
		if (hooks.length === 0) return none;

		const results = await Promise.all(hooks.map((h) => runOneHook(h, payload, cwd, capTimeoutS)));

		const blockers: string[] = [];
		const stdouts: string[] = [];
		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			if (r.code === 2 || r.json?.decision === "block") {
				blockers.push(r.stderr.trim() || r.json?.reason || "hook blocked");
			} else if (r.code === 0) {
				const extra = r.json?.hookSpecificOutput?.additionalContext;
				const out = (extra ?? r.stdout).trim();
				if (out) stdouts.push(out);
			} else {
				// non-zero-non-2, timeout, spawn failure: fail open, warn
				warn(
					ctx,
					`${eventName} hook "${hooks[i].command.slice(0, 60)}" ${
						r.timedOut ? "timed out" : `failed (exit ${r.code})`
					} — continuing`,
				);
			}
		}
		return { blocked: blockers.length > 0, reason: blockers.join("; "), stdouts };
	}

	// --- session bookkeeping + SessionStart / SessionEnd -----------------------

	pi.on("session_start", async (event, ctx) => {
		cwd = ctx.cwd ?? process.cwd();
		try {
			sessionId = ctx.sessionManager.getSessionId();
			transcriptPath = ctx.sessionManager.getSessionFile() ?? "";
		} catch {
			// keep defaults
		}
		snapshotConfig(ctx);
		const r = await dispatch(
			"SessionStart",
			event.reason,
			{ ...basePayload("SessionStart"), source: event.reason },
			ctx,
		);
		if (r.stdouts.length > 0) pendingContext.push(...r.stdouts);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		await dispatch(
			"SessionEnd",
			event.reason,
			{ ...basePayload("SessionEnd"), reason: event.reason },
			ctx,
			SESSION_END_TIMEOUT_S,
		);
	});

	// --- SessionStart context injection ----------------------------------------

	pi.on("before_agent_start", async () => {
		if (pendingContext.length === 0) return undefined;
		const content = pendingContext.join("\n\n");
		pendingContext = [];
		return { message: { customType: "hook-context", content, display: false } };
	});

	// --- PreToolUse / PostToolUse ----------------------------------------------

	pi.on("tool_call", async (event, ctx) => {
		const r = await dispatch(
			"PreToolUse",
			event.toolName,
			{ ...basePayload("PreToolUse"), tool_name: event.toolName, tool_input: event.input },
			ctx,
		);
		if (r.blocked) return { block: true, reason: `PreToolUse hook: ${r.reason}` };
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		const textContent = event.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map((b) => b.text)
			.join("\n");
		const r = await dispatch(
			"PostToolUse",
			event.toolName,
			{
				...basePayload("PostToolUse"),
				tool_name: event.toolName,
				tool_input: event.input,
				tool_response: { content: textContent.slice(0, MAX_OUTPUT_BYTES), isError: event.isError },
			},
			ctx,
		);
		if (r.blocked) {
			return { content: [...event.content, { type: "text" as const, text: `\n[hook feedback] ${r.reason}` }] };
		}
		return undefined;
	});

	// --- UserPromptSubmit --------------------------------------------------------

	pi.on("input", async (event, ctx) => {
		// Slash commands and tool-ish inputs pass through untouched.
		if (event.text.startsWith("/")) return undefined;
		const r = await dispatch(
			"UserPromptSubmit",
			"",
			{ ...basePayload("UserPromptSubmit"), prompt: event.text },
			ctx,
		);
		if (r.blocked) {
			warn(ctx, `prompt blocked by UserPromptSubmit hook: ${r.reason}`);
			return { action: "handled" as const };
		}
		if (r.stdouts.length > 0) {
			return { action: "transform" as const, text: `${event.text}\n\n${r.stdouts.join("\n\n")}` };
		}
		return undefined;
	});

	// --- Stop ---------------------------------------------------------------------

	pi.events.on("pi-lab:bg-wake", () => {
		skipNextStop = true;
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (skipNextStop) {
			skipNextStop = false;
			return;
		}
		await dispatch("Stop", "", basePayload("Stop"), ctx);
	});

	// --- Notification ---------------------------------------------------------------

	pi.events.on("pi-lab:attention", (data: unknown) => {
		const d = (data ?? {}) as { reason?: string; detail?: string };
		void dispatch(
			"Notification",
			d.reason ?? "",
			{ ...basePayload("Notification"), message: d.detail ?? d.reason ?? "" },
			null,
		);
	});

	// --- /hooks-reload ---------------------------------------------------------------

	pi.registerCommand("hooks-reload", {
		description: "Re-read the hooks config from settings.json (hooks snapshot at session start)",
		handler: async (_args, ctx) => {
			warnedInvalid = false;
			snapshotConfig(ctx as unknown as ExtensionContext);
			const count = config
				? Object.keys(config).filter((k) => k !== "enabled" && Array.isArray(config?.[k as HookEventName]))
						.length
				: 0;
			ctx.ui.notify(`[hooks] config reloaded (${count} event type${count === 1 ? "" : "s"} configured)`, "info");
		},
	});
}
