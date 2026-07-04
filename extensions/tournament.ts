/**
 * tournament.ts — best-of-N step tournament (D5, research rank 2).
 *
 * /tournament [k] <task> — run the task k times (default 2, max 4) as isolated
 * subagent attempts, each from the same checkpointed baseline:
 *
 *   suspend checkpoint arming → baseline snapshot → k × (attempt → internal
 *   snapshot → shadow diff → critics score → internal restore) → rank →
 *   apply the winner's binary patch → resume arming.
 *
 * All shadow-repo access goes through the pi-lab:checkpoint-* bus API (single
 * ShadowGit instance — a second instance would bypass its mutex). Attempts use
 * the architect→editor pair by default (tournament.attemptAgent: "worker" for
 * the cheap variant) with a diversity prompt per attempt index. Critics score
 * the SHADOW diff (exactly the attempt's changes — no work-tree dirt) via
 * critic/index.ts's exported critiqueArtifact.
 *
 * Ranking tuple (first difference wins): passCount desc → blockers asc
 * (unparseable/critic-failure = fail-closed synthetic blocker) → warns asc →
 * diffLines asc → attempt index. Zero-pass (diffs exist but no critic passed):
 * apply the least-bad, confirm-gated when a UI exists. All-failed (no diffs):
 * restore baseline and report.
 *
 * AUTO-TRIGGER (Phase 3, settings tournament.auto, DEFAULT FALSE): when the
 * post-plan auto-critique fails, run a tournament over the FIX task on the
 * current tree. Single-shot: tournament-sourced verdicts never re-trigger.
 * The flip-to-default criterion lives in docs/ROADMAP.md (critic-quality
 * telemetry gate — ~30 logged runs reviewed).
 *
 * Refuses when: checkpoint disabled/suspended/pathological cwd, plan mode
 * enabled OR executing (attempt children aren't tool-restricted by the parent),
 * a handoff is pending, another tournament is running, or background tasks are
 * running and the user declines to kill them. Session-identity is re-checked
 * before apply (pi-native /new mid-run re-imports extensions — the old closure
 * must not apply into a new session's tree).
 *
 * No-op for bots (PI_BOT_PERMISSION_POLICY) and subagents (PIBOT_SUBAGENT_DEPTH >= 1).
 *
 * Settings: "tournament": { enabled, auto: false, attempts: 2, maxAttempts: 4,
 *   attemptAgent: "architect-editor" | "worker", critics: null, maxMinutes: 90 }
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { appendCritiqueTelemetry, critiqueArtifact, type CritiqueTelemetryRow } from "./critic/index.js";
import { raceWithPhone } from "./shared/remote-ask.js";
import { discoverAgents } from "./subagent/agents.js";
import { getFinalOutput, runSingleAgent, type SingleResult, type SubagentDetails } from "./subagent/run.js";

interface TournamentConfig {
	enabled?: boolean;
	auto?: boolean;
	attempts?: number;
	maxAttempts?: number;
	attemptAgent?: "architect-editor" | "worker";
	critics?: string[] | null;
	maxMinutes?: number;
}

function loadConfig(): TournamentConfig {
	const p = resolve(homedir(), ".pi", "agent", "settings.json");
	if (!existsSync(p)) return {};
	try {
		return (JSON.parse(readFileSync(p, "utf8")) as { tournament?: TournamentConfig }).tournament ?? {};
	} catch {
		return {};
	}
}

function maxStepsPerLeg(): number {
	try {
		const raw = JSON.parse(readFileSync(resolve(homedir(), ".pi", "agent", "settings.json"), "utf8")) as {
			subagent?: { maxStepsPerLeg?: number };
		};
		const n = raw.subagent?.maxStepsPerLeg;
		return typeof n === "number" && n > 0 ? n : 24;
	} catch {
		return 24;
	}
}

const DIVERSITY = [
	"Prefer the minimal, most direct change that satisfies the task.",
	"Prefer the robust, thorough approach; handle edge cases and add or extend tests.",
	"Take a different design path than the most obvious one — consider a different location, abstraction, or mechanism.",
	"Keep the diff as small as possible while still being correct.",
];

interface Attempt {
	index: number;
	failed: boolean;
	note?: string;
	sha?: string;
	patch?: string;
	diffLines: number;
	passCount: number;
	blockers: number;
	warns: number;
	rows?: CritiqueTelemetryRow;
}

export default function (pi: ExtensionAPI) {
	if (process.env["PI_BOT_PERMISSION_POLICY"]) return;
	if (Number(process.env["PIBOT_SUBAGENT_DEPTH"] ?? "0") >= 1) return;

	let running = false;
	// plan-mode state, tracked via its state event; queried fresh with plan-mode:get
	let planState = { enabled: false, executing: false };
	pi.events.on("plan-mode:state", (d) => {
		const s = d as { enabled?: boolean; executing?: boolean };
		planState = { enabled: Boolean(s.enabled), executing: Boolean(s.executing) };
	});

	const toast = (message: string, type: "info" | "warning" | "error" = "info") =>
		pi.events.emit("command_result", { command: "tournament", message, type });

	const progress = (ctx: ExtensionCommandContext | null, msg: string) => {
		if (ctx?.hasUI) ctx.ui.notify(`[tournament] ${msg}`, "info");
		toast(msg);
	};

	// --- bus helpers (unset promise = refused) ---------------------------------

	function cpStatus(): {
		ok?: boolean;
		sessionId?: string;
		disabled?: boolean;
		suspended?: boolean;
		pathologicalCwd?: boolean;
	} {
		const q: Record<string, unknown> = {};
		pi.events.emit("pi-lab:checkpoint-status", q);
		return q;
	}

	async function cpSnapshot(label: string, internal: boolean): Promise<string> {
		const q: { label: string; internal: boolean; promise?: Promise<{ sha: string }> } = { label, internal };
		pi.events.emit("pi-lab:checkpoint-snapshot", q);
		if (!q.promise) throw new Error("checkpoint snapshot refused");
		return (await q.promise).sha;
	}

	async function cpRestore(sha: string): Promise<void> {
		const q: { sha: string; internal: boolean; promise?: Promise<{ safetySha: string }> } = { sha, internal: true };
		pi.events.emit("pi-lab:checkpoint-restore", q);
		if (!q.promise) throw new Error("checkpoint restore refused");
		await q.promise;
	}

	async function cpDiff(fromSha: string, toSha: string, binary: boolean) {
		const q: {
			fromSha: string;
			toSha: string;
			binary: boolean;
			promise?: Promise<{ patch: string; files: number; insertions: number; deletions: number; fileList: string[] }>;
		} = { fromSha, toSha, binary };
		pi.events.emit("pi-lab:checkpoint-diff", q);
		if (!q.promise) throw new Error("checkpoint diff refused");
		return q.promise;
	}

	async function cpApply(patch: string, threeWay: boolean): Promise<{ ok: boolean; stderr: string }> {
		const q: { patch: string; threeWay: boolean; promise?: Promise<{ ok: boolean; stderr: string }> } = {
			patch,
			threeWay,
		};
		pi.events.emit("pi-lab:checkpoint-apply", q);
		if (!q.promise) throw new Error("checkpoint apply refused");
		return q.promise;
	}

	// --- attempt runner -----------------------------------------------------------

	async function runAttempt(
		ctx: ExtensionCommandContext,
		index: number,
		task: string,
	): Promise<{ ok: boolean; note?: string }> {
		const cfg = loadConfig();
		const agents = discoverAgents(ctx.cwd, "user").agents;
		const makeDetails = (results: SingleResult[]): SubagentDetails => ({
			mode: "single",
			agentScope: "user",
			projectAgentsDir: null,
			results,
		});
		const diversity = DIVERSITY[(index - 1) % DIVERSITY.length];
		const budget = maxStepsPerLeg();

		if ((cfg.attemptAgent ?? "architect-editor") === "worker") {
			const r = await runSingleAgent(
				ctx.cwd, agents, "worker", `${task}\n\n${diversity}`, undefined, undefined,
				undefined, undefined, makeDetails, undefined, budget,
			);
			if (r.exitCode !== 0 || r.stopReason === "error" || r.budgetExceeded)
				return { ok: false, note: r.errorMessage || "worker failed" };
			return { ok: true };
		}

		// architect → editor pair (the default implementation path)
		const arch = await runSingleAgent(
			ctx.cwd, agents, "architect",
			`Design the code change for this task. ${diversity}\n\nTask: ${task}`,
			undefined, undefined, undefined, undefined, makeDetails, undefined, budget,
		);
		if (arch.exitCode !== 0 || arch.stopReason === "error" || arch.budgetExceeded)
			return { ok: false, note: arch.errorMessage || "architect failed" };
		const proposal = getFinalOutput(arch.messages);
		if (!proposal.trim()) return { ok: false, note: "architect produced no proposal" };
		const edit = await runSingleAgent(
			ctx.cwd, agents, "editor",
			`Apply this change proposal exactly:\n\n${proposal}`,
			undefined, undefined, undefined, undefined, makeDetails, undefined, budget,
		);
		if (edit.exitCode !== 0 || edit.stopReason === "error" || edit.budgetExceeded)
			return { ok: false, note: edit.errorMessage || "editor failed" };
		return { ok: true };
	}

	// --- the tournament -----------------------------------------------------------

	async function runTournament(ctx: ExtensionCommandContext, k: number, task: string): Promise<void> {
		const cfg = loadConfig();
		if (cfg.enabled === false) {
			ctx.ui.notify("[tournament] disabled (settings tournament.enabled)", "warning");
			return;
		}
		if (running) {
			ctx.ui.notify("[tournament] already running", "warning");
			return;
		}

		// guards
		const status = cpStatus();
		if (!status.ok || status.disabled || status.pathologicalCwd || status.suspended) {
			ctx.ui.notify("[tournament] checkpoints unavailable here (disabled/suspended/home cwd) — refusing", "warning");
			return;
		}
		pi.events.emit("plan-mode:get", {});
		if (planState.enabled || planState.executing) {
			ctx.ui.notify("[tournament] plan mode is active — finish or exit the plan first", "warning");
			return;
		}
		const handoffQ: { pending?: boolean } = {};
		pi.events.emit("pi-lab:handoff-status", handoffQ);
		if (handoffQ.pending) {
			ctx.ui.notify("[tournament] a handoff is in progress — try again after it", "warning");
			return;
		}
		const bg: { running?: string[] } = {};
		pi.events.emit("pi-lab:bg-list", bg);
		if ((bg.running ?? []).length > 0) {
			if (!ctx.hasUI) {
				toast("tournament refused: background tasks are running", "warning");
				return;
			}
			const kill =
				(await raceWithPhone(
					pi,
					{
						question: `Tournament: ${bg.running!.length} background task(s) would corrupt every attempt's diff. Kill them and continue?`,
						header: "Tournament",
						options: [
							{ label: "Kill and continue", description: "Stop the background tasks, run the tournament" },
							{ label: "Abort tournament", description: "Leave background tasks running" },
						],
					},
					async (signal) =>
						(await ctx.ui.confirm(
							"Background tasks are running",
							`${bg.running!.length} task(s) would corrupt every attempt's diff. Kill them and continue?`,
							{ signal },
						))
							? "Kill and continue"
							: "Abort tournament",
				)) === "Kill and continue";
			if (!kill) return;
			pi.events.emit("pi-lab:bg-kill-all", {});
		}
		await ctx.waitForIdle();

		const startSession = status.sessionId;
		const suspendQ: { reason: string; maxMinutes: number; ok?: boolean; token?: string } = {
			reason: "tournament",
			maxMinutes: cfg.maxMinutes ?? 90,
		};
		pi.events.emit("pi-lab:checkpoint-suspend", suspendQ);
		if (!suspendQ.ok || !suspendQ.token) {
			ctx.ui.notify("[tournament] could not suspend checkpointing — refusing", "warning");
			return;
		}
		running = true;
		const tournamentId = `t-${Date.now().toString(36)}`;
		progress(ctx, `starting: ${k} attempts — avoid prompting the session until it finishes`);

		try {
			const baseline = await cpSnapshot(`tournament baseline — ${task.slice(0, 60)}`, false);
			const attempts: Attempt[] = [];

			for (let i = 1; i <= k; i++) {
				progress(ctx, `attempt ${i}/${k} running (${loadConfig().attemptAgent ?? "architect-editor"})…`);
				const run = await runAttempt(ctx, i, task);
				if (!run.ok) {
					attempts.push({ index: i, failed: true, note: run.note, diffLines: 0, passCount: 0, blockers: 0, warns: 0 });
					await cpRestore(baseline);
					progress(ctx, `attempt ${i} failed (${run.note ?? "?"})`);
					continue;
				}
				const sha = await cpSnapshot(`tournament attempt ${i}`, true);
				if (sha === baseline) {
					attempts.push({ index: i, failed: true, note: "no changes", diffLines: 0, passCount: 0, blockers: 0, warns: 0 });
					progress(ctx, `attempt ${i} made no changes`);
					continue;
				}
				const { patch } = await cpDiff(baseline, sha, true);
				const textDiff = await cpDiff(baseline, sha, false);

				// score BEFORE restore: the oversized fallback tells critics to read
				// the live tree, which still holds this attempt's state.
				const maxBytes = 100_000;
				const oversized = Buffer.byteLength(textDiff.patch, "utf8") > maxBytes;
				const artifact = oversized
					? `The diff is too large to inline. Changed files:\n${textDiff.fileList.join("\n")}\n\nRead each of these files in the working tree and review the changes against the task. Do NOT run git commands.`
					: `Unified diff (tournament attempt ${i}):\n\n\`\`\`diff\n${textDiff.patch}\n\`\`\``;
				const outcome = await critiqueArtifact({
					cwd: ctx.cwd,
					artifact,
					specNote: `\n\nTask the change was meant to accomplish: ${task}`,
					source: "tournament",
					criticNames: cfg.critics ?? undefined,
					ref: `attempt-${i}`,
					changedFiles: textDiff.fileList,
					diffStats: {
						files: textDiff.files,
						insertions: textDiff.insertions,
						deletions: textDiff.deletions,
						bytes: Buffer.byteLength(textDiff.patch, "utf8"),
						oversized,
					},
				});
				await cpRestore(baseline);

				if ("missing" in outcome) {
					attempts.push({ index: i, failed: true, note: `missing critics: ${outcome.missing.join(",")}`, diffLines: 0, passCount: 0, blockers: 0, warns: 0 });
					continue;
				}
				const passCount = outcome.verdicts.filter((v) => v.verdict.passed).length;
				const blockers = outcome.row.verdicts.reduce((n, v) => n + v.blockers + (v.parseError ? 1 : 0), 0);
				const warns = outcome.row.verdicts.reduce((n, v) => n + v.warns, 0);
				outcome.row.tournamentId = tournamentId;
				attempts.push({
					index: i, failed: false, sha, patch,
					diffLines: textDiff.insertions + textDiff.deletions,
					passCount, blockers, warns, rows: outcome.row,
				});
				progress(ctx, `attempt ${i} scored: ${passCount}/${outcome.verdicts.length} critics pass, ${blockers} blocker(s)`);
			}

			const scored = attempts.filter((a) => !a.failed);
			if (scored.length === 0) {
				progress(ctx, "all attempts failed — baseline restored, nothing applied");
				summarize(attempts, null, task, tournamentId);
				return;
			}
			scored.sort(
				(a, b) =>
					b.passCount - a.passCount || a.blockers - b.blockers || a.warns - b.warns ||
					a.diffLines - b.diffLines || a.index - b.index,
			);
			const winner = scored[0];

			if (winner.passCount === 0 && ctx.hasUI) {
				pi.events.emit("pi-lab:attention", { reason: "tournament", detail: "no attempt passed critics" });
				const apply =
					(await raceWithPhone(
						pi,
						{
							question: `Tournament: no attempt passed critics. Apply the least-bad attempt anyway (#${winner.index}: ${winner.blockers} blockers, ${winner.warns} warns)? One /rewind undoes it.`,
							header: "Tournament",
							options: [
								{ label: "Apply anyway", description: "Take the least-bad diff; /rewind undoes it" },
								{ label: "Keep baseline", description: "Discard all attempts" },
							],
						},
						async (signal) =>
							(await ctx.ui.confirm(
								"Tournament: no attempt passed critics",
								`Apply the least-bad attempt (#${winner.index}: ${winner.blockers} blockers, ${winner.warns} warns) anyway? One /rewind undoes it.`,
								{ signal },
							))
								? "Apply anyway"
								: "Keep baseline",
					)) === "Apply anyway";
				if (!apply) {
					progress(ctx, "declined — baseline kept");
					summarize(attempts, null, task, tournamentId);
					return;
				}
			}

			// session-identity check: /new mid-tournament means a different shadow repo
			const now = cpStatus();
			if (now.sessionId !== startSession) {
				progress(ctx, "session changed mid-tournament — NOT applying (attempt shas remain ref-pinned in the old shadow repo)");
				summarize(attempts, null, task, tournamentId);
				return;
			}

			let applied = await cpApply(winner.patch!, false);
			if (!applied.ok) applied = await cpApply(winner.patch!, true);
			if (!applied.ok) {
				progress(ctx, `winner patch failed to apply (${applied.stderr.slice(0, 120)})`, );
				if (ctx.hasUI) {
					const hard =
						(await raceWithPhone(
							pi,
							{
								question: `Tournament: the winning patch failed to apply. Hard-reset the work tree to attempt #${winner.index}'s snapshot instead? (recoverable via refs/checkpoints)`,
								header: "Tournament",
								options: [
									{ label: "Reset to snapshot", description: "Work tree becomes the winning attempt; checkpoints restore" },
									{ label: "Keep current tree", description: "Leave everything as-is" },
								],
							},
							async (signal) =>
								(await ctx.ui.confirm(
									"Tournament: patch apply failed",
									`Reset the work tree to the winning attempt's snapshot instead? (attempt #${winner.index}, recoverable via refs/checkpoints)`,
									{ signal },
								))
									? "Reset to snapshot"
									: "Keep current tree",
						)) === "Reset to snapshot";
					if (hard) {
						const q: { sha: string; internal: boolean; promise?: Promise<{ safetySha: string }> } = { sha: winner.sha!, internal: true };
						pi.events.emit("pi-lab:checkpoint-restore", q);
						if (q.promise) await q.promise;
						applied = { ok: true, stderr: "" };
					}
				}
			}
			if (applied.ok) await cpSnapshot(`tournament winner applied (attempt ${winner.index})`, false);
			summarize(attempts, applied.ok ? winner : null, task, tournamentId);
		} catch (err) {
			progress(ctx, `error: ${(err as Error).message.slice(0, 160)} — attempting baseline restore`, );
			toast(`tournament error: ${(err as Error).message.slice(0, 160)}`, "error");
		} finally {
			running = false;
			pi.events.emit("pi-lab:checkpoint-resume", { token: suspendQ.token });
		}
	}

	function summarize(attempts: Attempt[], winner: Attempt | null, task: string, tournamentId: string): void {
		for (const a of attempts) {
			if (a.rows) {
				a.rows.pickedWinner = winner?.index === a.index;
				appendCritiqueTelemetry(a.rows);
			}
		}
		const lines = [
			winner
				? `**Tournament complete** — attempt #${winner.index} applied (${winner.passCount} critic pass${winner.passCount === 1 ? "" : "es"}, ${winner.blockers} blockers, ${winner.diffLines} diff lines)`
				: `**Tournament complete — nothing applied** (baseline kept)`,
			"",
			`Task: ${task.slice(0, 200)}`,
			...attempts.map((a) =>
				a.failed
					? `- attempt ${a.index}: failed (${a.note ?? "?"})`
					: `- attempt ${a.index}: ${a.passCount} pass, ${a.blockers} blockers, ${a.warns} warns, ${a.diffLines} lines${winner?.index === a.index ? "  ← winner" : ""}`,
			),
			"",
			winner && winner.passCount === 0 ? "⚠ NO attempt passed critics — least-bad applied; findings are in the critique messages above." : "",
			"Undo: /rewind to the tournament baseline.",
		].filter(Boolean);
		pi.sendMessage(
			{ customType: "tournament-result", content: lines.join("\n"), display: true, details: { tournamentId } },
			{ triggerTurn: false },
		);
	}

	// --- command + bridges ----------------------------------------------------------

	pi.registerCommand("tournament", {
		description: "Best-of-N attempts scored by critics: /tournament [k] <task>",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const m = (args ?? "").trim().match(/^(\d+)?\s*([\s\S]*)$/);
			const cfg = loadConfig();
			const k = Math.min(Math.max(Number(m?.[1]) || cfg.attempts || 2, 1), cfg.maxAttempts ?? 4);
			const task = (m?.[2] ?? "").trim();
			if (!task) {
				ctx.ui.notify("[tournament] usage: /tournament [k] <task>", "warning");
				return;
			}
			await runTournament(ctx, k, task);
		},
	});

	let lastCtx: ExtensionCommandContext | null = null;
	pi.on("session_start", (_e, ctx) => {
		lastCtx = ctx as unknown as ExtensionCommandContext;
	});
	pi.events.on("command:tournament", (data) => {
		if (!lastCtx) return;
		const args = (((data as { args?: string })?.args) ?? "").trim();
		const m = args.match(/^(\d+)?\s*([\s\S]*)$/);
		const cfg = loadConfig();
		const k = Math.min(Math.max(Number(m?.[1]) || cfg.attempts || 2, 1), cfg.maxAttempts ?? 4);
		const task = (m?.[2] ?? "").trim();
		if (!task) {
			toast("usage: /tournament [k] <task>", "warning");
			return;
		}
		void runTournament(lastCtx, k, task);
	});

	// Phase 3 auto-trigger (default OFF — flip criterion in docs/ROADMAP.md).
	// Single-shot: tournament-sourced verdicts never re-enter here.
	pi.events.on("pi-lab:critique-verdict", (payload: unknown) => {
		const p = payload as {
			source?: string;
			passed?: boolean;
			handled?: boolean;
			verdicts?: Array<{ agent: string; passed: boolean; firstBlocker?: string; parseError: string | null }>;
		};
		if (p.source !== "auto" || p.passed !== false) return;
		if (loadConfig().auto !== true || running || !lastCtx) return;
		p.handled = true; // critic skips its "send findings?" confirm
		const findings = (p.verdicts ?? [])
			.filter((v) => !v.passed)
			.map((v) => `- [${v.agent}] ${v.firstBlocker ?? v.parseError ?? "failed"}`)
			.join("\n");
		const task = `Address these independent critic findings on the current tree:\n${findings}`;
		toast("auto-critique failed — starting a fix tournament");
		void runTournament(lastCtx, loadConfig().attempts ?? 2, task);
	});
}
