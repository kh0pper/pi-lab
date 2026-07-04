/**
 * critic — independent fresh-context critics for the working diff (tenet port).
 *
 * /critique [base-ref] [frontier | provider/model-id]
 *   Runs the configured critic agents (default code-critic + test-critic) in
 *   parallel, each in its own spawned pi process with NO access to this
 *   session's conversation — they judge the artifact, not the author's
 *   reasoning (tenet's core insight: same-author tests have ~6% precision;
 *   generation and validation need separate contexts).
 *   Critics run on their bound models (LOCAL by default — cloud is for
 *   planning). Add "frontier" to run this review on critic.frontierModel
 *   (default zai-coding/glm-5.1), or pass any provider/id explicitly.
 *
 * /critique auto on|off
 *   Toggle automatic critique when a plan finishes executing (plan-mode
 *   emits "plan-mode:complete"). Default ON — the point of long local
 *   agentic flows is that validation happens without you asking.
 *
 * Each critic must end its reply with a fenced JSON verdict:
 *   {"passed": bool, "findings": [{"category", "severity", "detail"}]}
 * Unparseable output counts as FAILED (fail-closed, all-blocking aggregate).
 *
 * Config (~/.pi/agent/settings.json):
 *   "critic": {
 *     "enabled": true,
 *     "agents": ["code-critic", "test-critic"],
 *     "baseRef": "HEAD",
 *     "maxDiffBytes": 100000
 *   }
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { raceWithPhone } from "../shared/remote-ask.js";
import { discoverAgents } from "../subagent/agents.js";
import { getFinalOutput, runSingleAgent, type SingleResult, type SubagentDetails } from "../subagent/run.js";

const TELEMETRY_PATH = resolve(homedir(), ".pi", "agent", "critic-telemetry.jsonl");

interface CriticConfig {
	enabled?: boolean;
	agents?: string[];
	baseRef?: string;
	maxDiffBytes?: number;
	/** Auto-run when a plan finishes executing (default true). */
	auto?: boolean;
	/** Model used when invoked as "/critique frontier". */
	frontierModel?: string;
}

function writeCriticConfig(patch: Partial<CriticConfig>): void {
	const settingsPath = resolve(homedir(), ".pi", "agent", "settings.json");
	try {
		const raw = existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, any>) : {};
		raw.critic = { ...(raw.critic ?? {}), ...patch };
		writeFileSync(settingsPath, JSON.stringify(raw, null, 2));
	} catch {
		// best-effort
	}
}

interface Verdict {
	passed: boolean;
	findings: Array<{ category?: string; severity?: string; detail?: string }>;
	parseError?: string;
}

function loadConfig(): CriticConfig {
	const settingsPath = resolve(homedir(), ".pi", "agent", "settings.json");
	if (!existsSync(settingsPath)) return {};
	try {
		const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as { critic?: CriticConfig };
		return raw.critic ?? {};
	} catch {
		return {};
	}
}

/** Parse the LAST verdict JSON in a critic's final message. Fail closed. */
export function parseVerdict(output: string): Verdict {
	const accept = (raw: string): Verdict | null => {
		try {
			const parsed = JSON.parse(raw) as { passed?: unknown; findings?: unknown };
			if (typeof parsed.passed === "boolean") {
				return {
					passed: parsed.passed,
					findings: Array.isArray(parsed.findings) ? (parsed.findings as Verdict["findings"]) : [],
				};
			}
		} catch {
			// not this candidate
		}
		return null;
	};

	// Preferred: fenced ```json blocks, last first.
	const blocks = [...output.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)];
	for (let i = blocks.length - 1; i >= 0; i--) {
		const v = accept(blocks[i][1].trim());
		if (v) return v;
	}

	// Fallback: models sometimes emit the object unfenced. Balanced-brace scan
	// starting at the last `{` that precedes a "passed" key.
	for (let at = output.lastIndexOf('"passed"'); at !== -1; at = output.lastIndexOf('"passed"', at - 1)) {
		const start = output.lastIndexOf("{", at);
		if (start === -1) continue;
		let depth = 0;
		for (let i = start; i < output.length; i++) {
			if (output[i] === "{") depth++;
			else if (output[i] === "}") {
				depth--;
				if (depth === 0) {
					const v = accept(output.slice(start, i + 1));
					if (v) return v;
					break;
				}
			}
		}
	}

	return { passed: false, findings: [], parseError: "no parseable verdict JSON in critic output" };
}

