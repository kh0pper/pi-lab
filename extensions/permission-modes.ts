/**
 * permission-modes — Claude-Code-style permission modes for pi.
 *
 *   ask           edits/writes, non-safe bash, and MCP/subagent tools prompt
 *                 (once per pattern per session); reads are always free.
 *   accept-edits  edits/writes + safe fs commands auto-approved; other
 *                 commands and tools still prompt.
 *   auto          edits free; commands/tools are judged by a LOCAL classifier
 *                 model (config permissionModes.classifierModel, default the
 *                 always-on crow 35B) — only RISKY verdicts prompt. Classifier
 *                 unreachable/unparseable = fail closed to a prompt.
 *   bypass        pi's historical behavior — everything runs (the separate
 *                 permission-gating extension still blocks catastrophic ops).
 *   plan          handled by the plan-mode extension; while plan mode is
 *                 active this extension stands down.
 *
 * Switch: /mode [ask|accept-edits|auto|bypass] · Shift+Tab cycles (Claude
 * Code parity — requires the keybindings.json remap that install-bridges.sh
 * applies, since pi core otherwise binds shift+tab to thinking-level
 * cycling, now on ctrl+alt+t) · the phone UI's mode control (bus bridge
 * "command:mode"). Current mode shows in the footer and /api/mobile/status.
 *
 * Settings (~/.pi/agent/settings.json):
 *   "permissionModes": {
 *     "default": "bypass",              // mode at session start
 *     "classifierUrl": "http://…:8011/v1",  // dedicated tiny model (best:
 *     "classifierId": "qwen3.5-4b",         // the always-on vLLM 4B — 0.2s
 *                                           // verdicts with thinking off)
 *     "classifierModel": "current",     // fallback when the dedicated
 *                                       // endpoint is down/unset: "current"
 *                                       // = the session's own model (always
 *                                       // reachable), or pin a provider/id.
 *     "classifierTimeoutMs": 12000
 *   }
 *
 * Scope: interactive sessions only. Bots (PI_BOT_PERMISSION_POLICY) keep
 * their own policy system; subagent children (PIBOT_SUBAGENT_DEPTH) and
 * headless runs are untouched (no lifecycle events fire there anyway).
 * Prompts render in the terminal; remote watchers get a pi-lab:attention
 * banner + push so a hub-spawned session never goes silently quiet.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isSafeCommand } from "./plan-mode/utils.js";

type Mode = "ask" | "accept-edits" | "auto" | "bypass";
const MODES: Mode[] = ["ask", "accept-edits", "auto", "bypass"];
const READ_TOOLS = new Set(["read", "grep", "find", "ls", "questionnaire", "todo"]);
const EDIT_TOOLS = new Set(["edit", "write"]);

// Claude's acceptEdits also auto-approves simple file-shuffling commands.
const SAFE_FS_RE =
	/^\s*(mkdir|touch|mv|cp|rm|rmdir|ln)\s+(?!.*(\/etc|\/usr|\/boot|\/root|--no-preserve-root|\s\/(\s|$)))/;

interface ModeConfig {
	default?: Mode;
	classifierUrl?: string;
	classifierId?: string;
	classifierModel?: string;
	classifierTimeoutMs?: number;
}

const SETTINGS_PATH = resolve(homedir(), ".pi", "agent", "settings.json");

function loadConfig(): ModeConfig {
	if (!existsSync(SETTINGS_PATH)) return {};
	try {
		return (JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as { permissionModes?: ModeConfig }).permissionModes ?? {};
	} catch {
		return {};
	}
}

/** Resolve a provider/id to its OpenAI-compatible base URL + key via models.json. */
function classifierEndpoint(ref: string): { url: string; key: string; id: string } | null {
	try {
		const raw = JSON.parse(readFileSync(resolve(homedir(), ".pi", "agent", "models.json"), "utf8"));
		const provs = raw.providers ?? raw;
		const slash = ref.indexOf("/");
		const prov = provs[ref.slice(0, slash)];
		if (!prov?.baseUrl) return null;
		return { url: prov.baseUrl.replace(/\/+$/, ""), key: prov.apiKey ?? "", id: ref.slice(slash + 1) };
	} catch {
		return null;
	}
}

