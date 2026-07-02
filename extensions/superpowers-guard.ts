/**
 * superpowers-guard.ts — keeps the superpowers bootstrap out of subagents and bots.
 *
 * The superpowers plugin (wired in as a pi package by scripts/install-bridges.sh)
 * injects its `<EXTREMELY_IMPORTANT>` using-superpowers bootstrap into the prompt
 * via the `context` event. Upstream has no bot/subagent exclusion, and `context`
 * fires even in `pi -p` child processes — so without this guard the bootstrap
 * would contaminate every subagent, critic (fenced-JSON verdicts at risk), and
 * bot session, violating the repo's bot-exclusion invariant.
 *
 * This extension is the polarity inverse of the others: it no-ops for normal
 * interactive sessions and only acts inside subagent/bot processes, where it
 * strips any context message carrying the upstream bootstrap marker.
 *
 * ORDER DEPENDENCY: pi runs `context` handlers in package load order, each
 * seeing the previous handler's output. install-bridges.sh inserts the
 * superpowers package BEFORE pi-lab in settings.packages so the injector runs
 * first and this stripper sees (and removes) its message. If superpowers ever
 * loads after pi-lab, the injection would survive — verify order after changing
 * `packages`.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Must match BOOTSTRAP_MARKER in the plugin's .pi/extensions/superpowers.ts. */
const BOOTSTRAP_MARKER = "superpowers:using-superpowers bootstrap for pi";

function containsMarker(message: unknown): boolean {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content.includes(BOOTSTRAP_MARKER);
	if (!Array.isArray(content)) return false;
	return content.some(
		(part) =>
			part &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string" &&
			(part as { text: string }).text.includes(BOOTSTRAP_MARKER),
	);
}

export default function (pi: ExtensionAPI) {
	const isBot = Boolean(process.env["PI_BOT_PERMISSION_POLICY"]);
	const isSubagent = Number(process.env["PIBOT_SUBAGENT_DEPTH"] ?? "0") >= 1;
	if (!isBot && !isSubagent) return;

	pi.on("context", (event) => {
		const filtered = event.messages.filter((m) => !containsMarker(m));
		if (filtered.length === event.messages.length) return undefined;
		return { messages: filtered };
	});
}