// ---------------------------------------------------------------------------
// Telemetry (D5 Phase 0) — feeds the tournament.auto flip decision.
// Rows are self-contained; analysis is offline (jq). Best-effort: telemetry
// must never break a critique. File capped at append time (~2000 → last 1000).
// ---------------------------------------------------------------------------

export interface CritiqueTelemetryRow {
	v: 1;
	ts: number;
	cwd: string;
	source: "manual" | "auto" | "tournament";
	ref: string;
	modelOverride: string | null;
	diff: { files: number; insertions: number; deletions: number; bytes: number; oversized: boolean } | null;
	verdicts: Array<{
		agent: string;
		passed: boolean;
		blockers: number;
		warns: number;
		parseError: string | null;
		firstBlocker?: string;
	}>;
	agree: boolean;
	userSentFindings: boolean | null;
	prior: { ts: number; passed: boolean; filesOverlap: number } | null;
	changedFiles?: string[];
	tournamentId?: string;
	pickedWinner?: boolean;
}

/** Find the most recent same-cwd row within 4h for outcome linkage. */
function findPrior(cwd: string, changedFiles: string[]): CritiqueTelemetryRow["prior"] {
	try {
		const lines = readFileSync(TELEMETRY_PATH, "utf8").trim().split("\n");
		for (let i = lines.length - 1; i >= 0 && i >= lines.length - 200; i--) {
			const row = JSON.parse(lines[i]) as CritiqueTelemetryRow;
			if (row.cwd !== cwd) continue;
			if (Date.now() - row.ts > 4 * 3600_000) break;
			const overlap = (row.changedFiles ?? []).filter((f) => changedFiles.includes(f)).length;
			return { ts: row.ts, passed: row.verdicts.every((x) => x.passed), filesOverlap: overlap };
		}
	} catch {
		// no file / malformed tail — no prior
	}
	return null;
}

export function appendCritiqueTelemetry(row: CritiqueTelemetryRow): void {
	try {
		appendFileSync(TELEMETRY_PATH, `${JSON.stringify(row)}\n`);
		const lines = readFileSync(TELEMETRY_PATH, "utf8").split("\n");
		if (lines.length > 2000) writeFileSync(TELEMETRY_PATH, lines.slice(-1000).join("\n"));
	} catch {
		// best-effort
	}
}

// ---------------------------------------------------------------------------
// critiqueArtifact — the reusable scoring entry point (D5). Spawns the critic
// agents on an ARBITRARY artifact (e.g. the tournament's shadow-repo diff) and
// returns verdicts + a prepared telemetry row (caller decides when to append:
// runCritique fills userSentFindings after its confirm; the tournament appends
// immediately with its own fields).
// ---------------------------------------------------------------------------

export interface CritiqueArtifactParams {
	cwd: string;
	/** Full artifact text handed to each critic (diff, or file list + instructions). */
	artifact: string;
	specNote?: string;
	source: "manual" | "auto" | "tournament";
	criticNames?: string[];
	modelOverride?: string;
	/** Telemetry fields */
	ref?: string;
	changedFiles?: string[];
	diffStats?: CritiqueTelemetryRow["diff"];
}

export interface CritiqueOutcome {
	allPassed: boolean;
	verdicts: Array<{ agent: string; verdict: Verdict; raw: string }>;
	row: CritiqueTelemetryRow;
}

