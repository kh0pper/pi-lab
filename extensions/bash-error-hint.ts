/**
 * Bash Error Hint Extension
 *
 * Hooks `tool_result` for the bash tool. When the result text contains a known
 * error signature (401 API key, MODULE_NOT_FOUND, command not found: tsc, etc.),
 * prepends a `[harness hint] …` line so the model sees the diagnosis without
 * having to grind through trial-and-error retries.
 *
 * Doesn't block, doesn't replace — just augments the first text block. Original
 * output is preserved verbatim after the hint line.
 *
 * Configuration (in ~/.pi/agent/settings.json):
 *   "bashErrorHint": { "enabled": true }
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface HintRule {
	match: RegExp;
	hint: string;
}

const HINTS: HintRule[] = [
	{
		match: /401\s+Incorrect API key|401\s+Unauthorized|invalid_api_key|"error":\s*"invalid_token"/i,
		hint:
			"401 = wrong API key for the active provider. Check `pi --list-models`, " +
			"`--provider <name>`, or the env var the provider expects (e.g. ANTHROPIC_API_KEY).",
	},
	{
		match: /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/i,
		hint:
			"Missing dependency. Try `npm install` in the package dir, or check the import " +
			"path. For pi extensions, peer deps live under pi-coding-agent's node_modules.",
	},
	{
		match: /command not found: tsc|tsc:\s*command not found/i,
		hint:
			"`tsc` not on PATH. For syntax-only checks of compiled JS use `node --check <file.js>`. " +
			"For TypeScript, use `npx --package=typescript@5 -- tsc ...` or check via jiti import.",
	},
	{
		match: /HTTP\/[0-9.]+\s+406\b|< HTTP\/[0-9.]+ 406|^.*\b406 Not Acceptable\b/im,
		hint:
			"HTTP 406 = the server's WAF blocked default curl. Retry with `-A 'Mozilla/5.0 ...'`, " +
			"or prefer the `mcp__crow__imageFetch` / `crow_browser_navigate` tools if available.",
	},
	{
		match: /Permission denied|EACCES/i,
		hint:
			"EACCES = filesystem permission. Don't reach for sudo unless you know the file truly " +
			"requires it; first check `ls -l` and consider whether you're in the right directory.",
	},
	{
		match: /address already in use|EADDRINUSE/i,
		hint:
			"Port already bound. Find the holder via `ss -tlnp | grep :<port>` (or `lsof -i :<port>`) " +
			"before deciding whether to kill it or pick a different port.",
	},
	{
		match: /docker:\s+(?:Error response from daemon|Cannot connect to the Docker daemon)/i,
		hint:
			"Docker daemon issue. Check `systemctl status docker` and `docker ps` first; on grackle " +
			"the daemon is normally always up, so an error here usually means the user can't reach it.",
	},
];

function isEnabled(): boolean {
	const settingsPath = resolve(homedir(), ".pi", "agent", "settings.json");
	if (!existsSync(settingsPath)) return true;
	try {
		const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as { bashErrorHint?: { enabled?: boolean } };
		return raw.bashErrorHint?.enabled !== false;
	} catch {
		return true;
	}
}

function findFirstHint(text: string): string | null {
	for (const rule of HINTS) {
		if (rule.match.test(text)) return rule.hint;
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	if (!isEnabled()) return;

	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash") return undefined;
		const content = event.content ?? [];
		if (content.length === 0) return undefined;

		const first = content[0];
		if (!first || first.type !== "text" || typeof first.text !== "string") return undefined;

		const hint = findFirstHint(first.text);
		if (!hint) return undefined;

		const annotated = `[harness hint] ${hint}\n\n${first.text}`;
		const newContent = [{ type: "text" as const, text: annotated }, ...content.slice(1)];
		return { content: newContent };
	});
}
