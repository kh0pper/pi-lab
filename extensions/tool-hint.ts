/**
 * Tool Hint Extension
 *
 * Appends two short usage hints to the system prompt at agent-start:
 *   1. A pi-vs-Claude-Code disambiguation (pi has no harness-level MCP — MCP
 *      servers are surfaced as `mcp__<server>__<tool>` tools by pi-lab/mcp-client).
 *   2. A web-research preference: prefer the `mcp__crow__*` tools (brave_web_search,
 *      imageFetch, crow_browser_*) over bash+curl for fetching pages, since most
 *      modern sites block default curl with 406.
 *
 * The Crow hint is only added when ~/.pi/agent/mcp.json declares a "crow" or
 * "crow-*" server (i.e. the bridge from pi-lab/mcp-client.ts is wired).
 *
 * Pattern: returns `{systemPrompt: event.systemPrompt + addition}` so it
 * chains cleanly with other extensions that also modify the system prompt.
 *
 * Configuration (in ~/.pi/agent/settings.json):
 *   "toolHint": { "enabled": true }
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function isEnabled(): boolean {
	const settingsPath = resolve(homedir(), ".pi", "agent", "settings.json");
	if (!existsSync(settingsPath)) return true;
	try {
		const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as { toolHint?: { enabled?: boolean } };
		return raw.toolHint?.enabled !== false;
	} catch {
		return true;
	}
}

/** True only when the unified gateway-bridge entry is present (a "crow" key
 *  with a `url` field). The per-domain stdio entries (crow-memory, crow-projects,
 *  ...) don't expose the browser/brave/fetch tools the hint recommends, so we
 *  don't fire on them. */
function hasCrowMcpServer(): boolean {
	const mcpPath = resolve(homedir(), ".pi", "agent", "mcp.json");
	if (!existsSync(mcpPath)) return false;
	try {
		const raw = JSON.parse(readFileSync(mcpPath, "utf8")) as {
			mcpServers?: Record<string, { url?: string }>;
		};
		const crow = raw.mcpServers?.crow;
		return !!(crow && typeof crow.url === "string");
	} catch {
		return false;
	}
}

const HINTS_HEADER = "\n\n## Harness Hints\n\n";

const PI_DISAMBIGUATION =
	"- You are running inside pi (a coding-agent harness), not Claude Code. " +
	"Pi has no MCP at the harness layer; MCP-server tools may be surfaced as " +
	"`mcp__<server>__<tool>` by the pi-lab/mcp-client extension. Use those " +
	"like any other tool — don't try to spawn child pi processes for tool access.";

const CROW_TOOLS_HINT =
	"- For web search and page fetching, prefer the `mcp__crow__*` tools " +
	"(`brave_web_search`, `brave_local_search`, `imageFetch`, `crow_browser_navigate`, " +
	"`crow_browser_extract_text`, etc.) over bash+curl. Default curl gets blocked by " +
	"406 on most modern sites and can't render JavaScript pages.";

export default function (pi: ExtensionAPI) {
	if (!isEnabled()) return;
	const crowAvailable = hasCrowMcpServer();

	pi.on("before_agent_start", (event) => {
		const hints = [PI_DISAMBIGUATION];
		if (crowAvailable) hints.push(CROW_TOOLS_HINT);
		return { systemPrompt: event.systemPrompt + HINTS_HEADER + hints.join("\n") };
	});
}