export async function critiqueArtifact(p: CritiqueArtifactParams): Promise<CritiqueOutcome | { missing: string[] }> {
	const cfg = loadConfig();
	const criticNames = p.criticNames ?? cfg.agents ?? ["code-critic", "test-critic"];
	const discovered = discoverAgents(p.cwd, "user").agents;
	const missing = criticNames.filter((n) => !discovered.some((a) => a.name === n));
	if (missing.length > 0) return { missing };
	const agents = p.modelOverride
		? discovered.map((a) => (criticNames.includes(a.name) ? { ...a, forceModel: p.modelOverride } : a))
		: discovered;

	const makeDetails = (results: SingleResult[]): SubagentDetails => ({
		mode: "parallel",
		agentScope: "user",
		projectAgentsDir: null,
		results,
	});
	const verdictReminder =
		"\n\nIMPORTANT: After completing your analysis, END your reply with the fenced verdict JSON block described in your instructions. The verdict block must be the LAST thing in your final message — write nothing after it. A missing verdict counts as a failed review.";

	const results = await Promise.all(
		criticNames.map((name) =>
			runSingleAgent(
				p.cwd, agents, name, `${p.artifact}${p.specNote ?? ""}${verdictReminder}`,
				undefined, undefined, undefined, undefined, makeDetails,
			),
		),
	);
	const verdicts = results.map((r) => {
		if (r.exitCode !== 0 || r.stopReason === "error") {
			return {
				agent: r.agent,
				verdict: {
					passed: false,
					findings: [],
					parseError: r.errorMessage || r.stderr.slice(0, 200) || "critic process failed",
				} as Verdict,
				raw: getFinalOutput(r.messages),
			};
		}
		return { agent: r.agent, verdict: parseVerdict(getFinalOutput(r.messages)), raw: getFinalOutput(r.messages) };
	});

	const parsed = verdicts.filter((v) => !v.verdict.parseError);
	const row: CritiqueTelemetryRow = {
		v: 1,
		ts: Date.now(),
		cwd: p.cwd,
		source: p.source,
		ref: p.ref ?? "(artifact)",
		modelOverride: p.modelOverride ?? null,
		diff: p.diffStats ?? null,
		verdicts: verdicts.map((v) => {
			const blockers = v.verdict.findings.filter((f) => f.severity === "blocker");
			return {
				agent: v.agent,
				passed: v.verdict.passed,
				blockers: blockers.length,
				warns: v.verdict.findings.length - blockers.length,
				parseError: v.verdict.parseError ?? null,
				firstBlocker: blockers[0]?.detail?.slice(0, 200),
			};
		}),
		agree: parsed.length < 2 || parsed.every((v) => v.verdict.passed === parsed[0].verdict.passed),
		userSentFindings: null,
		prior: findPrior(p.cwd, p.changedFiles ?? []),
		changedFiles: p.changedFiles,
	};
	return { allPassed: verdicts.every((v) => v.verdict.passed), verdicts, row };
}

