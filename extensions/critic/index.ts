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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { discoverAgents } from "../subagent/agents.js";
import { getFinalOutput, runSingleAgent, type SingleResult, type SubagentDetails } from "../subagent/run.js";

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

	const runCritique = async (args: string, ctx: ExtensionCommandContext) => {
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

			const discovered = discoverAgents(ctx.cwd, "user").agents;
			const missing = criticNames.filter((n) => !discovered.some((a) => a.name === n));
			if (missing.length > 0) {
				ctx.ui.notify(`Missing critic agents: ${missing.join(", ")} (run scripts/install-bridges.sh)`, "error");
				return;
			}
			// Per-run model override: hand the runner cloned agent configs.
			// forceModel beats settings modelOverrides inside the runner.
			const agents = modelOverride
				? discovered.map((a) => (criticNames.includes(a.name) ? { ...a, forceModel: modelOverride } : a))
				: discovered;

			ctx.ui.notify(
				`Running ${criticNames.length} critics on the diff (${refNote})${modelOverride ? ` on ${modelOverride}` : ""}…`,
				"info",
			);
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
						ctx.cwd,
						agents,
						name,
						`${artifact}${specNote}${verdictReminder}`,
						undefined,
						undefined,
						undefined,
						undefined,
						makeDetails,
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

			const allPassed = verdicts.every((v) => v.verdict.passed);
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

			if (!allPassed && ctx.hasUI) {
				// The confirm renders in the terminal — ping remote watchers so a
				// phone user knows why the session went quiet.
				pi.events.emit("pi-lab:attention", { reason: "critique", detail: "critics found blocking issues — confirm in terminal or reply here" });
				const send = await ctx.ui.confirm(
					"Critics found blocking issues",
					"Send the findings to the agent to address?",
				);
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
	};

	// Auto-critique when a plan finishes executing (the long-local-flow case:
	// generation just ended, validation should start without being asked).
	pi.events.on("plan-mode:complete", () => {
		if (!lastCtx) return;
		if (loadConfig().auto === false) return;
		void runCritique("", lastCtx);
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
