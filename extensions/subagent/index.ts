/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { raceWithPhone } from "../shared/remote-ask.js";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import {
	getFinalOutput,
	mapWithConcurrencyLimit,
	type OnUpdateCallback,
	runSingleAgent,
	type SingleResult,
	type SubagentDetails,
} from "./run.js";
import { parseLegVerdict, parseNumberedList, stripVerdictBlocks, VERDICT_INSTRUCTION } from "./verdict.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

const SETTINGS_JSON = path.join(os.homedir(), ".pi", "agent", "settings.json");

/** settings.subagent.modelOverrides, fresh from disk. */
function readModelOverrides(): Record<string, string> {
	try {
		const raw = JSON.parse(fs.readFileSync(SETTINGS_JSON, "utf8")) as {
			subagent?: { modelOverrides?: Record<string, string> };
		};
		return raw.subagent?.modelOverrides ?? {};
	} catch {
		return {};
	}
}

/** Persist (or clear, with null) one agent's model override. Throws on I/O failure. */
function writeModelOverride(agentName: string, model: string | null): void {
	const raw = fs.existsSync(SETTINGS_JSON) ? (JSON.parse(fs.readFileSync(SETTINGS_JSON, "utf8")) as Record<string, any>) : {};
	raw.subagent = raw.subagent ?? {};
	raw.subagent.modelOverrides = raw.subagent.modelOverrides ?? {};
	if (agentName in raw.subagent.modelOverrides && model === null) delete raw.subagent.modelOverrides[agentName];
	else if (model !== null) raw.subagent.modelOverrides[agentName] = model;
	fs.writeFileSync(SETTINGS_JSON, JSON.stringify(raw, null, 2));
}

interface SubagentSettings {
	maxStepsPerLeg?: number;
	decomposeOnFailure?: boolean;
	decomposeMaxExtraLegs?: number;
}

function subagentSettings(): SubagentSettings {
	try {
		const raw = JSON.parse(
			fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "settings.json"), "utf8"),
		) as { subagent?: SubagentSettings };
		return raw.subagent ?? {};
	} catch {
		return {};
	}
}

/** settings.subagent.maxStepsPerLeg — per-leg turn budget (0/absent = unlimited). */
function maxStepsPerLeg(): number | undefined {
	const n = subagentSettings().maxStepsPerLeg;
	return typeof n === "number" && n > 0 ? n : 24; // generous default: abort-and-retry beats grinding
}

/** Best-effort decompose telemetry — answers "does decomposition rescue legs?" */
function logDecompose(row: Record<string, unknown>): void {
	try {
		const p = path.join(os.homedir(), ".pi", "agent", "decompose-log.jsonl");
		fs.appendFileSync(p, `${JSON.stringify({ ts: Date.now(), cwd: process.cwd(), ...row })}\n`);
		const lines = fs.readFileSync(p, "utf8").split("\n");
		if (lines.length > 2000) fs.writeFileSync(p, lines.slice(-1000).join("\n"));
	} catch {
		// telemetry must never break a chain
	}
}

/** Scrub failure evidence to a one-liner (models self-condition on error dumps). */
function scrubEvidence(s: string): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
}

/**
 * runSingleAgent + budget: a leg that exceeds the turn budget is killed and
 * retried ONCE with a fresh context and a one-line note (NOT the failed
 * transcript — models self-condition on their own past errors). Only the
 * subagent tool uses this wrapper; critics call runSingleAgent directly and
 * are never budget-killed.
 */
