/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, only read-only tools are available.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to complete steps during execution
 * - Progress tracking widget during execution
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils.js";

// Tools. write/edit are present but path-gated to the design scratch space
// (.pi/scratch/) by the tool_call handler below — plan mode protects PROJECT
// files; mockups/diagrams/notes are design artifacts, not code changes.
// send_user_file lets those artifacts reach the phone chat (read-only w.r.t.
// the repo — it only registers an existing file for download).
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "ask_user", "subagent", "write", "edit", "send_user_file"];
// Design OUTPUT areas writable in plan mode (override: settings planMode.writableDirs).
// Mockups, specs, and plans are what the design phase produces — code stays read-only.
const DEFAULT_WRITABLE_DIRS = [".pi/scratch", ".pi/plans", "docs"];
// Fallback restore set, used only when no tool snapshot exists (e.g. --plan at startup).
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
// Tools forced onto subagent children spawned from plan mode (scout declares bash;
// a child pi has no plan-mode state, so read-only must be enforced via --tools).
const READ_ONLY_CHILD_TOOLS = ["read", "grep", "find", "ls"];

interface PlanModeConfig {
	planModel?: string;
	execModel?: string;
	lastPlanModel?: string;
	lastExecModel?: string;
	readOnlyAgents?: string[];
	/** Persist accepted plans to <repo>/.pi/plans/ (default true). */
	persistPlans?: boolean;
	/** Dirs (relative to cwd) where write/edit are allowed in plan mode. */
	writableDirs?: string[];
}

const SETTINGS_PATH = resolve(homedir(), ".pi", "agent", "settings.json");

function readPlanConfig(): PlanModeConfig {
	if (!existsSync(SETTINGS_PATH)) return {};
	try {
		const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as { planMode?: PlanModeConfig };
		return raw.planMode ?? {};
	} catch {
		return {};
	}
}

