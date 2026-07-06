/**
 * edit-gate.ts — per-edit syntax gates (long-horizon quality, research rank #1).
 *
 * After every `edit`/`write` tool call, runs a fast language-appropriate syntax
 * check on the touched file and, on failure, appends a `[gate]` line to the tool
 * result so the model fixes the break IMMEDIATELY instead of compounding on it.
 * Evidence: SWE-agent's lint-gate ablation (18.0% → 15.0% resolution without it;
 * edits succeed 90.5% overall but only 57.2% after one failed edit) and the
 * horizon-length math (task horizon scales ~ln(s)/ln(p) in per-step accuracy).
 * Honesty note: the cited ablation is for the stronger BLOCKING variant (reject
 * before apply); this v1 is feedback-after-apply. Revert-on-failure is v2 (needs
 * checkpoint coordination).
 *
 * Checkers (settings `editGate.checkers` extends/overrides; keyed by extension):
 *   .js/.mjs/.cjs → node --check          .py → python3 ast.parse (no .pyc litter)
 *   .sh/.bash     → bash -n               .json → JSON.parse (in-process)
 *   .ts/.tsx      → esbuild transform (SYNTAX only, no type checking — same
 *   standard as node --check for JS; ~50ms warm). The binary is resolved from
 *   THIS package's node_modules so the gate works in any edited project;
 *   missing binary fails open via ENOENT.
 * Every check has a hard ~1.5s kill timeout: emitToolResult awaits handlers
 * serially, so a hung checker would stall the whole agent loop on every edit.
 *
 * Runs EVERYWHERE — including `pi -p` subagent workers (tool events are agent
 * hooks, not lifecycle events; verified against pi v0.74.2). That's the point:
 * workers are where most edits happen. Bots keep it too (a syntax gate is pure
 * feedback, no ambient side effects — the bot-exclusion invariant covers
 * servers/notifications/prompts, not result transforms).
 *
 * Also: plan-step test gate — when plan-mode marks a step [DONE:n] and settings
 * `planMode.stepTestCommand` is set, runs it and injects failures as a message.
 * Off by default; feedback may lag one step (documented).
 *
 * Settings: "editGate": { "enabled": true, "checkers": { ".ext": ["cmd", "args…"] } }
 *   (checker argv gets the file path appended; empty array disables an extension)
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface EditGateConfig {
	enabled?: boolean;
	checkers?: Record<string, string[]>;
}

const CHECK_TIMEOUT_MS = 1500;

// esbuild ships in this package's node_modules — absolute path so the gate
// covers TS edits in ANY project (the edited repo need not depend on esbuild).
// Loader is inferred from the file extension; --outfile=/dev/null discards
// output. A missing binary is ENOENT → fail open.
const ESBUILD_BIN = resolve(new URL(".", import.meta.url).pathname, "..", "node_modules", ".bin", "esbuild");
const ESBUILD_CHECK = [ESBUILD_BIN, "--outfile=/dev/null", "--log-level=error"];

const DEFAULT_CHECKERS: Record<string, string[]> = {
	".js": ["node", "--check"],
	".mjs": ["node", "--check"],
	".cjs": ["node", "--check"],
	".ts": ESBUILD_CHECK,
	".tsx": ESBUILD_CHECK,
	".mts": ESBUILD_CHECK,
	".cts": ESBUILD_CHECK,
	// ast.parse, not py_compile: py_compile's job is WRITING a .pyc (ignores -B),
	// which would litter __pycache__ into the user's tree on every edit.
	".py": ["python3", "-c", "import ast,sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])"],
	".sh": ["bash", "-n"],
	".bash": ["bash", "-n"],
};

function loadConfig(): EditGateConfig {
	const p = resolve(homedir(), ".pi", "agent", "settings.json");
	if (!existsSync(p)) return {};
	try {
		return (JSON.parse(readFileSync(p, "utf8")) as { editGate?: EditGateConfig }).editGate ?? {};
	} catch {
		return {};
	}
}

/** Returns null when the file passes (or has no checker); else the first error lines. */
function checkSyntax(filePath: string): Promise<string | null> {
	const ext = extname(filePath).toLowerCase();

	if (ext === ".json") {
		// in-process: cheap and exact
		try {
			JSON.parse(readFileSync(filePath, "utf8"));
			return Promise.resolve(null);
		} catch (err) {
			return Promise.resolve((err as Error).message.slice(0, 300));
		}
	}

	const checkers = { ...DEFAULT_CHECKERS, ...loadConfig().checkers };
	const argv = checkers[ext];
	if (!Array.isArray(argv) || argv.length === 0) return Promise.resolve(null);

	return new Promise((resolvePromise) => {
		execFile(
			argv[0],
			[...argv.slice(1), filePath],
			{
				timeout: CHECK_TIMEOUT_MS,
				killSignal: "SIGKILL",
				maxBuffer: 256 * 1024,
				env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
			},
			(err, _stdout, stderr) => {
				if (!err) {
					resolvePromise(null);
					return;
				}
				// Timeout or checker-missing: fail open (no gate), never block on infra.
				const e = err as { killed?: boolean; code?: string | number };
				if (e.killed || e.code === "ENOENT") {
					resolvePromise(null);
					return;
				}
				const firstLines = (stderr || String(err)).split("\n").slice(0, 4).join("\n").trim();
				resolvePromise(firstLines.slice(0, 400) || "syntax check failed");
			},
		);
	});
}

export default function (pi: ExtensionAPI) {
	// Deliberately NO bot/subagent exclusion — see header. Pure result transform.

	pi.on("tool_result", async (event) => {
		if (loadConfig().enabled === false) return undefined;
		if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
		if (event.isError) return undefined; // the edit itself failed; nothing new applied
		const filePath = (event.input as { path?: string }).path;
		if (!filePath || !existsSync(filePath)) return undefined;

		const error = await checkSyntax(filePath);
		if (!error) return undefined;
		return {
			content: [
				...event.content,
				{
					type: "text" as const,
					text: `\n[gate] this ${event.toolName} introduced a syntax error in ${filePath}:\n${error}\nFix it before proceeding.`,
				},
			],
		};
	});

	// --- plan-step test gate (off unless planMode.stepTestCommand is set) -------

	function stepTestCommand(): string | null {
		const p = resolve(homedir(), ".pi", "agent", "settings.json");
		try {
			const cmd = (JSON.parse(readFileSync(p, "utf8")) as { planMode?: { stepTestCommand?: string } }).planMode
				?.stepTestCommand;
			return typeof cmd === "string" && cmd.trim() ? cmd : null;
		} catch {
			return null;
		}
	}

	let lastDoneCount = 0;
	pi.events.on("plan-mode:progress", (data) => {
		const done = Number((data as { done?: number })?.done ?? 0);
		if (done <= lastDoneCount) return;
		lastDoneCount = done;
		const cmd = stepTestCommand();
		if (!cmd) return;
		execFile(
			"/bin/bash",
			["-c", cmd],
			{ timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 512 * 1024, cwd: process.cwd() },
			(err, stdout, stderr) => {
				if (!err) return; // tests green — stay quiet
				const tail = `${stdout}\n${stderr}`.split("\n").filter(Boolean).slice(-8).join("\n");
				pi.sendMessage(
					{
						customType: "step-gate",
						content: `[step gate] "${cmd}" failed after completing plan step ${done}:\n${tail.slice(0, 1200)}`,
						display: true,
						details: undefined,
					},
					{ triggerTurn: false },
				);
			},
		);
	});
}
