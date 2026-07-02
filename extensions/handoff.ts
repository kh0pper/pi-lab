/**
 * handoff.ts — session lifecycle: /clear, /handoff, /resume-handoff + resume notice.
 *
 * /clear             — exact alias of pi's /new: fresh session file, same cwd, no handoff.
 * /handoff [focus]   — the full chain, no copy/paste:
 *                        1. ask the CURRENT session's model for a structured handoff
 *                           summary (marker-delimited turn, visible in the transcript),
 *                        2. persist it — locally (~/.pi/agent/handoffs/<cwd-hash>.json)
 *                           and to crow memory via the pi-lab:mcp-call bridge
 *                           (both fail-open),
 *                        3. start a fresh session and inject the handoff as its
 *                           opening context (custom message, no auto-turn).
 * /resume-handoff [force] — inject the cwd's stored handoff into the current session.
 * Resume notice      — new sessions in a cwd with a fresh unconsumed handoff get a
 *                      one-line notify: "handoff from 2h ago exists — /resume-handoff".
 *
 * Design constraints (review-verified, do not "simplify" these away):
 * - pi re-imports every extension fresh on each newSession (jiti moduleCache:false),
 *   so NOTHING in module state survives into the new session. All cross-session
 *   coordination goes through the handoff file: we mark consumed:true BEFORE
 *   calling newSession (reverting on cancel) so the new session's notice handler —
 *   a different module instance — reads it fresh and stays silent.
 * - pi.sendUserMessage at the ExtensionAPI level is fire-and-forget (promise
 *   swallowed), so the summary is captured by POLLING the session branch: stage A
 *   waits for our prompt to appear (idle: short timeout; mid-run followUp: long),
 *   stage B waits for a subsequent assistant message carrying the end marker.
 *   Marker keying prevents capturing the wrong turn when /handoff was queued
 *   behind a running task.
 * - The summary turn is internal: we emit "pi-lab:handoff-turn" first so hooks.ts
 *   skips UserPromptSubmit/Stop hooks and notify.ts skips the run-finished push.
 * - Running background tasks would be killed silently by session_shutdown("new");
 *   we check pi-lab:bg-list and confirm first (same hazard pattern as /rewind).
 * - PWA degradation: bus handlers have no command ctx (no newSession), so
 *   command:handoff runs phases 1-2 and posts a pointer; /resume-handoff and the
 *   notice have full PWA parity; command:clear posts a pointer.
 *
 * Settings ("handoff" key): { enabled, staleHours: 24, crowStore: true,
 *   category: "project", importanceDefault: 7 }.
 * Never runs for bots (PI_BOT_PERMISSION_POLICY) or subagents (PIBOT_SUBAGENT_DEPTH >= 1).
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Config + handoff file store
// ---------------------------------------------------------------------------

interface HandoffConfig {
	enabled?: boolean;
	staleHours?: number;
	/** A handoff younger than this auto-loads into the next fresh session (default 10). */
	autoInjectMinutes?: number;
	crowStore?: boolean;
	category?: string;
	importanceDefault?: number;
}

interface HandoffRecord {
	ts: number;
	cwd: string;
	repoName: string;
	summary: string;
	focus?: string;
	sessionFile?: string;
	consumed: boolean;
}

const HANDOFFS_DIR = join(homedir(), ".pi", "agent", "handoffs");
const BEGIN_MARKER = "===HANDOFF-BEGIN===";
const END_MARKER = "===HANDOFF-END===";

function loadConfig(): HandoffConfig {
	const p = resolve(homedir(), ".pi", "agent", "settings.json");
	if (!existsSync(p)) return {};
	try {
		return (JSON.parse(readFileSync(p, "utf8")) as { handoff?: HandoffConfig }).handoff ?? {};
	} catch {
		return {};
	}
}

function handoffPath(cwd: string): string {
	const hash = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
	return join(HANDOFFS_DIR, `${hash}.json`);
}

