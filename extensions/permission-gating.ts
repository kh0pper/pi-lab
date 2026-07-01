/**
 * Permission Gating Extension
 *
 * Prompts for confirmation before genuinely destructive operations.
 * Designed to fire rarely — every false-positive trains the user to
 * reflexively approve, defeating the purpose.
 *
 * Gating rules:
 *   - Bash: only truly catastrophic patterns (rm -rf root/home, sudo rm,
 *     `dd of=/dev/...`, mkfs, fork bomb, redirects to a block device).
 *   - Write: only writes to actual-secret files (.env, .key, .pem, .ssh/, .aws/)
 *     or system dirs (/etc/, /usr/, /root/, /boot/).
 *   - Edit: same sensitive-paths gate as write.
 *
 * Per-session memory: when the user answers a prompt, the answer is
 * remembered for that exact pattern/path for the rest of the session.
 *
 * In non-interactive mode (no UI), gated operations are blocked by default.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Per-bot policy gate (Crow Bot Builder Phase 2.2)
//
// SAFETY INVARIANT: this gate is a strict no-op unless the spawning process
// set PI_BOT_PERMISSION_POLICY. pi-lab loads for ALL pi usage on crow, so
// manual pi / spikes / non-bot pi (env absent) keep 100% of the existing
// behavior below. ONLY bridge-spawned bot pi carries the env, and for those
// the per-bot policy runs FIRST, then still falls through to the existing
// destructive-bash / sensitive-path gate (defense in depth — a bot can never
// write /etc even if its workspace were misconfigured).
// ---------------------------------------------------------------------------

type BotPolicy = {
	bash?: "deny" | "allowlist" | "sandbox";
	bash_allow?: string[];
	write_paths?: string[];
	external_send?: "draft_only" | string;
	confirm?: string[];
	// Phase 3.1 (R6/R9): multi-agent opt-in + bridge-injected capability flag.
	multi_agent?: boolean;
	model_capable?: boolean;
};

/** Parse PI_BOT_PERMISSION_POLICY. Absent => null (existing behavior).
 *  Present-but-malformed => fail CLOSED (most restrictive) + stderr error —
 *  a broken-policy bot must do nothing, not run unconstrained. */
function parseBotPolicy(): BotPolicy | null {
	const raw = process.env.PI_BOT_PERMISSION_POLICY;
	if (raw == null || raw === "") return null;
	try {
		const p = JSON.parse(raw);
		if (p && typeof p === "object") return p as BotPolicy;
		throw new Error("policy is not an object");
	} catch (e) {
		process.stderr.write(
			`[permission-gating] PI_BOT_PERMISSION_POLICY unparseable (${
				(e as Error).message
			}) — failing CLOSED\n`,
		);
		return { bash: "deny", write_paths: [] };
	}
}

function underAnyRoot(target: string, roots: string[]): boolean {
	if (!Array.isArray(roots) || roots.length === 0) return false;
	const t = resolve(target);
	for (const r of roots) {
		if (typeof r !== "string" || !r) continue;
		const rr = resolve(r);
		if (t === rr || t.startsWith(rr.endsWith("/") ? rr : rr + "/")) return true;
	}
	return false;
}

function bashDecision(command: string, policy: BotPolicy): { block: boolean; reason?: string } {
	const mode = policy.bash;
	if (mode === "allowlist") {
		const allow = Array.isArray(policy.bash_allow) ? policy.bash_allow : [];
		const cmd = command.trim();
		for (const a of allow) {
			if (typeof a === "string" && a && cmd.startsWith(a)) return { block: false };
		}
		return {
			block: true,
			reason: `bot bash policy=allowlist; command not in bash_allow: "${command.slice(0, 80)}"`,
		};
	}
	// deny | sandbox (not yet implemented) | unknown | undefined => fully blocked.
	return {
		block: true,
		reason: `bot bash policy=${mode || "deny (default)"} — bash is disabled for this bot`,
	};
}

/** A tool that sends external mail (NOT a draft creator). Conservative. */
function isExternalSendTool(toolName: string): boolean {
	const n = toolName.toLowerCase();
	if (n.includes("draft")) return false;
	return /send/.test(n) && /(gmail|mail|email)/.test(n);
}

/** Returns a block decision for the per-bot policy, or null to fall through
 *  to the existing destructive/sensitive gate. */
