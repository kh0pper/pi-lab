/**
 * notify.ts — push notifications for pi sessions via ntfy.
 *
 * Fires a push when an agent run finishes (if it ran long enough to be worth
 * telling you about) and a high-priority push when something in the session
 * blocks waiting for user input (extensions emit "pi-lab:attention" on the
 * shared event bus — permission-gating does this before its confirm prompts).
 *
 * Configuration (in ~/.pi/agent/settings.json) — OFF unless `url` AND `topic`
 * are configured:
 *
 *   "notify": {
 *     "enabled": true,
 *     "url": "https://your-ntfy-host.example:8445",
 *     "topic": "pi",
 *     "token": "tk_...",            // ntfy access token (optional)
 *     "minRunSeconds": 30,           // agent_end pushes only for runs >= this
 *     "onAgentEnd": true,
 *     "onAttention": true
 *   }
 *
 * Never notifies from bot pi processes (PI_BOT_PERMISSION_POLICY set) or from
 * subagent child processes (PIBOT_SUBAGENT_DEPTH >= 1). Intentionally does NOT
 * gate on ctx.hasUI: headless hub-spawned sessions are where this matters most.
 * All network calls are fire-and-forget with a short timeout — a down ntfy
 * server must never block or break the session.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface NotifyConfig {
	enabled?: boolean;
	url?: string;
	topic?: string;
	token?: string;
	minRunSeconds?: number;
	onAgentEnd?: boolean;
	onAttention?: boolean;
	/** ntfy Click action — tapping the notification opens this URL (your pi-hub). */
	clickUrl?: string;
}

function loadConfig(): NotifyConfig | null {
	const settingsPath = resolve(homedir(), ".pi", "agent", "settings.json");
	if (!existsSync(settingsPath)) return null;
	try {
		const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as { notify?: NotifyConfig };
		return raw.notify ?? null;
	} catch {
		return null;
	}
}

/** HTTP header values must be latin-1 and single-line. */
function headerSafe(s: string, max = 120): string {
	// eslint-disable-next-line no-control-regex
	const cleaned = s.replace(/[\r\n]+/g, " ").replace(/[^\x20-\x7e]/g, "?");
	return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…`.replace(/[^\x20-\x7e]/g, "?") : cleaned;
}

function lastAssistantText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: Array<{ type?: string; text?: string }> };
		if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		const text = m.content
			.filter((b) => b?.type === "text" && typeof b.text === "string")
			.map((b) => b.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	// Bots and subagent children never notify.
	if (process.env["PI_BOT_PERMISSION_POLICY"]) return;
	if (Number(process.env["PIBOT_SUBAGENT_DEPTH"] ?? "0") >= 1) return;

	const cfg = loadConfig();
	if (!cfg || cfg.enabled === false || !cfg.url || !cfg.topic) return;

	const endpoint = `${cfg.url.replace(/\/+$/, "")}/${cfg.topic}`;
	const minRunMs = (cfg.minRunSeconds ?? 30) * 1000;

	let sessionLabel = basename(process.cwd());
	let sessionId = "";
	let agentStartedAt = 0;

	pi.on("session_start", (_event, ctx) => {
		try {
			sessionId = (ctx.sessionManager.getSessionId?.() ?? "").slice(0, 8);
			const name = ctx.sessionManager.getSessionName?.();
			if (name) sessionLabel = name;
		} catch {
			// keep cwd-based label
		}
	});

	function post(title: string, body: string, priority: "default" | "high", tags: string): void {
		const headers: Record<string, string> = {
			Title: headerSafe(title),
			Priority: priority,
			Tags: tags,
		};
		if (cfg?.token) headers["Authorization"] = `Bearer ${cfg.token}`;
		if (cfg?.clickUrl) headers["Click"] = cfg.clickUrl;
		fetch(endpoint, {
			method: "POST",
			headers,
			body: body.slice(0, 400),
			signal: AbortSignal.timeout(5000),
		}).catch(() => {
			// fire-and-forget: never surface network errors into the session
		});
	}

	function label(): string {
		return sessionId ? `${sessionLabel} [${sessionId}]` : sessionLabel;
	}

	// Web-initiated turns (phone chat) always notify on completion — that's
	// the "tell me when it replies" contract, independent of run duration.
	let webInitiated = false;
	pi.events.on("pi-lab:web-prompt", () => {
		webInitiated = true;
	});

	pi.on("agent_start", () => {
		agentStartedAt = Date.now();
	});

	pi.on("agent_end", (event) => {
		if (cfg.onAgentEnd === false) return;
		const fromWeb = webInitiated;
		webInitiated = false;
		const longEnough = agentStartedAt && Date.now() - agentStartedAt >= minRunMs;
		if (!fromWeb && !longEnough) return;
		const mins = Math.round((Date.now() - agentStartedAt) / 6000) / 10;
		const body = lastAssistantText((event as { messages?: unknown }).messages) || "(no final text)";
		post(fromWeb ? `pi replied: ${label()}` : `pi finished: ${label()} (${mins}m)`, body, "default", "robot");
	});

	pi.events.on("pi-lab:attention", (data) => {
		if (cfg.onAttention === false) return;
		const d = (data ?? {}) as { reason?: string; detail?: string };
		post(`pi needs input: ${label()}`, `${d.reason ?? "attention"}: ${d.detail ?? ""}`.trim(), "high", "rotating_light");
	});
}