function readHandoff(cwd: string): HandoffRecord | null {
	try {
		return JSON.parse(readFileSync(handoffPath(cwd), "utf8")) as HandoffRecord;
	} catch {
		return null;
	}
}

function writeHandoff(cwd: string, record: HandoffRecord): void {
	mkdirSync(HANDOFFS_DIR, { recursive: true });
	const p = handoffPath(cwd);
	const tmp = `${p}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(record, null, 2));
	renameSync(tmp, p); // atomic
}

function humanAge(ts: number): string {
	const mins = Math.round((Date.now() - ts) / 60000);
	if (mins < 60) return `${mins}m`;
	if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
	return `${Math.round(mins / (60 * 24))}d`;
}

function repoNameOf(cwd: string): Promise<string> {
	return new Promise((resolvePromise) => {
		execFile("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 3000 }, (err, stdout) => {
			const top = !err && stdout.trim() ? stdout.trim() : "";
			resolvePromise(basename(top || resolve(cwd)));
		});
	});
}

// ---------------------------------------------------------------------------
// Branch inspection (capture + empty-session checks)
// ---------------------------------------------------------------------------

interface BranchMessageView {
	role: string;
	text: string;
}

function branchMessages(ctx: ExtensionContext): BranchMessageView[] {
	const out: BranchMessageView[] = [];
	try {
		for (const entry of ctx.sessionManager.getBranch()) {
			const e = entry as { type?: string; message?: { role?: string; content?: unknown } };
			if (e.type !== "message" || !e.message?.role) continue;
			let text = "";
			const c = e.message.content;
			if (typeof c === "string") text = c;
			else if (Array.isArray(c)) {
				text = c
					.filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
					.map((b) => (b as { text?: string }).text ?? "")
					.join("\n");
			}
			out.push({ role: e.message.role, text });
		}
	} catch {
		// empty view on error
	}
	return out;
}

function buildHandoffPrompt(focus: string): string {
	return (
		`Produce a handoff summary of this session for a brand-new session that has no memory of this one.` +
		(focus ? `\nFocus especially on: ${focus}` : "") +
		`\nAnswer from the conversation only; do not call tools.` +
		`\nOutput the summary between the exact marker lines below and nothing after the end marker:\n\n` +
		`${BEGIN_MARKER}\n## Goal\n## Current state\n## Decisions\n## Next steps\n## Key files\n## Gotchas\n${END_MARKER}`
	);
}