async function runLegWithBudget(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	toolsOverride?: string[],
): Promise<SingleResult> {
	const budget = maxStepsPerLeg();
	const first = await runSingleAgent(
		defaultCwd, agents, agentName, task, cwd, step, signal, onUpdate, makeDetails, toolsOverride, budget,
	);
	if (!first.budgetExceeded) return first;
	const retryTask =
		`Note: a previous attempt at this task was aborted after exceeding ${budget} turns. ` +
		`Start fresh, be direct, and prefer the shortest correct path.\n\n${task}`;
	const second = await runSingleAgent(
		defaultCwd, agents, agentName, retryTask, cwd, step, signal, onUpdate, makeDetails, toolsOverride, budget,
	);
	if (second.budgetExceeded) {
		second.errorMessage = `leg exceeded the ${budget}-turn budget twice (settings.subagent.maxStepsPerLeg)`;
		second.exitCode = second.exitCode || 1;
	}
	return second;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	toolsOverride: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Restrict every spawned agent to exactly these tools (overrides agent-file tools). Set automatically by plan-mode to keep children read-only.",
		}),
	),
});

export default function (pi: ExtensionAPI) {
	// Web bridge for agent model bindings (PWA "Execution models" card).
	// registerCommand handlers don't fire for web-dispatched commands, so the
	// phone drives these over the bus (sync-fill pattern, like classifier-set).
	pi.events.on("pi-lab:agent-models-get", (data) => {
		const d = (data ?? {}) as {
			cwd?: string;
			agents?: Array<{ name: string; model: string | null; override: boolean }>;
		};
		try {
			const overrides = readModelOverrides();
			const { agents } = discoverAgents(d.cwd ?? process.cwd(), "user");
			d.agents = agents.map((a) => ({
				name: a.name,
				model: overrides[a.name] ?? a.model ?? null,
				override: Boolean(overrides[a.name]),
			}));
		} catch {
			d.agents = [];
		}
	});
	pi.events.on("pi-lab:agent-models-set", (data) => {
		const d = (data ?? {}) as { cwd?: string; agent?: string; model?: string | null; ok?: boolean; error?: string };
		try {
			const { agents } = discoverAgents(d.cwd ?? process.cwd(), "user");
			if (!d.agent || !agents.some((a) => a.name === d.agent)) {
				d.error = `unknown agent: ${d.agent}`;
				return;
			}
			writeModelOverride(d.agent, d.model ?? null);
			d.ok = true;
		} catch (err) {
			d.error = String((err as Error).message ?? err);
		}
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					// Mid-run prompt — race the terminal confirm with a phone card
					// so a remote session doesn't block invisibly. Fail-closed.
					const picked = await raceWithPhone(
						pi,
						{
							question: `Run project-local agents (${names}) from ${dir}? Project agents are repo-controlled — only approve for trusted repositories.`,
							header: "Agents",
							options: [
								{ label: "Run them", description: "Trust this repository's agent definitions" },
								{ label: "Cancel", description: "Refuse repo-controlled agents" },
							],
						},
						async (signal) =>
							(await ctx.ui.confirm(
								"Run project-local agents?",
								`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
								{ signal },
							))
								? "Run them"
								: "Cancel",
					);
					const ok = picked === "Run them";
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";
				const cfg = subagentSettings();
				const decomposeOn = cfg.decomposeOnFailure !== false;
				const maxExtraLegs = typeof cfg.decomposeMaxExtraLegs === "number" ? cfg.decomposeMaxExtraLegs : 6;
				let extraLegsUsed = 0;

				// Concatenate ALL text parts of the final assistant message — a verdict
				// in a second text part must not vanish into fail-open (review fix).
				const fullFinalText = (r: SingleResult): string => {
					for (let m = r.messages.length - 1; m >= 0; m--) {
						const msg = r.messages[m] as { role?: string; content?: Array<{ type?: string; text?: string }> };
						if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
						const text = msg.content
							.filter((p) => p?.type === "text" && typeof p.text === "string")
							.map((p) => p.text)
							.join("\n");
						if (text.trim()) return text;
					}
					return "";
				};

				const chainError = (stepNo: number, agentName: string, r: SingleResult) => {
					const errorMsg = r.errorMessage || r.stderr || getFinalOutput(r.messages) || "(no output)";
					return {
						content: [{ type: "text" as const, text: `Chain stopped at step ${stepNo} (${agentName}): ${errorMsg}` }],
						details: makeDetails("chain")(results),
						isError: true,
					};
				};

				const legFailed = (r: SingleResult): { failed: boolean; hard: boolean; reason: string } => {
					const hard = r.exitCode !== 0 || r.stopReason === "error";
					if (hard) return { failed: true, hard: true, reason: r.errorMessage || r.stderr || "hard error" };
					if (!decomposeOn) return { failed: false, hard: false, reason: "" };
					const v = parseLegVerdict(fullFinalText(r));
					if (v.found && !v.ok) return { failed: true, hard: false, reason: v.reason ?? "verdict: not ok" };
					return { failed: false, hard: false, reason: "" };
				};

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					let taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
					if (decomposeOn) taskWithContext += VERDICT_INSTRUCTION;

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runLegWithBudget(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						params.toolsOverride,
					);
					results.push(result);

					const aborted = result.stopReason === "aborted";
					const configError = (result.stderr || "").startsWith("Unknown agent");
					const fail = legFailed(result);

					if (!fail.failed && !aborted) {
						previousOutput = stripVerdictBlocks(getFinalOutput(result.messages));
						continue;
					}

					// ---- decompose gate (chains only; one structural recursion level) ----
					if (aborted || !decomposeOn || configError || extraLegsUsed + 2 > maxExtraLegs) {
						logDecompose({
							step: i + 1,
							agent: step.agent,
							trigger: fail.hard ? "exit" : "verdict",
							reason: scrubEvidence(fail.reason),
							outcome: aborted ? "aborted" : !decomposeOn ? "disabled" : configError ? "config-error" : "cap-reached",
						});
						return chainError(i + 1, step.agent, result);
					}

					const evidence = scrubEvidence(fail.reason || fullFinalText(result));
					const splitPrompt =
						`A chain step failed and must be split. Failed step (agent: ${step.agent}):\n` +
						`${taskWithContext.slice(0, 4000)}\n\nFailure evidence: ${evidence}\n\n` +
						`Split it into 2-4 smaller sub-steps that together accomplish the original step; ` +
						`each must be independently executable by the same agent in a few tool calls. ` +
						`Output ONLY a numbered list (1. ... 4.), one sub-step per line, no preamble.`;
					// splitter + sub-legs: runSingleAgent with the budget directly, NO retry —
					// decompose IS the retry. toolsOverride propagates (plan-mode read-only).
					const split = await runSingleAgent(
						ctx.cwd, agents, "splitter", splitPrompt, step.cwd, i + 1, signal,
						chainUpdate, makeDetails("chain"), params.toolsOverride, maxStepsPerLeg(),
					);
					// fullFinalText, not getFinalOutput: the list may live in a later
					// text part of the final message (same multi-part trap as verdicts).
					const subTasks = parseNumberedList(fullFinalText(split)).slice(
						0,
						Math.min(4, maxExtraLegs - extraLegsUsed),
					);
					if (split.exitCode !== 0 || split.stopReason === "error" || subTasks.length < 2) {
						logDecompose({
							step: i + 1, agent: step.agent, trigger: fail.hard ? "exit" : "verdict",
							reason: evidence, outcome: "split-unparseable",
						});
						return chainError(i + 1, step.agent, result);
					}

					result.decomposed = true;
					let subPrev = previousOutput; // sub-step 1 sees the ORIGINAL {previous}
					let rescued = true;
					for (let k = 0; k < subTasks.length; k++) {
						let subTask =
							`${subTasks[k]}\n\nOriginal goal (this is one part of it): ${step.task.slice(0, 500)}` +
							(subPrev ? `\n\nContext from earlier work:\n${subPrev}` : "");
						if (decomposeOn) subTask += VERDICT_INSTRUCTION;
						const r = await runSingleAgent(
							ctx.cwd, agents, step.agent, subTask, step.cwd, i + 1, signal,
							chainUpdate, makeDetails("chain"), params.toolsOverride, maxStepsPerLeg(),
						);
						r.stepLabel = `${i + 1}.${k + 1}`;
						results.push(r);
						extraLegsUsed++;
						const subFail = legFailed(r);
						if (subFail.failed || r.stopReason === "aborted" || r.budgetExceeded) {
							logDecompose({
								step: i + 1, agent: step.agent, trigger: fail.hard ? "exit" : "verdict",
								reason: evidence, subStepCount: subTasks.length, outcome: "sub-step-failed",
							});
							rescued = false;
							return chainError(i + 1, step.agent, r);
						}
						subPrev = stripVerdictBlocks(getFinalOutput(r.messages));
					}
					if (rescued) {
						logDecompose({
							step: i + 1, agent: step.agent, trigger: fail.hard ? "exit" : "verdict",
							reason: evidence, subStepCount: subTasks.length, outcome: "rescued",
						});
						previousOutput = subPrev; // step N+1 sees the LAST sub-step's output
					}
				}
				return {
					content: [
						{
							type: "text",
							text: stripVerdictBlocks(getFinalOutput(results[results.length - 1].messages)) || "(no output)",
						},
					],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runLegWithBudget(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						params.toolsOverride,
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => r.exitCode === 0).length;
				const summaries = results.map((r) => {
					const output = getFinalOutput(r.messages);
					const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
					return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runLegWithBudget(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					params.toolsOverride,
				);
				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (isError) {
					const errorMsg =
						result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.stepLabel ?? r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}${r.decomposed ? theme.fg("warning", " → split into sub-steps") : ""}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.stepLabel ?? r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}${r.decomposed ? theme.fg("warning", " → split into sub-steps") : ""}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	// /agent-models — interactively re-bind any agent's model. Persists to
	// settings.json → subagent.modelOverrides, which run.ts re-reads on every
	// spawn, so re-binds apply live (frontmatter model: stays the default).
	pi.registerCommand("agent-models", {
		description: "List and re-bind subagent role → model bindings",
		handler: async (_args, ctx: ExtensionContext) => {
			if (!ctx.hasUI) return;

			const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
			const readOverrides = (): Record<string, string> => {
				try {
					const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
						subagent?: { modelOverrides?: Record<string, string> };
					};
					return raw.subagent?.modelOverrides ?? {};
				} catch {
					return {};
				}
			};
			const writeOverride = (agentName: string, model: string | null): void => {
				try {
					const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, any>;
					raw.subagent = raw.subagent ?? {};
					raw.subagent.modelOverrides = raw.subagent.modelOverrides ?? {};
					if (model === null) delete raw.subagent.modelOverrides[agentName];
					else raw.subagent.modelOverrides[agentName] = model;
					fs.writeFileSync(settingsPath, JSON.stringify(raw, null, 2));
				} catch (err) {
					ctx.ui.notify(`Failed to write settings.json: ${String(err)}`, "error");
				}
			};

			const { agents } = discoverAgents(ctx.cwd, "user");
			if (agents.length === 0) {
				ctx.ui.notify("No user-scope agents found (run scripts/install-bridges.sh?)", "warning");
				return;
			}

			while (true) {
				const overrides = readOverrides();
				const rows = agents.map((a) => {
					const bound = overrides[a.name] ?? a.model ?? "(inherit session model)";
					const marker = overrides[a.name] ? " *" : "";
					return `${a.name} → ${bound}${marker}`;
				});
				const choice = await ctx.ui.select("Re-bind which agent's model? (* = settings override)", [
					...rows,
					"Done",
				]);
				if (!choice || choice === "Done") return;

				const agentName = choice.split(" → ")[0];
				const models = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
				const current = overrides[agentName];
				const options = [
					...(current ? [`Clear override (back to agent-file default)`] : []),
					...models,
				];
				const picked = await ctx.ui.select(`Model for ${agentName}:`, options);
				if (!picked) continue;
				if (picked.startsWith("Clear override")) {
					writeOverride(agentName, null);
					ctx.ui.notify(`${agentName}: override cleared`);
				} else {
					writeOverride(agentName, picked);
					ctx.ui.notify(`${agentName} → ${picked}`);
				}
			}
		},
	});
}