function writePlanConfig(patch: Partial<PlanModeConfig>): void {
	try {
		const raw = existsSync(SETTINGS_PATH)
			? (JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, any>)
			: {};
		raw.planMode = { ...(raw.planMode ?? {}), ...patch };
		writeFileSync(SETTINGS_PATH, JSON.stringify(raw, null, 2));
	} catch {
		// settings persistence is best-effort; never break the session over it
	}
}

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	// Tool set snapshotted on plan-mode entry, restored on exit — hardcoding the
	// restore set would drop subagent/todo/MCP tools for the rest of the session.
	let savedTools: string[] | null = null;
	// "provider/id" of the model active before plan mode switched it; null = nothing to restore.
	let modelSnapshot: string | null = null;

	function modelRef(ctx: ExtensionContext): string | null {
		const m = ctx.model;
		return m ? `${m.provider}/${m.id}` : null;
	}

	/** Resolve "provider/id" via the registry and switch. Returns true on success. */
	async function applyModel(ctx: ExtensionContext, ref: string): Promise<boolean> {
		const slash = ref.indexOf("/");
		if (slash <= 0) return false;
		const model = ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
		if (!model) {
			if (ctx.hasUI) ctx.ui.notify(`Model not found: ${ref} — keeping current model`, "warning");
			return false;
		}
		const ok = await pi.setModel(model);
		if (!ok && ctx.hasUI) ctx.ui.notify(`Could not switch to ${ref} (no API key?) — keeping current model`, "warning");
		return ok;
	}

	/**
	 * Pick a model interactively. Returns "provider/id", or null for "keep current".
	 * lastUsed (if still available) is listed first so confirming it is one keystroke.
	 */
	async function pickModel(ctx: ExtensionContext, title: string, lastUsed?: string): Promise<string | null> {
		const available = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
		if (available.length === 0) return null;
		const current = modelRef(ctx);
		const ordered = [
			...(lastUsed && available.includes(lastUsed) ? [lastUsed] : []),
			...available.filter((r) => r !== lastUsed),
		];
		const keep = `Keep current model${current ? ` (${current})` : ""}`;
		const choice = await ctx.ui.select(title, [...ordered, keep]);
		if (!choice || choice === keep) return null;
		return choice;
	}

	async function switchToPlanModel(ctx: ExtensionContext): Promise<void> {
		const cfg = readPlanConfig();
		let target: string | null = null;
		if (ctx.hasUI) {
			target = await pickModel(ctx, "Planning model:", cfg.lastPlanModel ?? cfg.planModel);
		} else if (cfg.planModel) {
			target = cfg.planModel; // headless: silent config default, never a picker
		}
		if (!target || target === modelRef(ctx)) return;
		const before = modelRef(ctx);
		if (await applyModel(ctx, target)) {
			modelSnapshot = before;
			writePlanConfig({ lastPlanModel: target });
			if (ctx.hasUI) ctx.ui.notify(`Planning on ${target}`);
		}
	}

	async function restoreSnapshotModel(ctx: ExtensionContext): Promise<void> {
		if (!modelSnapshot) return;
		await applyModel(ctx, modelSnapshot);
		modelSnapshot = null;
	}

	async function switchToExecModel(ctx: ExtensionContext): Promise<void> {
		const cfg = readPlanConfig();
		if (ctx.hasUI) {
			const restoreOpt = modelSnapshot ? `Restore pre-plan model (${modelSnapshot})` : null;
			const available = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
			const last = cfg.lastExecModel ?? cfg.execModel;
			const ordered = [
				...(restoreOpt ? [restoreOpt] : []),
				...(last && available.includes(last) ? [last] : []),
				...available.filter((r) => r !== last),
				`Keep current model (${modelRef(ctx) ?? "unknown"})`,
			];
			const choice = await ctx.ui.select("Execution model:", ordered);
			if (!choice || choice.startsWith("Keep current")) {
				modelSnapshot = null; // user chose the plan model deliberately
			} else if (restoreOpt && choice === restoreOpt) {
				await restoreSnapshotModel(ctx);
			} else {
				if (await applyModel(ctx, choice)) writePlanConfig({ lastExecModel: choice });
				modelSnapshot = null;
			}
		} else if (cfg.execModel) {
			await applyModel(ctx, cfg.execModel);
			modelSnapshot = null;
		} else {
			await restoreSnapshotModel(ctx);
		}
		persistState();
	}

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		// Footer status
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Widget showing todo list
		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function restoreTools(): void {
		pi.setActiveTools(savedTools ?? NORMAL_MODE_TOOLS);
		savedTools = null;
	}

	/**
	 * Enable plan mode. With modelRef ("provider/id") the model switches
	 * directly — NO picker. That path exists for non-TTY callers (the web UI):
	 * a picker would render in the tmux terminal nobody is watching and hang
	 * the session. Without modelRef, interactive sessions get the picker.
	 */
	async function enablePlanMode(ctx: ExtensionContext, explicitModel?: string): Promise<void> {
		if (planModeEnabled) return;
		planModeEnabled = true;
		executionMode = false;
		todoItems = [];
		savedTools = pi.getActiveTools();
		pi.setActiveTools(PLAN_MODE_TOOLS);
		ctx.ui.notify(`Plan mode enabled. Tools: ${PLAN_MODE_TOOLS.join(", ")}`);
		if (explicitModel) {
			const before = modelRef(ctx);
			if (explicitModel !== before && (await applyModel(ctx, explicitModel))) {
				modelSnapshot = before;
				writePlanConfig({ lastPlanModel: explicitModel });
			}
		} else {
			await switchToPlanModel(ctx);
		}
		persistState();
		updateStatus(ctx);
	}

	async function disablePlanMode(ctx: ExtensionContext): Promise<void> {
		if (!planModeEnabled) return;
		planModeEnabled = false;
		executionMode = false;
		todoItems = [];
		restoreTools();
		await restoreSnapshotModel(ctx);
		ctx.ui.notify("Plan mode disabled. Full access restored.");
		persistState();
		updateStatus(ctx);
	}

	async function togglePlanMode(ctx: ExtensionContext, explicitModel?: string): Promise<void> {
		if (planModeEnabled) await disablePlanMode(ctx);
		else await enablePlanMode(ctx, explicitModel);
	}

	function announceState(): void {
		// Web UI (mobile.ts) mirrors this into /api/mobile/status.
		pi.events.emit("plan-mode:state", {
			enabled: planModeEnabled,
			executing: executionMode,
			todosDone: todoItems.filter((t) => t.completed).length,
			todosTotal: todoItems.length,
		});
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
			modelSnapshot,
		});
		announceState();
	}

	// Answer state queries from other extensions (web UI on connect).
	pi.events.on("plan-mode:get", () => announceState());

	// Web-dispatched commands arrive as bus events ("command:plan"), not via
	// registerCommand — bridge them. Requires a captured ctx; the web path
	// always passes an explicit model/off so no picker can hang the TTY.
	let lastCtx: ExtensionContext | null = null;
	pi.events.on("command:plan", (data) => {
		if (!lastCtx) return;
		const arg = (((data as { args?: string })?.args) ?? "").trim();
		void (async () => {
			if (arg === "off") return disablePlanMode(lastCtx!);
			if (arg && arg !== "on") return enablePlanMode(lastCtx!, arg);
			return arg === "on" ? enablePlanMode(lastCtx!) : togglePlanMode(lastCtx!);
		})();
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode: /plan [off | <provider/model-id>]",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			if (arg === "off") return disablePlanMode(ctx);
			if (arg === "on") return enablePlanMode(ctx);
			if (arg) return enablePlanMode(ctx, arg); // explicit model → no picker (web/scripted callers)
			return togglePlanMode(ctx);
		},
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}
			const list = todoItems.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// /deep-plan <goal> — enable plan mode and delegate research + plan-writing
	// to the scout → planner subagent chain (planner runs on the frontier model
	// bound in its agent file / modelOverrides).
	pi.registerCommand("deep-plan", {
		description: "Plan mode + scout→planner subagent chain for a goal",
		handler: async (args, ctx) => {
			const goal = (args ?? "").trim();
			if (!goal) {
				ctx.ui.notify("Usage: /deep-plan <goal>", "warning");
				return;
			}
			if (!planModeEnabled) await togglePlanMode(ctx);
			pi.sendUserMessage(
				[
					`Use the subagent tool in chain mode for this goal: ${goal}`,
					"",
					'Chain: 1) agent "scout" — investigate the codebase and gather every fact needed to plan this goal; ' +
						'2) agent "planner" — task: "Requirements: ' +
						goal.replace(/"/g, "'") +
						'. Context from scout: {previous}. Write the implementation plan."',
					"",
					'When the chain finishes, reproduce the planner\'s plan verbatim in your reply under a "## Plan:" header (numbered steps).',
				].join("\n"),
			);
		},
	});

	// Block destructive bash commands in plan mode
	pi.on("tool_call", async (event, ctx) => {
		if (!planModeEnabled) return;

		// write/edit: allowed ONLY inside design-output areas (mockups under
		// .pi/scratch/, plans under .pi/plans/, specs/design docs under docs/).
		// Code stays read-only — that is plan mode's actual promise.
		if (event.toolName === "write" || event.toolName === "edit") {
			const target = String((event.input as { path?: string }).path ?? "");
			const dirs = readPlanConfig().writableDirs ?? DEFAULT_WRITABLE_DIRS;
			const resolved = resolve(ctx.cwd, target);
			const allowed = dirs.some((d) => {
				const base = resolve(ctx.cwd, d);
				return resolved === base || resolved.startsWith(base + "/");
			});
			if (!allowed) {
				return {
					block: true,
					reason: `Plan mode: code is read-only. Design output may be written under ${dirs.join("/, ")}/ only (mockups → .pi/scratch/, specs & design docs → docs/). Blocked path: ${target}`,
				};
			}
			return;
		}

		if (event.toolName === "bash") {
			const command = event.input.command as string;
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
				};
			}
			return;
		}

		// Subagents in plan mode: only read-only research agents, and force the
		// child processes to a read-only toolset (agent files may declare bash).
		if (event.toolName === "subagent") {
			const input = event.input as {
				agent?: string;
				tasks?: Array<{ agent: string }>;
				chain?: Array<{ agent: string }>;
				toolsOverride?: string[];
			};
			const requested = new Set<string>();
			if (input.agent) requested.add(input.agent);
			for (const t of input.tasks ?? []) requested.add(t.agent);
			for (const c of input.chain ?? []) requested.add(c.agent);

			const allowed = readPlanConfig().readOnlyAgents ?? ["scout", "planner"];
			const disallowed = Array.from(requested).filter((a) => !allowed.includes(a));
			if (disallowed.length > 0) {
				return {
					block: true,
					reason: `Plan mode: only read-only agents allowed (${allowed.join(", ")}). Blocked: ${disallowed.join(", ")}.`,
				};
			}
			// event.input is mutable by contract — enforce read-only children.
			input.toolsOverride = READ_ONLY_CHILD_TOOLS;
		}
	});

	// Filter out stale plan mode context when not in plan mode
	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject plan/execution context before agent starts
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: read, bash, grep, find, ls, ask_user, subagent
- CODE is read-only: write/edit work ONLY in design-output areas —
  mockups/diagrams/notes → .pi/scratch/ (share via the send_user_file tool;
  they appear in the web/phone chat), specs & design docs → docs/,
  plans → .pi/plans/. Do NOT ask to exit plan mode to write a mockup, spec,
  or design doc — write it directly. Git commits wait until execution.