function buildInjection(record: HandoffRecord): string {
	return (
		`Handoff from the previous session in ${record.cwd} (${humanAge(record.ts)} ago` +
		(record.focus ? `, focus: ${record.focus}` : "") +
		`):\n\n${record.summary}\n\n` +
		`For deeper history you may call mcp__crow-memory__crow_recall_by_context("handoff ${record.repoName}").`
	);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	if (process.env["PI_BOT_PERMISSION_POLICY"]) return;
	if (Number(process.env["PIBOT_SUBAGENT_DEPTH"] ?? "0") >= 1) return;

	let pendingHandoff = false; // whole chain runs inside THIS runtime instance
	let sessionCwd = process.cwd();

	const toast = (message: string, type: "info" | "warning" | "error" = "info") =>
		pi.events.emit("command_result", { command: "handoff", message, type });

	const notifyBoth = (ctx: ExtensionContext | null, message: string, type: "info" | "warning" | "error" = "info") => {
		if (ctx?.hasUI) ctx.ui.notify(message, type);
		toast(message, type);
	};

	// --- capture: poll the branch for our prompt, then the marked answer ------

	async function generateSummary(
		ctx: ExtensionContext,
		prompt: string,
	): Promise<{ summary: string; unstructured: boolean } | null> {
		const wasIdle = ctx.isIdle();
		const baseCount = branchMessages(ctx).length;

		pi.events.emit("pi-lab:handoff-turn", {}); // hooks.ts + notify.ts one-shot skips
		void pi.sendUserMessage(prompt, wasIdle ? undefined : { deliverAs: "followUp" });

		// Stage A: our prompt appears in the branch. Idle: quick. Mid-run: the
		// original turn must finish first — allow long, bounded.
		const stageADeadline = Date.now() + (wasIdle ? 30_000 : 10 * 60_000);
		let promptIndex = -1;
		while (Date.now() < stageADeadline) {
			const msgs = branchMessages(ctx);
			promptIndex = msgs.findIndex((m, i) => i >= baseCount && m.role === "user" && m.text === prompt);
			if (promptIndex >= 0) break;
			await sleep(500);
		}
		if (promptIndex < 0) return null;

		// Stage B: an assistant message after our prompt. Prefer marker capture;
		// fall back to raw text only once the turn has clearly ended (agent idle).
		const stageBDeadline = Date.now() + 120_000;
		while (Date.now() < stageBDeadline) {
			const msgs = branchMessages(ctx);
			for (let i = promptIndex + 1; i < msgs.length; i++) {
				if (msgs[i].role !== "assistant" || !msgs[i].text.trim()) continue;
				const m = msgs[i].text.match(
					new RegExp(`${BEGIN_MARKER}\\s*([\\s\\S]*?)\\s*${END_MARKER}`),
				);
				if (m?.[1]?.trim()) return { summary: m[1].trim(), unstructured: false };
				// No markers: accept raw only when the agent has gone idle (turn done).
				if (ctx.isIdle()) return { summary: msgs[i].text.trim(), unstructured: true };
			}
			await sleep(500);
		}
		return null;
	}

	// --- crow store (fail-open) -------------------------------------------------

	async function storeToCrow(record: HandoffRecord): Promise<boolean> {
		const cfg = loadConfig();
		if (cfg.crowStore === false) return true;
		const payload: {
			server: string;
			tool: string;
			args: Record<string, unknown>;
			timeoutMs: number;
			promise?: Promise<{ isError: boolean; text: string }>;
		} = {
			server: "crow-memory",
			tool: "crow_store_memory",
			args: {
				content: `Session handoff (${record.repoName}, ${record.cwd}, ${new Date(record.ts).toISOString()}):\n\n${record.summary}`,
				category: cfg.category ?? "project",
				context: `handoff ${record.repoName} ${record.cwd}`,
				// crow's schema wants a comma-separated STRING, not an array (verified live)
				tags: `handoff,repo:${record.repoName}`,
				importance: cfg.importanceDefault ?? 7,
			},
			timeoutMs: 8000,
		};
		pi.events.emit("pi-lab:mcp-call", payload);
		if (!payload.promise) return false; // server missing/unhealthy — fail open
		try {
			const r = await payload.promise;
			return !r.isError;
		} catch {
			return false;
		}
	}

	// --- persist + inject (shared by TUI chain and /resume-handoff) --------------

	async function persistHandoff(
		ctx: ExtensionContext,
		summary: string,
		focus: string,
		unstructured: boolean,
	): Promise<HandoffRecord> {
		const repoName = await repoNameOf(sessionCwd);
		let sessionFile: string | undefined;
		try {
			sessionFile = ctx.sessionManager.getSessionFile();
		} catch {
			// optional
		}
		const record: HandoffRecord = {
			ts: Date.now(),
			cwd: resolve(sessionCwd),
			repoName,
			summary: unstructured ? `(unstructured handoff)\n${summary}` : summary,
			focus: focus || undefined,
			sessionFile,
			consumed: false,
		};
		writeHandoff(sessionCwd, record);
		const crowOk = await storeToCrow(record);
		if (!crowOk) notifyBoth(ctx, "[handoff] crow store skipped — handoff saved locally", "warning");
		return record;
	}

	function injectHandoff(record: HandoffRecord): void {
		pi.sendMessage(
			{ customType: "handoff-context", content: buildInjection(record), display: true, details: undefined },
			{ triggerTurn: false },
		);
	}

	// --- /clear --------------------------------------------------------------------

	/**
	 * Clear conversation context via navigateTree to the session's first entry.
	 * HARD-WON FINDING (pi v0.74.2, do not "simplify" back to newSession):
	 * ctx.newSession() from an extension command wedges the interactive input
	 * loop permanently once the session has completed turns — reproduced inline,
	 * with setup/withSession, and deferred via setTimeout. navigateTree is the
	 * mechanism checkpoint's /rewind already uses successfully: the leaf moves
	 * before the first message (empty context), the old branch stays in the
	 * session tree, and the TUI stays alive. Closer to Claude Code's /clear
	 * semantics than /new anyway (wipe context, keep working).
	 * Returns false when there is nothing to clear.
	 */
	async function clearContext(ctx: ExtensionCommandContext): Promise<boolean> {
		let firstId: string | null = null;
		try {
			const branch = ctx.sessionManager.getBranch();
			const first = branch.find((e) => (e as { type?: string }).type === "message");
			firstId = (first as { id?: string } | undefined)?.id ?? null;
		} catch {
			// fall through
		}
		if (!firstId) return false;
		await ctx.waitForIdle();
		const { cancelled } = await ctx.navigateTree(firstId);
		return !cancelled;
	}

	pi.registerCommand("clear", {
		description: "Clear the conversation context (old branch stays in the session tree; no handoff)",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const cleared = await clearContext(ctx);
			ctx.ui.notify(cleared ? "[clear] context cleared (previous branch kept in /tree)" : "[clear] nothing to clear", "info");
		},
	});

	pi.events.on("command:clear", () => {
		pi.events.emit("command_result", {
			command: "clear",
			message: "/clear can't switch sessions from the web — use the Sessions page to spawn a fresh session.",
			type: "info",
		});
	});

	// --- /handoff --------------------------------------------------------------------

	async function runHandoffPhases12(
		ctx: ExtensionContext,
		focus: string,
	): Promise<HandoffRecord | null> {
		const captured = await generateSummary(ctx, buildHandoffPrompt(focus));
		if (!captured) {
			pendingHandoff = false;
			notifyBoth(ctx, "[handoff] summary generation timed out — session unchanged", "error");
			return null;
		}
		return persistHandoff(ctx, captured.summary, focus, captured.unstructured);
	}

	pi.registerCommand("handoff", {
		description: "Summarize this session, save to memory, and continue in a fresh session: /handoff [focus]",
		handler: async (args, ctx: ExtensionCommandContext) => {
			if (loadConfig().enabled === false) return;
			if (pendingHandoff) {
				ctx.ui.notify("[handoff] already in progress", "warning");
				return;
			}
			// A running tournament (checkpoint suspension) is working from this
			// conversation — clearing it mid-run would pull the rug out.
			const cpStatus: { suspended?: boolean } = {};
			pi.events.emit("pi-lab:checkpoint-status", cpStatus);
			if (cpStatus.suspended) {
				ctx.ui.notify("[handoff] a tournament is in progress — try again when it finishes", "warning");
				return;
			}
			const hasAssistant = branchMessages(ctx).some((m) => m.role === "assistant" && m.text.trim());
			if (!hasAssistant) {
				ctx.ui.notify("[handoff] nothing to hand off — starting a blank session", "info");
				await ctx.newSession();
				return;
			}
			pendingHandoff = true;
			try {
				const record = await runHandoffPhases12(ctx, args.trim());
				if (!record) return;

				// Same session, fresh context: clear via navigateTree (see
				// clearContext for why NOT newSession), then inject the handoff.
				// Background tasks survive (no session teardown happens).
				const cleared = await clearContext(ctx);
				if (!cleared) {
					notifyBoth(ctx, "[handoff] saved, but context clear failed — /resume-handoff after /new to load it", "warning");
					return;
				}
				injectHandoff(record);
				writeHandoff(sessionCwd, { ...record, consumed: true });
				notifyBoth(ctx, "[handoff] context cleared and handoff loaded — keep rolling", "info");
			} finally {
				pendingHandoff = false;
			}
		},
	});

	// PWA path: no command ctx on the bus — run phases 1-2, then point at Sessions.
	pi.events.on("command:handoff", (data) => {
		if (loadConfig().enabled === false) return;
		if (pendingHandoff || !lastCtx) return;
		const focus = (((data as { args?: string })?.args) ?? "").trim();
		pendingHandoff = true;
		void (async () => {
			try {
				const record = await runHandoffPhases12(lastCtx!, focus);
				if (record) {
					toast(
						"handoff saved — start a fresh session from the Sessions page and run /resume-handoff there, or it will be offered automatically.",
						"info",
					);
				}
			} finally {
				pendingHandoff = false;
			}
		})();
	});

	// --- /resume-handoff -----------------------------------------------------------

	function resumeHandoff(ctx: ExtensionContext | null, force: boolean): void {
		const record = readHandoff(sessionCwd);
		if (!record) {
			notifyBoth(ctx, "[handoff] no handoff found for this directory", "info");
			return;
		}
		const staleMs = (loadConfig().staleHours ?? 24) * 3600_000;
		if (Date.now() - record.ts > staleMs && !force) {
			notifyBoth(
				ctx,
				`[handoff] handoff is ${humanAge(record.ts)} old (stale) — "/resume-handoff force" to load anyway`,
				"warning",
			);
			return;
		}
		injectHandoff(record);
		writeHandoff(sessionCwd, { ...record, consumed: true });
		notifyBoth(ctx, "[handoff] handoff loaded into context", "info");
	}

	pi.registerCommand("resume-handoff", {
		description: "Load this directory's saved handoff into the current session: /resume-handoff [force]",
		handler: async (args, ctx) => {
			resumeHandoff(ctx, args.trim() === "force");
		},
	});

	pi.events.on("command:resume-handoff", (data) => {
		resumeHandoff(lastCtx, (((data as { args?: string })?.args) ?? "").trim() === "force");
	});

	// --- resume notice ---------------------------------------------------------------

	let lastCtx: ExtensionContext | null = null;

	pi.on("session_start", (event, ctx) => {
		lastCtx = ctx;
		sessionCwd = ctx.cwd ?? process.cwd();
		if (loadConfig().enabled === false) return;
		if (event.reason !== "startup" && event.reason !== "new") return;
		const record = readHandoff(sessionCwd); // fresh read every time
		if (!record || record.consumed) return;
		const ageMs = Date.now() - record.ts;
		// A YOUNG handoff auto-loads: this is the second half of the /handoff flow
		// (/handoff saves → user runs /new → the fresh session picks it up here).
		const autoMs = (loadConfig().autoInjectMinutes ?? 10) * 60_000;
		if (ageMs <= autoMs) {
			injectHandoff(record);
			writeHandoff(sessionCwd, { ...record, consumed: true });
			const msg = `handoff from ${humanAge(record.ts)} ago loaded automatically`;
			if (ctx.hasUI) ctx.ui.notify(msg, "info");
			toast(msg, "info");
			return;
		}
		// Older (but not stale): offer, don't impose.
		if (ageMs > (loadConfig().staleHours ?? 24) * 3600_000) return;
		const msg = `handoff from ${humanAge(record.ts)} ago exists — /resume-handoff to load`;
		if (ctx.hasUI) ctx.ui.notify(msg, "info");
		toast(msg, "info");
	});

	pi.on("agent_end", (_event, ctx) => {
		lastCtx = ctx;
	});

	// Mutual exclusion with the tournament (D5): it must not clear the very
	// conversation it is working from. Synchronous mutable-payload query.
	pi.events.on("pi-lab:handoff-status", (payload: unknown) => {
		(payload as { pending?: boolean }).pending = pendingHandoff;
	});
}