const CLASSIFIER_SYSTEM = `You are a safety classifier for a coding agent running on its owner's own machine. Judge whether the proposed action is routine development work or something destructive/irreversible/exfiltrating.

RISKY examples: deleting outside the working directory, sudo/su, disk or filesystem operations, killing services or processes, force-pushing or rewriting shared git history, modifying system paths (/etc, /usr, /boot), piping downloads into a shell, sending secrets or files to external services, package publishing.
SAFE examples: reading/searching files, building, running tests, git status/diff/add/commit, editing project files, creating directories, installing project dependencies, starting a dev server.

Reply with exactly one word: SAFE or RISKY. No other text.`;

async function classifyVia(url: string, id: string, key: string, action: string, timeoutMs: number, noThink: boolean): Promise<"SAFE" | "RISKY" | "UNKNOWN"> {
	try {
		const body: Record<string, unknown> = {
			model: id,
			messages: [
				{ role: "system", content: CLASSIFIER_SYSTEM },
				{ role: "user", content: action },
			],
			temperature: 0,
			// Thinking models burn tokens reasoning before the verdict unless told not to.
			max_tokens: noThink ? 10 : 300,
		};
		if (noThink) body.chat_template_kwargs = { enable_thinking: false };
		const res = await fetch(`${url.replace(/\/+$/, "")}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...(key && key !== "not-needed" ? { Authorization: `Bearer ${key}` } : {}) },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return "UNKNOWN";
		const data = (await res.json()) as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> };
		const text = `${data.choices?.[0]?.message?.content ?? ""}\n${data.choices?.[0]?.message?.reasoning_content ?? ""}`;
		// Verdict = last occurrence wins (reasoning may mention both words).
		const lastSafe = text.lastIndexOf("SAFE");
		const lastRisky = text.lastIndexOf("RISKY");
		if (lastSafe === -1 && lastRisky === -1) return "UNKNOWN";
		return lastRisky > lastSafe ? "RISKY" : "SAFE";
	} catch {
		return "UNKNOWN";
	}
}

async function classify(action: string, cfg: ModeConfig, currentModel?: string | null): Promise<"SAFE" | "RISKY" | "UNKNOWN"> {
	const timeout = cfg.classifierTimeoutMs ?? 12000;
	// 1) Dedicated tiny classifier (e.g. the always-on vLLM 4B): fastest,
	//    independent of the main agent's server, thinking disabled.
	if (cfg.classifierUrl && cfg.classifierId) {
		const v = await classifyVia(cfg.classifierUrl, cfg.classifierId, "", action, Math.min(timeout, 6000), true);
		if (v !== "UNKNOWN") return v;
	}
	// 2) Fallback: "current" = the session's own model (guaranteed reachable),
	//    or a pinned provider/id resolved via models.json.
	let ref = cfg.classifierModel ?? "current";
	if (ref === "current") {
		if (!currentModel) return "UNKNOWN";
		ref = currentModel;
	}
	const ep = classifierEndpoint(ref);
	if (!ep) return "UNKNOWN";
	return classifyVia(ep.url, ep.id, ep.key, action, timeout, false);
}

export default function (pi: ExtensionAPI) {
	if (process.env["PI_BOT_PERMISSION_POLICY"]) return; // bots have their own policy system
	if (Number(process.env["PIBOT_SUBAGENT_DEPTH"] ?? "0") >= 1) return;

	let mode: Mode = (loadConfig().default as Mode) ?? "bypass";
	if (!MODES.includes(mode)) mode = "bypass";
	let planActive = false;
	const remembered = new Map<string, "allow" | "deny">();

	function announce(): void {
		pi.events.emit("perm-mode:state", { mode });
	}
	pi.events.on("perm-mode:get", () => announce());
	pi.events.on("plan-mode:state", (d) => {
		planActive = Boolean((d as { enabled?: boolean })?.enabled);
	});

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const label = { ask: "🔒 ask", "accept-edits": "✏ edits", auto: "🛡 auto", bypass: "" }[mode];
		ctx.ui.setStatus("perm-mode", label ? ctx.ui.theme.fg("warning", label) : undefined);
	}

	function setMode(next: Mode, ctx: ExtensionContext): void {
		mode = next;
		remembered.clear();
		announce();
		updateStatus(ctx);
		ctx.ui.notify(`Permission mode: ${next}${next === "auto" ? " (local classifier judges commands)" : ""}`);
	}

	pi.registerCommand("mode", {
		description: "Permission mode: /mode [ask|accept-edits|auto|bypass]",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim() as Mode | "";
			if (arg && MODES.includes(arg as Mode)) return setMode(arg as Mode, ctx);
			if (!ctx.hasUI) return;
			const choice = await ctx.ui.select(
				`Permission mode (current: ${mode}):`,
				MODES.map((m) => ({ ask: "ask — prompt for edits, commands, tools", "accept-edits": "accept-edits — edits free, commands prompt", auto: "auto — local classifier judges commands", bypass: "bypass — run everything (catastrophic guard stays)" }[m])),
			);
			if (choice) setMode(choice.split(" ")[0] as Mode, ctx);
		},
	});

	pi.events.on("command:mode", (data) => {
		const arg = (((data as { args?: string })?.args) ?? "").trim() as Mode;
		if (MODES.includes(arg) && lastCtx) setMode(arg, lastCtx);
	});

	pi.registerShortcut("shift+tab", {
		description: "Cycle permission mode (Claude Code parity)",
		handler: async (ctx) => setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length], ctx),
	});

	let lastCtx: ExtensionContext | null = null;
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		announce();
		updateStatus(ctx);
	});

	async function prompt(ctx: ExtensionContext, key: string, title: string, detail: string): Promise<{ block: true; reason: string } | undefined> {
		const prior = remembered.get(key);
		if (prior === "allow") return undefined;
		if (prior === "deny") return { block: true, reason: `Denied earlier this session: ${key}` };
		if (!ctx.hasUI) return { block: true, reason: `Blocked (${mode} mode, no UI to confirm): ${key}` };
		pi.events.emit("pi-lab:attention", { reason: "permission", detail: title });
		const choice = await ctx.ui.select(`${title}\n${detail}`, ["Allow once", "Allow for this session", "Deny"]);
		if (choice === "Allow for this session") {
			remembered.set(key, "allow");
			return undefined;
		}
		if (choice === "Allow once") return undefined;
		remembered.set(key, "deny");
		return { block: true, reason: `Denied by user: ${key}` };
	}

	pi.on("tool_call", async (event, ctx) => {
		if (mode === "bypass" || planActive) return undefined; // plan-mode already restricts
		const tool = event.toolName;
		if (READ_TOOLS.has(tool)) return undefined;

		// Edits
		if (EDIT_TOOLS.has(tool)) {
			if (mode !== "ask") return undefined; // accept-edits and auto auto-approve edits
			const path = (event.input as { path?: string }).path ?? "?";
			return prompt(ctx, `edit:${path}`, `${tool} ${path}`, "Allow this file change?");
		}

		// Bash
		if (tool === "bash") {
			const command = ((event.input as { command?: string }).command ?? "").trim();
			if (isSafeCommand(command)) return undefined; // read-only allowlist
			if (mode === "accept-edits" && SAFE_FS_RE.test(command)) return undefined;
			if (mode === "auto") {
				const cur = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
				const verdict = await classify(`Shell command in ${ctx.cwd}:\n${command}`, loadConfig(), cur);
				if (verdict === "SAFE") return undefined;
				const note = verdict === "RISKY" ? "classifier: RISKY" : "classifier unavailable — fail closed";
				return prompt(ctx, `bash:${command.slice(0, 60)}`, `bash (${note})`, command.slice(0, 200));
			}
			return prompt(ctx, `bash:${command.slice(0, 60)}`, "Run command?", command.slice(0, 200));
		}

		// Everything else: MCP tools, subagent, send_user_file, …
		if (mode === "auto") {
			const argsPreview = JSON.stringify(event.input).slice(0, 400);
			const cur = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
			const verdict = await classify(`Tool call: ${tool}\nArguments: ${argsPreview}`, loadConfig(), cur);
			if (verdict === "SAFE") return undefined;
			const note = verdict === "RISKY" ? "classifier: RISKY" : "classifier unavailable — fail closed";
			return prompt(ctx, `tool:${tool}`, `${tool} (${note})`, argsPreview.slice(0, 200));
		}
		return prompt(ctx, `tool:${tool}`, `Use tool ${tool}?`, JSON.stringify(event.input).slice(0, 200));
	});
}
