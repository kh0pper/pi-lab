/**
 * checkpoint/index.ts — automatic file checkpoints + /rewind (Claude Code parity).
 *
 * Snapshot mechanism: a shadow git repo per session (see shadow-git.ts) —
 * the user's repo and git state are never touched.
 *
 * Trigger (lazy): armed at agent_start; the FIRST file-mutating tool call of
 * the run (bash, edit, write, bash_background, + settings.mutatingTools) takes
 * one snapshot before the tool executes, then disarms. Read-only runs cost
 * nothing. `!cmd` user bash also snapshots when armed. Snapshot failures never
 * block the tool; 3 consecutive failures disable checkpointing for the session.
 *
 * /rewind: pick a checkpoint, then scope — Conversation + files / Files only /
 * Conversation only. Files restore = safety commit (a redo point) + hard reset
 * in the shadow repo. Conversation restore = pi's native navigateTree to the
 * checkpoint's anchoring user message (chat truncates, prompt lands in the
 * editor). The phone/PWA bus path is files-only and two-step:
 * /rewind list → /rewind files <n> confirm.
 *
 * Interplay with background tasks: a running background task would keep
 * mutating files right through a restore — /rewind warns and offers to kill
 * running tasks first (via the pi-lab:bg-list / pi-lab:bg-kill-all bus events
 * answered by background-tasks.ts).
 *
 * Not checkpointed: .gitignore'd files (intentional — node_modules etc.; note
 * this means ignored files like .env do NOT rewind), nested repos/submodules
 * (gitlink stubs only), and the user repo's own git state (same gap as CC).
 *
 * Settings:
 *   "checkpoints": { "enabled": true, "maxPerSession": 100, "maxAgeDays": 7,
 *                    "excludePatterns": [], "mutatingTools": [], "timeoutMs": 30000 }
 *
 * No-op for bots (PI_BOT_PERMISSION_POLICY) and subagent children
 * (PIBOT_SUBAGENT_DEPTH >= 1).
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { ShadowGit } from "./shadow-git.js";

interface CheckpointConfig {
	enabled?: boolean;
	maxPerSession?: number;
	maxAgeDays?: number;
	excludePatterns?: string[];
	mutatingTools?: string[];
	timeoutMs?: number;
}

interface CheckpointRecord {
	sha: string;
	ts: number;
	userEntryId: string | null;
	label: string;
}

const BASE_MUTATING_TOOLS = ["bash", "edit", "write", "bash_background"];

function loadConfig(): CheckpointConfig {
	const settingsPath = resolve(homedir(), ".pi", "agent", "settings.json");
	if (!existsSync(settingsPath)) return {};
	try {
		const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as { checkpoints?: CheckpointConfig };
		return raw.checkpoints ?? {};
	} catch {
		return {};
	}
}

function firstLineOfContent(content: unknown): string {
	let text = "";
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		const t = content.find(
			(b) => b && typeof b === "object" && (b as { type?: string }).type === "text",
		) as { text?: string } | undefined;
		text = t?.text ?? "";
	}
	return text.split("\n")[0].trim().slice(0, 60) || "(no prompt)";
}

export default function (pi: ExtensionAPI) {
	// Bots and subagent children never checkpoint.
	if (process.env["PI_BOT_PERMISSION_POLICY"]) return;
	if (Number(process.env["PIBOT_SUBAGENT_DEPTH"] ?? "0") >= 1) return;

	const checkpointsRoot = join(homedir(), ".pi", "agent", "checkpoints");

	let sessionId = "";
	let sessionCwd = process.cwd();
	let shadow: ShadowGit | null = null;
	let armed = false;
	let failures = 0;
	let disabledForSession = false;
	let warnedPathological = false;
	let lastCtx: ExtensionContext | null = null;

	// Tournament suspension (D5): while suspended, arming stops and /rewind
	// refuses. Token-matched resume; safety timer + session boundaries clear it.
	let suspended = false;
	let suspendToken = "";
	let suspendTimer: ReturnType<typeof setTimeout> | null = null;

	function clearSuspension(): void {
		suspended = false;
		suspendToken = "";
		if (suspendTimer) {
			clearTimeout(suspendTimer);
			suspendTimer = null;
		}
	}

	function indexPath(): string {
		return join(checkpointsRoot, sessionId, "index.json");
	}

	function readIndex(): CheckpointRecord[] {
		try {
			return JSON.parse(readFileSync(indexPath(), "utf8")) as CheckpointRecord[];
		} catch {
			return [];
		}
	}

	function writeIndex(records: CheckpointRecord[]): void {
		const max = loadConfig().maxPerSession ?? 100;
		mkdirSync(join(checkpointsRoot, sessionId), { recursive: true });
		writeFileSync(indexPath(), JSON.stringify(records.slice(-max), null, 2));
	}

	function getShadow(): ShadowGit {
		if (!shadow) {
			const cfg = loadConfig();
			shadow = new ShadowGit({
				gitDir: join(checkpointsRoot, sessionId, "git"),
				workTree: sessionCwd,
				timeoutMs: cfg.timeoutMs ?? 30000,
				excludePatterns: cfg.excludePatterns ?? [],
			});
		}
		return shadow;
	}

	/** The checkpoint anchors to the last real user prompt on the current branch.
	 * (Wake turns triggered by background tasks anchor to the previous real
	 * prompt — custom_message entries are a different entry type and are
	 * naturally skipped here.) */
	function findAnchor(ctx: ExtensionContext): { id: string | null; label: string } {
		try {
			const branch = ctx.sessionManager.getBranch();
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i] as {
					type?: string;
					id?: string;
					message?: { role?: string; content?: unknown };
				};
				if (entry.type === "message" && entry.message?.role === "user") {
					return { id: entry.id ?? null, label: firstLineOfContent(entry.message.content) };
				}
			}
		} catch {
			// fall through
		}
		return { id: null, label: "(unknown prompt)" };
	}

	function isPathologicalCwd(): boolean {
		const wt = resolve(sessionCwd);
		return wt === resolve(homedir()) || wt === "/";
	}

	async function takeCheckpoint(ctx: ExtensionContext): Promise<void> {
		if (isPathologicalCwd()) {
			if (!warnedPathological) {
				warnedPathological = true;
				if (ctx.hasUI)
					ctx.ui.notify(
						"[checkpoint] session cwd is your home directory — checkpointing disabled (tree too large). cd into a project to get /rewind.",
						"warning",
					);
			}
			return;
		}
		const anchor = findAnchor(ctx);
		try {
			const sha = await getShadow().snapshot(anchor.label);
			// Re-check AFTER the awaited snapshot: a tournament suspend that landed
			// while this was in flight must not get a visible index record of an
			// attempt-mutated tree (the snapshot itself is harmless — ref-pinned).
			if (suspended) return;
			const records = readIndex();
			// Same sha as the latest record = nothing changed since; still record it
			// so each prompt has a rewind point, but dedupe consecutive identical shas.
			if (records.length === 0 || records[records.length - 1].sha !== sha) {
				records.push({ sha, ts: Date.now(), userEntryId: anchor.id, label: anchor.label });
				writeIndex(records);
			}
			failures = 0;
		} catch (err) {
			failures++;
			if (failures >= 3) {
				disabledForSession = true;
				if (ctx.hasUI)
					ctx.ui.notify(
						`[checkpoint] disabled for this session after 3 failures (last: ${(err as Error).message.slice(0, 120)})`,
						"warning",
					);
			}
		}
	}

	function purgeStale(): void {
		const maxAgeDays = loadConfig().maxAgeDays ?? 7;
		const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
		try {
			for (const dir of readdirSync(checkpointsRoot)) {
				const p = join(checkpointsRoot, dir);
				try {
					if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true });
				} catch {
					// racing session — skip
				}
			}
		} catch {
			// root missing — nothing to purge
		}
	}

	// --- events ---------------------------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			sessionId = `nosession-${process.pid}`;
		}
		sessionCwd = ctx.cwd ?? process.cwd();
		shadow = null; // re-derive (fork/new give a fresh session id)
		disabledForSession = false;
		failures = 0;
		clearSuspension(); // a wedged suspend must not outlive its session
		purgeStale();
	});

	pi.on("session_shutdown", () => {
		clearSuspension();
	});

	pi.on("agent_start", () => {
		armed = !suspended && !disabledForSession && loadConfig().enabled !== false && sessionId !== "";
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!armed || suspended) return undefined;
		const mutating = new Set([...BASE_MUTATING_TOOLS, ...(loadConfig().mutatingTools ?? [])]);
		if (!mutating.has(event.toolName)) return undefined;
		armed = false;
		await takeCheckpoint(ctx); // awaited pre-execution: snapshot is pre-mutation
		return undefined;
	});

	pi.on("user_bash", async (_event, ctx) => {
		if (!armed || suspended) return undefined;
		armed = false;
		await takeCheckpoint(ctx);
		return undefined;
	});

	// --- /rewind ---------------------------------------------------------------

	interface BgQuery {
		running?: string[];
	}

	async function restoreFiles(record: CheckpointRecord): Promise<string> {
		const { safetySha } = await getShadow().restore(record.sha);
		const records = readIndex();
		if (records.length === 0 || records[records.length - 1].sha !== safetySha) {
			records.push({ sha: safetySha, ts: Date.now(), userEntryId: null, label: "pre-rewind (redo point)" });
			writeIndex(records);
		}
		let stat = "";
		try {
			stat = await getShadow().diffStat(record.sha, safetySha);
		} catch {
			// summary is best-effort
		}
		return stat;
	}

	pi.registerCommand("rewind", {
		description: "Rewind files and/or conversation to a checkpoint",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (suspended) {
				ctx.ui.notify("[checkpoint] a tournament is in progress — /rewind is disabled until it finishes", "warning");
				return;
			}
			const records = readIndex();
			if (records.length === 0) {
				ctx.ui.notify("[checkpoint] no checkpoints in this session yet", "info");
				return;
			}
			if (resolve(ctx.cwd) !== resolve(sessionCwd)) {
				ctx.ui.notify(`[checkpoint] cwd changed since checkpoints were taken (${sessionCwd}) — refusing`, "warning");
				return;
			}
			await ctx.waitForIdle();

			// Running background tasks would re-mutate the restored tree.
			const bg: BgQuery = {};
			pi.events.emit("pi-lab:bg-list", bg);
			if ((bg.running ?? []).length > 0) {
				const kill = await ctx.ui.confirm(
					"Background tasks are running",
					`${bg.running!.length} background task(s) will keep writing files after a restore:\n${bg
						.running!.join("\n")}\n\nKill them before rewinding?`,
				);
				if (kill) pi.events.emit("pi-lab:bg-kill-all", {});
			}

			const newestFirst = [...records].reverse();
			const labels = newestFirst.map(
				(r) => `${new Date(r.ts).toLocaleTimeString()}  ${r.label}${r.userEntryId ? "" : "  [files-only]"}`,
			);
			const picked = await ctx.ui.select("Rewind to:", [...labels, "Cancel"]);
			if (!picked || picked === "Cancel") return;
			const record = newestFirst[labels.indexOf(picked)];
			if (!record) return;

			const canRestoreConversation =
				record.userEntryId !== null &&
				(() => {
					try {
						return Boolean(ctx.sessionManager.getEntry(record.userEntryId!));
					} catch {
						return false;
					}
				})();

			const scopeOptions = canRestoreConversation
				? ["Conversation + files", "Files only", "Conversation only", "Cancel"]
				: ["Files only", "Cancel"];
			const scope = await ctx.ui.select("Restore:", scopeOptions);
			if (!scope || scope === "Cancel") return;

			let stat = "";
			if (scope.includes("files") || scope.includes("Files")) {
				try {
					stat = await restoreFiles(record);
				} catch (err) {
					ctx.ui.notify(`[checkpoint] files restore failed: ${(err as Error).message.slice(0, 160)}`, "error");
					return;
				}
			}
			if (scope.startsWith("Conversation") && canRestoreConversation) {
				await ctx.navigateTree(record.userEntryId!);
			}
			pi.sendMessage(
				{
					customType: "checkpoint-restored",
					content:
						`Rewound to checkpoint "${record.label}" (${new Date(record.ts).toLocaleTimeString()}), scope: ${scope}.` +
						(stat ? `\nUndone changes:\n${stat}` : "") +
						`\nA redo point was saved — /rewind to "pre-rewind (redo point)" to undo this restore.` +
						`\nNote: your repo's own git state (branches, index, commits) is not rewound.`,
					display: true,
					details: { sha: record.sha },
				},
				{ triggerTurn: false },
			);
		},
	});

	// Phone/PWA bridge: files-only, two-step (list, then explicit index + confirm).
	pi.events.on("command:rewind", (data) => {
		const arg = (((data as { args?: string })?.args) ?? "").trim();
		const records = readIndex();
		const reply = (content: string) =>
			pi.sendMessage({ customType: "checkpoint", content, display: true, details: undefined }, { triggerTurn: false });
		void (async () => {
			if (!arg || arg === "list") {
				if (records.length === 0) return reply("No checkpoints in this session.");
				const lines = [...records]
					.reverse()
					.map((r, i) => `${i + 1}. ${new Date(r.ts).toLocaleTimeString()}  ${r.label}`);
				return reply(
					`Checkpoints (newest first):\n${lines.join("\n")}\n\nRestore files with: /rewind files <n> confirm`,
				);
			}
			const m = arg.match(/^files\s+(\d+)(\s+confirm)?$/);
			if (!m) return reply('Usage: "/rewind list" or "/rewind files <n> confirm" (files-only from the web).');
			const idx = Number(m[1]) - 1;
			const newestFirst = [...records].reverse();
			const record = newestFirst[idx];
			if (!record) return reply(`No checkpoint #${m[1]}. Use /rewind list.`);
			if (!m[2]) return reply(`Would restore files to "${record.label}". Re-run as: /rewind files ${m[1]} confirm`);
			const bg: BgQuery = {};
			pi.events.emit("pi-lab:bg-list", bg);
			if ((bg.running ?? []).length > 0) {
				return reply(
					`Refusing: ${bg.running!.length} background task(s) still running would re-mutate restored files. Kill them first (task_kill).`,
				);
			}
			try {
				const stat = await restoreFiles(record);
				reply(`Files restored to "${record.label}".${stat ? `\nUndone:\n${stat}` : ""}\nA redo point was saved.`);
			} catch (err) {
				reply(`Restore failed: ${(err as Error).message.slice(0, 160)}`);
			}
		})();
	});

	// keep lastCtx fresh for any future needs (parity with other extensions)
	pi.on("agent_end", (_event, ctx) => {
		lastCtx = ctx;
	});
	void lastCtx;

	// -------------------------------------------------------------------------
	// pi-lab:checkpoint-* bus API (D5) — the ONLY sanctioned cross-extension
	// access to the shadow repo. All calls route through this module's single
	// ShadowGit instance (its per-instance mutex serializes against arming
	// snapshots); a second instance on the same gitDir would bypass the mutex.
	// Mutable-payload pattern: async ops set payload.promise; an unset promise
	// means REFUSED and the caller must abort. Emitters are in-process extension
	// code only (the model/hooks/web cannot emit arbitrary bus events).
	// `internal: true` snapshots/restores pin refs but write NO index.json
	// records — a k-attempt tournament leaves exactly 2 visible /rewind entries.
	// -------------------------------------------------------------------------

	pi.events.on("pi-lab:checkpoint-status", (payload: unknown) => {
		const p = payload as {
			ok?: boolean;
			sessionId?: string;
			cwd?: string;
			disabled?: boolean;
			suspended?: boolean;
			pathologicalCwd?: boolean;
		};
		p.ok = sessionId !== "" && loadConfig().enabled !== false;
		p.sessionId = sessionId;
		p.cwd = sessionCwd;
		p.disabled = disabledForSession;
		p.suspended = suspended;
		p.pathologicalCwd = isPathologicalCwd();
	});

	pi.events.on("pi-lab:checkpoint-snapshot", (payload: unknown) => {
		const p = payload as { label?: string; internal?: boolean; promise?: Promise<{ sha: string }> };
		if (sessionId === "" || disabledForSession || isPathologicalCwd()) return;
		const label = p.label ?? "bus snapshot";
		p.promise = getShadow()
			.snapshot(label)
			.then((sha) => {
				if (!p.internal) {
					const records = readIndex();
					if (records.length === 0 || records[records.length - 1].sha !== sha) {
						records.push({ sha, ts: Date.now(), userEntryId: null, label });
						writeIndex(records);
					}
				}
				return { sha };
			});
	});

	pi.events.on("pi-lab:checkpoint-restore", (payload: unknown) => {
		const p = payload as { sha?: string; internal?: boolean; promise?: Promise<{ safetySha: string }> };
		if (sessionId === "" || disabledForSession || !p.sha) return;
		const sha = p.sha;
		p.promise = getShadow()
			.restore(sha)
			.then(({ safetySha }) => {
				if (!p.internal) {
					const records = readIndex();
					records.push({ sha: safetySha, ts: Date.now(), userEntryId: null, label: "pre-rewind (redo point)" });
					writeIndex(records);
				}
				return { safetySha };
			});
	});

	pi.events.on("pi-lab:checkpoint-diff", (payload: unknown) => {
		const p = payload as {
			fromSha?: string;
			toSha?: string;
			binary?: boolean;
			promise?: Promise<{ patch: string; files: number; insertions: number; deletions: number; fileList: string[] }>;
		};
		if (sessionId === "" || !p.fromSha || !p.toSha) return;
		const { fromSha, toSha } = p;
		p.promise = (async () => {
			const stats = await getShadow().diffNumstat(fromSha, toSha);
			const patch = p.binary
				? await getShadow().diffBinary(fromSha, toSha)
				: await getShadow().diffText(fromSha, toSha);
			return { patch, ...stats };
		})();
	});

	pi.events.on("pi-lab:checkpoint-apply", (payload: unknown) => {
		const p = payload as { patch?: string; threeWay?: boolean; promise?: Promise<{ ok: boolean; stderr: string }> };
		if (sessionId === "" || !p.patch) return;
		p.promise = getShadow().applyPatch(p.patch, { threeWay: p.threeWay });
	});

	pi.events.on("pi-lab:checkpoint-suspend", (payload: unknown) => {
		const p = payload as { reason?: string; maxMinutes?: number; ok?: boolean; token?: string };
		if (suspended) {
			p.ok = false;
			return;
		}
		suspended = true;
		suspendToken = randomBytes(8).toString("hex");
		const maxMs = Math.min(p.maxMinutes ?? 90, 240) * 60_000;
		suspendTimer = setTimeout(() => {
			clearSuspension();
			if (lastCtx?.hasUI)
				lastCtx.ui.notify(`[checkpoint] suspension (${p.reason ?? "?"}) hit its ${maxMs / 60000}m safety cap — arming resumed`, "warning");
		}, maxMs);
		suspendTimer.unref?.();
		p.ok = true;
		p.token = suspendToken;
	});

	pi.events.on("pi-lab:checkpoint-resume", (payload: unknown) => {
		const p = payload as { token?: string; ok?: boolean };
		if (!suspended || p.token !== suspendToken) {
			p.ok = false;
			return;
		}
		clearSuspension();
		p.ok = true;
	});
}
