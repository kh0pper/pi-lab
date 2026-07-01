/**
 * Session State Loader Extension
 *
 * Reads the external session state file (written by structured-compaction.ts)
 * and chains a "Previous Session Context" block onto the system prompt at
 * agent-start. Provides continuity across compaction boundaries and across
 * sessions.
 *
 * The state file is written by structured-compaction.ts and contains:
 * goals, decisions, open items, next steps, key context.
 *
 * Pattern: returns `{systemPrompt: event.systemPrompt + addition}` so it
 * chains cleanly with other extensions (e.g. tool-hint).
 *
 * Configuration (in ~/.pi/agent/settings.json):
 *   "sessionStateLoader": {
 *     "enabled": true,
 *     "stateFilePath": "~/.pi/agent/session-state.json",
 *     "maxContextLength": 2000
 *   }
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface Config {
	enabled: boolean;
	stateFilePath: string;
	maxContextLength: number;
}

function expandHome(p: string): string {
	if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
	return resolve(p);
}

function loadConfig(): Config {
	const defaults: Config = {
		enabled: true,
		stateFilePath: expandHome("~/.pi/agent/session-state.json"),
		maxContextLength: 2000,
	};
	const settingsPath = resolve(homedir(), ".pi", "agent", "settings.json");
	if (!existsSync(settingsPath)) return defaults;
	try {
		const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as { sessionStateLoader?: Partial<Config> };
		const cfg = raw.sessionStateLoader ?? {};
		return {
			enabled: cfg.enabled !== false,
			stateFilePath: expandHome(cfg.stateFilePath ?? defaults.stateFilePath),
			maxContextLength: cfg.maxContextLength ?? defaults.maxContextLength,
		};
	} catch {
		return defaults;
	}
}

function truncateState(state: Record<string, unknown>, maxLen: number): string {
	let text = JSON.stringify(state, null, 2);
	if (text.length <= maxLen) return text;

	// Truncate intelligently: keep high-value sections, trim large arrays.
	const trimmed = { ...state } as Record<string, unknown>;
	if (Array.isArray(trimmed.open_items)) trimmed.open_items = (trimmed.open_items as unknown[]).slice(0, 5);
	if (Array.isArray(trimmed.decisions)) trimmed.decisions = (trimmed.decisions as unknown[]).slice(-10);
	if (Array.isArray(trimmed.next_steps)) trimmed.next_steps = (trimmed.next_steps as unknown[]).slice(0, 8);
	text = JSON.stringify(trimmed, null, 2);

	if (text.length > maxLen && typeof trimmed.key_context === "string") {
		trimmed.key_context = (trimmed.key_context as string).slice(0, Math.max(0, maxLen - 400));
		text = JSON.stringify(trimmed, null, 2);
	}
	if (text.length > maxLen) text = text.slice(0, maxLen) + "\n\n[...truncated]";
	return text;
}

export default function (pi: ExtensionAPI) {
	const cfg = loadConfig();
	if (!cfg.enabled) return;

	pi.on("before_agent_start", (event) => {
		if (!existsSync(cfg.stateFilePath)) return undefined;

		let state: Record<string, unknown>;
		try {
			state = JSON.parse(readFileSync(cfg.stateFilePath, "utf8")) as Record<string, unknown>;
		} catch {
			return undefined;
		}

		const stateText = truncateState(state, cfg.maxContextLength);
		const block =
			"\n\n## Previous Session Context\n\n" +
			"The following is context from previous sessions in this project. " +
			"If the current task is unrelated, you may ignore it.\n\n" +
			"```json\n" +
			stateText +
			"\n```";

		return { systemPrompt: event.systemPrompt + block };
	});
}