function botPolicyGate(
	event: { toolName: string; input: unknown },
	policy: BotPolicy,
): { block: true; reason: string } | null {
	// confirm-list: no interactive gateway-confirm channel at tool-call time
	// in Phase 2 — block and tell the bot to surface the ask in its reply.
	if (Array.isArray(policy.confirm) && policy.confirm.includes(event.toolName)) {
		return {
			block: true,
			reason: `Tool ${event.toolName} requires gateway confirmation (policy.confirm); not available unattended — surface the request in your gateway reply instead.`,
		};
	}
	// external send -> draft only
	if (policy.external_send === "draft_only" && isExternalSendTool(event.toolName)) {
		return {
			block: true,
			reason: `external_send=draft_only — ${event.toolName} would send external mail; create a draft instead.`,
		};
	}
	if (event.toolName === "bash") {
		const command = (event.input as { command?: string }).command ?? "";
		const d = bashDecision(command, policy);
		if (d.block) return { block: true, reason: d.reason as string };
	}
	if (event.toolName === "write" || event.toolName === "edit") {
		const path = (event.input as { path?: string }).path ?? "";
		const roots = Array.isArray(policy.write_paths) ? policy.write_paths : [];
		if (!underAnyRoot(path, roots)) {
			return {
				block: true,
				reason: `write/edit outside this bot's workspace is blocked by policy (allowed roots: ${
					roots.length ? roots.join(", ") : "(none configured — default-deny)"
				}); target: ${path || "(empty)"}`,
			};
		}
	}
	// Multi-agent (subagent) gate (Phase 3.1, R6/R9). The subagent extension
	// registers exactly ONE tool, name "subagent" (extensions/subagent/
	// index.ts:432); agents.ts registers none — so this single toolName
	// match is complete. A subagent child inherits PI_BOT_PERMISSION_POLICY
	// (this gate also runs IN the child) AND PIBOT_SUBAGENT_DEPTH (bumped by
	// subagent's own spawn). Depth >= 1, or an unparseable depth, is blocked
	// unconditionally — sub-agents may not spawn sub-agents. At depth 0,
	// subagent is allowed ONLY for an opted-in, capability-listed bot;
	// absent / non-true multi_agent or model_capable => blocked (fail-closed:
	// covers an old-bridge deploy window and any malformed policy, matching
	// parseBotPolicy()'s fail-closed invariant).
	if (event.toolName === "subagent") {
		const rawDepth = process.env.PIBOT_SUBAGENT_DEPTH;
		const depth = Number(rawDepth ?? 0);
		if (!Number.isFinite(depth) || depth >= 1) {
			return {
				block: true,
				reason: `recursive subagent blocked (PIBOT_SUBAGENT_DEPTH=${
					rawDepth ?? "(unset)"
				} -> ${
					Number.isFinite(depth) ? depth : "NaN"
				}); sub-agents may not spawn sub-agents.`,
			};
		}
		if (policy.multi_agent !== true || policy.model_capable !== true) {
			return {
				block: true,
				reason: `multi-agent (subagent) requires policy.multi_agent===true AND a capability-listed model (policy.model_capable===true); this bot has multi_agent=${String(
					policy.multi_agent,
				)} model_capable=${String(policy.model_capable)}.`,
			};
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Truly catastrophic bash patterns. Keep this list short. */
const DESTRUCTIVE_BASH: Array<{ pattern: RegExp; label: string }> = [
	{ pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(\/|~|\$HOME)\b/i, label: "rm -rf on root or $HOME" },
	{ pattern: /\bsudo\s+rm\b/i, label: "sudo rm" },
	{ pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+--no-preserve-root\b/i, label: "rm -rf --no-preserve-root" },
	{ pattern: /\bdd\s+([^|]*\s)?of=\/dev\/(sd|nvme|hd)/i, label: "dd to a block device" },
	{ pattern: /\bmkfs\b/i, label: "mkfs (filesystem create)" },
	{ pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, label: "fork bomb" },
	{ pattern: />\s*\/dev\/sd[a-z]/i, label: "redirect to a block device" },
	{ pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, label: "shutdown/reboot" },
];

/** Sensitive paths — only secrets and system dirs. Project files (package.json,
 * Dockerfile, *.sql, etc.) are intentionally NOT here. */
const SENSITIVE_PATH_PATTERNS: Array<{ test: (p: string) => boolean; label: string }> = [
	{ test: (p) => /\.env(\.|$)/.test(basename(p)), label: ".env file" },
	{ test: (p) => /\.(key|pem|p12|pfx|jks|keystore)$/i.test(p), label: "private key/cert" },
	{ test: (p) => /(^|\/)\.ssh(\/|$)/.test(p), label: ".ssh directory" },
	{ test: (p) => /(^|\/)\.gnupg(\/|$)/.test(p), label: ".gnupg directory" },
	{ test: (p) => /(^|\/)\.aws(\/|$)/.test(p), label: ".aws directory" },
	{ test: (p) => /(^|\/)\.pgpass$/.test(p), label: ".pgpass" },
	{ test: (p) => /(^|\/)\.netrc$/.test(p), label: ".netrc" },
	{ test: (p) => /(^|\/)credentials(\.|$)/i.test(basename(p)), label: "credentials file" },
	{ test: (p) => p.startsWith("/etc/"), label: "/etc/" },
	{ test: (p) => p.startsWith("/usr/"), label: "/usr/" },
	{ test: (p) => p.startsWith("/root/"), label: "/root/" },
	{ test: (p) => p.startsWith("/boot/"), label: "/boot/" },
	{ test: (p) => p.startsWith("/var/log/"), label: "/var/log/" },
];

function basename(p: string): string {
	const idx = p.lastIndexOf("/");
	return idx >= 0 ? p.slice(idx + 1) : p;
}

function matchSensitivePath(p: string): string | null {
	for (const m of SENSITIVE_PATH_PATTERNS) {
		if (m.test(p)) return m.label;
	}
	return null;
}

function matchDestructiveBash(cmd: string): string | null {
	for (const m of DESTRUCTIVE_BASH) {
		if (m.pattern.test(cmd)) return m.label;
	}
	return null;
}

function truncateForPreview(text: string, maxLines = 10): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	return `${lines.slice(0, maxLines).join("\n")}\n... (${lines.length - maxLines} more lines)`;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Per-session memory: pattern/path → user's previous answer.
	// Resets when the pi process restarts.
	const remembered = new Map<string, "allow" | "block">();

	// Parsed once per pi process (the spawning bridge sets it per bot; it
	// never changes during a process lifetime). null => non-bot pi => the
	// per-bot gate is skipped entirely (existing behavior preserved).
	const botPolicy = parseBotPolicy();

	pi.on("tool_call", async (event, ctx) => {
		// Per-bot policy gate runs FIRST. A block is final; a null result
		// falls through to the existing destructive/sensitive gate below.
		if (botPolicy) {
			const decision = botPolicyGate(event, botPolicy);
			if (decision) return decision;
		}

		// --- Bash ---
		if (event.toolName === "bash") {
			const command = (event.input as { command?: string }).command ?? "";
			const matched = matchDestructiveBash(command);
			if (!matched) return undefined;

			const memKey = `bash:${matched}`;
			const prior = remembered.get(memKey);
			if (prior === "allow") return undefined;
			if (prior === "block") return { block: true, reason: `User previously blocked: ${matched}` };

			if (!ctx.hasUI) {
				return { block: true, reason: `Destructive command blocked (no UI to confirm): ${matched}` };
			}

			// Interactive prompt imminent — let notify.ts ping the user's phone.
			pi.events.emit("pi-lab:attention", { reason: "permission", detail: matched });
			const choice = await ctx.ui.confirm(
				`⚠️ Destructive bash: ${matched}`,
				`"${truncateForPreview(command, 4)}"\n\nApprove for the rest of this session, or block?`,
			);
			remembered.set(memKey, choice ? "allow" : "block");
			return choice ? undefined : { block: true, reason: `Blocked by user: ${matched}` };
		}

		// --- Write ---
		if (event.toolName === "write") {
			const path = (event.input as { path?: string }).path ?? "";
			const content = (event.input as { content?: string }).content ?? "";
			const matched = matchSensitivePath(path);
			if (!matched) return undefined;

			const memKey = `write:${path}`;
			const prior = remembered.get(memKey);
			if (prior === "allow") return undefined;
			if (prior === "block") return { block: true, reason: `User previously blocked write: ${path}` };

			if (!ctx.hasUI) {
				return { block: true, reason: `Blocked write to ${matched}: ${path}` };
			}

			pi.events.emit("pi-lab:attention", { reason: "permission", detail: `write ${path}` });
			const choice = await ctx.ui.confirm(
				`Write to ${matched}: ${path}`,
				`Overwriting sensitive path.\n\nContent preview:\n${truncateForPreview(content, 8)}\n\nApprove for the rest of this session, or block?`,
			);
			remembered.set(memKey, choice ? "allow" : "block");
			return choice ? undefined : { block: true, reason: "Blocked by user" };
		}

		// --- Edit ---
		if (event.toolName === "edit") {
			const path = (event.input as { path?: string }).path ?? "";
			const matched = matchSensitivePath(path);
			if (!matched) return undefined;

			const memKey = `edit:${path}`;
			const prior = remembered.get(memKey);
			if (prior === "allow") return undefined;
			if (prior === "block") return { block: true, reason: `User previously blocked edit: ${path}` };

			if (!ctx.hasUI) {
				return { block: true, reason: `Blocked edit on ${matched}: ${path}` };
			}

			pi.events.emit("pi-lab:attention", { reason: "permission", detail: `edit ${path}` });
			const edits = (event.input as { edits?: Array<{ oldText: string; newText: string }> }).edits ?? [];
			const choice = await ctx.ui.confirm(
				`Edit ${matched}: ${path}`,
				`Editing sensitive path (${edits.length} replacement${edits.length === 1 ? "" : "s"}).\n\nApprove for the rest of this session, or block?`,
			);
			remembered.set(memKey, choice ? "allow" : "block");
			return choice ? undefined : { block: true, reason: "Blocked by user" };
		}

		return undefined;
	});
}