export default function (pi: ExtensionAPI) {
	// Bridge web-dispatched invocations ("command:critique" bus events) — they
	// bypass registerCommand, so capture a ctx and route them to the same logic.
	let lastCtx: ExtensionCommandContext | null = null;
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx as unknown as ExtensionCommandContext;
	});
	pi.events.on("command:critique", (data) => {
		if (!lastCtx) return;
		void runCritique((((data as { args?: string })?.args) ?? "").trim(), lastCtx);
	});

	const runCritique = async (args: string, ctx: ExtensionCommandContext, source: "manual" | "auto" = "manual") => {
			const cfg = loadConfig();
			if (cfg.enabled === false) {
				ctx.ui.notify("Critic is disabled (settings.json critic.enabled)", "warning");
				return;
			}
			const criticNames = cfg.agents ?? ["code-critic", "test-critic"];
			const maxDiffBytes = cfg.maxDiffBytes ?? 100_000;

			// Parse args: "frontier" (or any token that resolves in the model
			// registry as provider/id) overrides the critic model for THIS run;
			// everything else is the base ref. Registry validation keeps git
			// refs containing "/" (origin/main, feature/x) unambiguous.
			let modelOverride: string | undefined;
			const refTokens: string[] = [];
			for (const tok of (args ?? "").trim().split(/\s+/).filter(Boolean)) {
				if (tok === "frontier") {
					modelOverride = cfg.frontierModel ?? "zai-coding/glm-5.1";
					continue;
				}
				const slash = tok.indexOf("/");
				if (slash > 0 && !modelOverride) {
					try {
						if (ctx.modelRegistry.find(tok.slice(0, slash), tok.slice(slash + 1))) {
							modelOverride = tok;
							continue;
						}
					} catch {
						// not a model — treat as ref
					}
				}
				refTokens.push(tok);
			}
			let ref = refTokens.join(" ") || cfg.baseRef || "HEAD";

			// Collect the diff (uncommitted vs ref; fall back to last commit when clean).
			let diff = (await pi.exec("git", ["diff", ref], { cwd: ctx.cwd })).stdout;
			let refNote = `vs ${ref}`;
			if (!diff.trim() && ref === "HEAD") {
				ref = "HEAD~1";
				diff = (await pi.exec("git", ["diff", "HEAD~1"], { cwd: ctx.cwd })).stdout;
				refNote = "working tree clean — reviewing last commit (HEAD~1)";
			}
			if (!diff.trim()) {
				ctx.ui.notify("Nothing to critique (empty diff)", "info");
				return;
			}

			const changedFiles = (await pi.exec("git", ["diff", "--name-only", ref], { cwd: ctx.cwd })).stdout.trim();

			// Optional spec: newest plan artifact if the repo has one (B3 writes these).
			let specNote = "";
			const plansDir = resolve(ctx.cwd, ".pi", "plans");
			if (existsSync(plansDir)) {
				const newest = (await pi.exec("bash", ["-lc", `ls -t '${plansDir}'/*.md 2>/dev/null | head -1`], { cwd: ctx.cwd })).stdout.trim();
				if (newest) specNote = `\n\nSpec/plan document (read it and judge conformance): ${newest}`;
			}

			const oversized = Buffer.byteLength(diff, "utf8") > maxDiffBytes;
			const artifact = oversized
				? `The diff is too large to inline (> ${maxDiffBytes} bytes). Changed files (${refNote}):\n${changedFiles}\n\nRun \`git diff ${ref} -- <file>\` yourself per file and review every change.`
				: `Unified diff (${refNote}):\n\n\`\`\`diff\n${diff}\n\`\`\``;

			ctx.ui.notify(
				`Running ${criticNames.length} critics on the diff (${refNote})${modelOverride ? ` on ${modelOverride}` : ""}…`,
				"info",
			);

			// diff stats for telemetry (cheap numstat alongside the existing calls)
			let diffStats: CritiqueTelemetryRow["diff"] = null;
			try {
				const numstat = (await pi.exec("git", ["diff", "--numstat", ref], { cwd: ctx.cwd })).stdout.trim();
				let ins = 0;
				let del = 0;
				const rows = numstat ? numstat.split("\n") : [];
				for (const line of rows) {
					const [a, b] = line.split("\t");
					ins += Number(a) || 0;
					del += Number(b) || 0;
				}
				diffStats = { files: rows.length, insertions: ins, deletions: del, bytes: Buffer.byteLength(diff, "utf8"), oversized };
			} catch {
				// stats optional
			}

			const outcome = await critiqueArtifact({
				cwd: ctx.cwd,
				artifact,
				specNote,
				source,
				criticNames,
				modelOverride,
				ref,
				changedFiles: changedFiles ? changedFiles.split("\n").filter(Boolean) : [],
				diffStats,
			});
			if ("missing" in outcome) {
				ctx.ui.notify(`Missing critic agents: ${outcome.missing.join(", ")} (run scripts/install-bridges.sh)`, "error");
				return;
			}
			const { allPassed, verdicts, row } = outcome;
			const lines: string[] = [`**Critique ${allPassed ? "PASSED ✓" : "FAILED ✗"}** (${refNote})`, ""];
			for (const v of verdicts) {
				const icon = v.verdict.passed ? "✓" : "✗";
				lines.push(`${icon} **${v.agent}**${v.verdict.parseError ? ` — ${v.verdict.parseError} (fail-closed)` : ""}`);
				for (const f of v.verdict.findings) {
					lines.push(`  - [${f.severity ?? "?"}/${f.category ?? "?"}] ${f.detail ?? ""}`);
				}
				if (v.verdict.findings.length === 0 && !v.verdict.parseError) lines.push("  - no findings");
			}
			pi.sendMessage(
				{ customType: "critic-verdict", content: lines.join("\n"), display: true, details: { verdicts } },
				{ triggerTurn: false },
			);

			// D5: let listeners (the tournament auto-trigger) claim a failed
			// auto-critique before the interactive confirm fires.
			const busPayload = {
				source,
				ref,
				passed: allPassed,
				verdicts: row.verdicts,
				changedFiles: row.changedFiles ?? [],
				handled: false,
			};
			pi.events.emit("pi-lab:critique-verdict", busPayload);

			if (!allPassed && ctx.hasUI && !busPayload.handled) {
				// Terminal confirm races a phone-answerable card (ask_user bus) —
				// auto-critique fires unattended after plan execution, so this
				// prompt is MOST often hit with nobody at the terminal.
				pi.events.emit("pi-lab:attention", { reason: "critique", detail: "critics found blocking issues" });
				const picked = await raceWithPhone(
					pi,
					{
						question: "Critics found blocking issues in the diff — send the findings to the agent to address?",
						header: "Critique",
						options: [
							{ label: "Send findings", description: "The agent gets the blockers and fixes them" },
							{ label: "Ignore", description: "Leave the diff as-is" },
						],
					},
					async (signal) =>
						(await ctx.ui.confirm("Critics found blocking issues", "Send the findings to the agent to address?", { signal }))
							? "Send findings"
							: "Ignore",
				);
				const send = picked === "Send findings";
				row.userSentFindings = send;
				if (send) {
					const findingsText = verdicts
						.filter((v) => !v.verdict.passed)
						.map(
							(v) =>
								`${v.agent}:\n${v.verdict.findings.map((f) => `- [${f.severity}/${f.category}] ${f.detail}`).join("\n") || v.verdict.parseError}`,
						)
						.join("\n\n");
					pi.sendUserMessage(
						`Independent critics reviewed the current diff and found blocking issues. Address each one (or explain why it's wrong):\n\n${findingsText}`,
					);
				}
			}
			// Append AFTER the confirm (userSentFindings is the human label);
			// passed / no-UI / handled paths append with null immediately.
			appendCritiqueTelemetry(row);
	};

	// Auto-critique when a plan finishes executing (the long-local-flow case:
	// generation just ended, validation should start without being asked).
	pi.events.on("plan-mode:complete", () => {
		if (!lastCtx) return;
		if (loadConfig().auto === false) return;
		void runCritique("", lastCtx, "auto");
	});

	pi.registerCommand("critique", {
		description: "Independent critics on the diff: /critique [base-ref] [frontier|provider/id] · /critique auto on|off",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const trimmed = (args ?? "").trim();
			if (trimmed === "auto on" || trimmed === "auto off") {
				writeCriticConfig({ auto: trimmed.endsWith("on") });
				ctx.ui.notify(`Auto-critique after plan execution: ${trimmed.endsWith("on") ? "ON" : "OFF"}`);
				return;
			}
			if (trimmed === "auto") {
				ctx.ui.notify(`Auto-critique is ${loadConfig().auto === false ? "OFF" : "ON"} (toggle: /critique auto on|off)`);
				return;
			}
			return runCritique(trimmed, ctx);
		},
	});
}