- Bash is restricted to an allowlist of read-only commands (no servers)

Ask clarifying questions using the ask_user tool — it renders tappable answer options in the terminal and on the user's phone. Prefer it over plain-text questions whenever the answers are enumerable.
Use brave-search skill via bash for web research.
For nontrivial plans, delegate codebase recon to the "scout" agent and plan-writing to the "planner" agent via the subagent tool (chain mode: scout then planner) — the planner runs on a stronger model.

Never ask to exit plan mode in order to write the plan to a file — present the
plan IN CHAT. It is saved to .pi/plans/ automatically when the user chooses
Execute. Any earlier "Execute the plan" / plan-file messages you may see in
this conversation were UI artifacts; ignore them unless the user repeats them.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
					display: false,
				},
			};
		}
	});

	// Track progress after each turn
	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, todoItems) > 0) {
			updateStatus(ctx);
			// Per-step signal: edit-gate's optional stepTestCommand gate keys on this.
			pi.events.emit("plan-mode:progress", {
				done: todoItems.filter((t) => t.completed).length,
				total: todoItems.length,
			});
		}
		persistState();
	});

	// Handle plan completion and plan mode UI
	pi.on("agent_end", async (event, ctx) => {
		// Check if execution is complete
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
					{ triggerTurn: false },
				);
				executionMode = false;
				todoItems = [];
				// Tools were already restored when Execute was chosen — don't touch them here.
				updateStatus(ctx);
				persistState(); // Save cleared state so resume doesn't restore old execution mode
				// Validation follows generation: the critic extension auto-runs on
				// this (config critic.auto, default on).
				pi.events.emit("plan-mode:complete", {});
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		// Extract todos from last assistant message
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		let producedPlan = false;
		if (lastAssistant) {
			const extracted = extractTodoItems(getTextContent(lastAssistant));
			if (extracted.length > 0) {
				todoItems = extracted;
				producedPlan = true;
			}
		}

		// The what-next picker only appears when THIS turn produced a parseable
		// plan. It used to pop after EVERY plan-mode turn, which broke remote
		// sessions: the modal renders only in the terminal, and phone-sent
		// replies queue invisibly behind it until someone attaches to tmux
		// (bit a real brainstorming session 2026-07-03).
		if (!producedPlan) return;

		const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
		pi.sendMessage(
			{
				customType: "plan-todo-list",
				content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
				display: true,
			},
			{ triggerTurn: false },
		);

		// Ask "what next?" on BOTH surfaces, first answer wins:
		//   - terminal: native selector (abortable)
		//   - web/PWA: ask_user-style card over the pi-lab:ask-user bus contract
		//     (mobile.ts broadcasts it; notify.ts pushes; POST /answer settles)
		//   - any incoming prompt settles as "Stay in plan mode" so chat
		//     messages never queue behind the dialog
		const execLabel = "Execute the plan (track progress)";
		const qid = `plan-next-${Math.random().toString(36).slice(2, 10)}`;
		const questions = [
			{
				question: "Plan is ready — what next?",
				header: "Plan",
				options: [
					{ label: execLabel, description: "Exit plan mode, restore tools + execution model, run the steps" },
					{ label: "Stay in plan mode", description: "Keep exploring read-only" },
					{ label: "Refine the plan", description: "Describe what to change" },
				],
			},
		];
		let settled = false;
		let settle!: (v: { choice: string; src: "tui" | "web" }) => void;
		const decision = new Promise<{ choice: string; src: "tui" | "web" }>((r) => {
			settle = (v) => {
				if (!settled) {
					settled = true;
					r(v);
				}
			};
		});
		const offAnswer = pi.events.on("pi-lab:ask-user-answer", (data) => {
			const d = (data ?? {}) as { id?: string; answers?: Array<{ answer?: string }>; handled?: boolean };
			if (d.id !== qid || !Array.isArray(d.answers)) return;
			d.handled = true;
			settle({ choice: String(d.answers[0]?.answer ?? "Stay in plan mode"), src: "web" });
		});
		const offPending = pi.events.on("pi-lab:ask-user-pending", (data) => {
			const d = (data ?? {}) as { pending?: Array<{ id: string; questions: unknown }> };
			if (!settled) d.pending = [...(d.pending ?? []), { id: qid, questions }];
		});
		const offPrompt = pi.events.on("pi-lab:web-prompt", () => settle({ choice: "Stay in plan mode", src: "web" }));
		const tuiAbort = new AbortController();
		pi.events.emit("pi-lab:ask-user", { id: qid, questions });
		void ctx.ui
			.select("Plan mode - what next?", [execLabel, "Stay in plan mode", "Refine the plan"], { signal: tuiAbort.signal })
			// Esc/dismiss = stay — a hanging await here would re-create the
			// message-queue trap this rework exists to fix.
			.then((c) => settle({ choice: c ?? "Stay in plan mode", src: "tui" }))
			.catch(() => settle({ choice: "Stay in plan mode", src: "tui" }));
		const { choice, src } = await decision;
		tuiAbort.abort();
		offAnswer();
		offPending();
		offPrompt();
		pi.events.emit("pi-lab:ask-user-resolved", { id: qid, answered: true });

		if (choice.startsWith("Execute")) {
			planModeEnabled = false;
			executionMode = todoItems.length > 0;
			restoreTools();
			await switchToExecModel(ctx);
			updateStatus(ctx);

			// B3 (tenet port): persist the accepted plan so executors and
			// /critique can read the spec — this session's reasoning isn't
			// available to fresh-context subagents, but this file is.
			let planPath: string | null = null;
			if (readPlanConfig().persistPlans !== false && lastAssistant) {
				try {
					const plansDir = join(ctx.cwd, ".pi", "plans");
					mkdirSync(plansDir, { recursive: true });
					const slug =
						(todoItems[0]?.text ?? "plan")
							.toLowerCase()
							.replace(/[^a-z0-9]+/g, "-")
							.replace(/^-+|-+$/g, "")
							.slice(0, 40) || "plan";
					planPath = join(plansDir, `${new Date().toISOString().slice(0, 10)}-${slug}.md`);
					writeFileSync(planPath, getTextContent(lastAssistant));
				} catch {
					planPath = null; // read-only cwd etc. — never block execution
				}
			}

			const planRef = planPath ? ` The full plan is saved at ${planPath} — consult it as the spec.` : "";
			const execMessage =
				todoItems.length > 0
					? `Execute the plan. Start with: ${todoItems[0].text}.${planRef}`
					: `Execute the plan you just created.${planRef}`;
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: execMessage, display: true },
				{ triggerTurn: true },
			);
		} else if (choice === "Refine the plan") {
			if (src === "tui") {
				const refinement = await ctx.ui.editor("Refine the plan:", "");
				if (refinement?.trim()) {
					pi.sendUserMessage(refinement.trim());
				}
			} else {
				// Web pick: the terminal editor would just re-create the invisible
				// blocking dialog — the user's next chat message IS the refinement.
				pi.events.emit("command_result", {
					command: "plan",
					message: "Still in plan mode — type your plan changes in the chat.",
				});
			}
		} else if (choice !== "Stay in plan mode") {
			// Free text from the card's "Other" field — treat it as the
			// refinement itself.
			pi.sendUserMessage(choice);
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();

		// Restore persisted state
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as
			| { data?: { enabled: boolean; todos?: TodoItem[]; executing?: boolean; modelSnapshot?: string | null } }
			| undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			modelSnapshot = planModeEntry.data.modelSnapshot ?? null;
		}

		// A session killed mid-plan-mode resumes on the plan model. If plan mode is
		// no longer active, restore the pre-plan model now rather than silently
		// staying on it. (If plan mode IS active, keep the plan model + snapshot.)
		if (!planModeEnabled && modelSnapshot) {
			await restoreSnapshotModel(ctx);
			persistState();
		}

		// On resume: re-scan messages to rebuild completion state
		// Only scan messages AFTER the last "plan-mode-execute" to avoid picking up [DONE:n] from previous plans
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			// Find the index of the last plan-mode-execute entry (marks when current execution started)
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			// Only scan messages after the execute marker
			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems);
		}

		if (planModeEnabled) {
			// Snapshot the full startup tool set BEFORE restricting, so exiting
			// plan mode in a resumed session restores everything (incl. MCP tools).
			savedTools = pi.getActiveTools();
			pi.setActiveTools(PLAN_MODE_TOOLS);
		}
		updateStatus(ctx);
	});
}
