/**
 * background-tasks.ts — run shell commands in the background (Claude Code
 * run_in_background parity).
 *
 * Tools:
 *   - bash_background(command, timeout?, cwd?) — start a command detached,
 *     return a task id immediately. Output streams to a log file.
 *   - task_output(task_id) — status + output since the last read (incremental).
 *   - task_kill(task_id)   — SIGTERM the process group, SIGKILL after 5s.
 *
 * Completion notification (settings.backgroundTasks.notify):
 *   - "wake" (default): pi.sendMessage({triggerTurn:true}) — starts a new turn
 *     when the agent is idle, steers mid-run when it is streaming. Emits
 *     "pi-lab:bg-wake" on the bus first so hooks.ts skips Stop hooks for the
 *     wake turn.
 *   - "note": queued and injected as context alongside the next user message.
 *   - "off": nothing; poll with task_output.
 *
 * Permission integration: bash_background commands flow through the same
 * tool_call gating as bash — permission-modes.ts routes them through
 * isSafeCommand/classifier, permission-gating.ts applies the destructive-bash
 * backstop. task_output/task_kill are read-only (they only touch tasks this
 * session started).
 *
 * Logs: ~/.pi/agent/tasks/<sessionId>/<taskId>.log (0600). Tasks are killed on
 * session_shutdown (all reasons — the in-memory registry dies with the
 * process, so orphaning would be permanent). If pi crashes without the event,
 * detached children orphan; logs remain for forensics.
 *
 * Settings:
 *   "backgroundTasks": { "enabled": true, "maxConcurrent": 5,
 *                        "maxOutputBytes": 65536, "notify": "wake" }
 *
 * No-op for bots (PI_BOT_PERMISSION_POLICY) and subagent children
 * (PIBOT_SUBAGENT_DEPTH >= 1).
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

interface BackgroundTasksConfig {
	enabled?: boolean;
	maxConcurrent?: number;
	maxOutputBytes?: number;
	notify?: "wake" | "note" | "off";
}

function loadConfig(): BackgroundTasksConfig {
	const settingsPath = resolve(homedir(), ".pi", "agent", "settings.json");
	if (!existsSync(settingsPath)) return {};
	try {
		const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as { backgroundTasks?: BackgroundTasksConfig };
		return raw.backgroundTasks ?? {};
	} catch {
		return {};
	}
}

interface Task {
	id: string;
	command: string;
	pid: number;
	logPath: string;
	status: "running" | "exited" | "killed" | "timeout" | "failed";
	exitCode: number | null;
	readOffset: number;
	startedAt: number;
	endedAt: number | null;
	timeoutHandle: ReturnType<typeof setTimeout> | null;
}

function tailOfLog(logPath: string, maxBytes = 2000): string {
	try {
		const size = statSync(logPath).size;
		const start = Math.max(0, size - maxBytes);
		return readRange(logPath, start, size);
	} catch {
		return "";
	}
}

function readRange(logPath: string, start: number, end: number): string {
	if (end <= start) return "";
	const fd = openSync(logPath, "r");
	try {
		const buf = Buffer.alloc(end - start);
		const n = readSync(fd, buf, 0, buf.length, start);
		return buf.subarray(0, n).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

function fmtDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m${s % 60}s`;
}

export default function (pi: ExtensionAPI) {
	// Bots and subagent children don't get background tasks.
	if (process.env["PI_BOT_PERMISSION_POLICY"]) return;
	if (Number(process.env["PIBOT_SUBAGENT_DEPTH"] ?? "0") >= 1) return;

	const tasks = new Map<string, Task>();
	let seq = 0;
	let sessionId = `nosession-${process.pid}`;
	let sessionCwd = process.cwd();

	pi.on("session_start", (_event, ctx) => {
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			// keep pid-based fallback
		}
		sessionCwd = ctx.cwd ?? process.cwd();
	});

	function taskDir(): string {
		return join(homedir(), ".pi", "agent", "tasks", sessionId);
	}

	function runningTasks(): Task[] {
		return [...tasks.values()].filter((t) => t.status === "running");
	}

	function killTree(task: Task, finalStatus: "killed" | "timeout"): void {
		if (task.status !== "running") return;
		task.status = finalStatus;
		const term = (sig: NodeJS.Signals) => {
			try {
				process.kill(-task.pid, sig); // negative pid = process group (detached => own pgid)
			} catch {
				try {
					process.kill(task.pid, sig);
				} catch {
					// already gone
				}
			}
		};
		term("SIGTERM");
		setTimeout(() => term("SIGKILL"), 5000).unref();
	}

	function statusLine(task: Task): string {
		const dur = fmtDuration((task.endedAt ?? Date.now()) - task.startedAt);
		const state =
			task.status === "running"
				? `running (${dur})`
				: `${task.status}${task.exitCode !== null ? ` exit ${task.exitCode}` : ""} after ${dur}`;
		return `[${task.id}] ${state} — ${task.command.slice(0, 80)}`;
	}

	function notifyCompletion(task: Task): void {
		try {
			const mode = loadConfig().notify ?? "wake";
			if (mode === "off") return;
			const tail = tailOfLog(task.logPath);
			const content =
				`Background task ${task.id} finished: ${task.status}` +
				`${task.exitCode !== null ? ` (exit ${task.exitCode})` : ""} after ${fmtDuration(
					(task.endedAt ?? Date.now()) - task.startedAt,
				)}.\n` +
				`Command: ${task.command.slice(0, 200)}\n` +
				(tail ? `Output tail:\n${tail}\n` : "(no output)\n") +
				`Use task_output("${task.id}") for anything not shown.`;
			if (mode === "note") {
				pi.sendMessage(
					{ customType: "background-task", content, display: true, details: { id: task.id } },
					{ deliverAs: "nextTurn" },
				);
			} else {
				// Tell hooks.ts (same process) this turn is a bg wake, not a user turn.
				pi.events.emit("pi-lab:bg-wake", { id: task.id });
				pi.sendMessage(
					{ customType: "background-task", content, display: true, details: { id: task.id } },
					{ triggerTurn: true },
				);
			}
		} catch {
			// A completion callback must never take down the session.
		}
	}

	// --- bash_background --------------------------------------------------------

	pi.registerTool({
		name: "bash_background",
		label: "Background bash",
		description:
			"Run a shell command in the background and return immediately with a task id. " +
			"Use for long-running commands (servers, watch processes, long builds/tests). " +
			"Output is captured to a log; read it incrementally with task_output. " +
			"You will be notified when the task finishes. stdin is closed (commands that " +
			"read stdin see EOF). Tasks are killed when the session ends.",
		parameters: Type.Object({
			command: Type.String({ description: "The shell command to run in the background" }),
			timeout: Type.Optional(
				Type.Number({ description: "Optional hard cap in seconds; the task is killed when it elapses" }),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory (defaults to the session cwd)" })),
		}),
		async execute(_toolCallId, params) {
			const cfg = loadConfig();
			if (cfg.enabled === false) {
				return {
					content: [{ type: "text" as const, text: "Background tasks are disabled (settings.backgroundTasks.enabled=false)." }],
					details: undefined,
					isError: true,
				};
			}
			const maxConcurrent = cfg.maxConcurrent ?? 5;
			if (runningTasks().length >= maxConcurrent) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Too many running background tasks (max ${maxConcurrent}). Kill or wait for one:\n${runningTasks()
								.map(statusLine)
								.join("\n")}`,
						},
					],
					details: undefined,
					isError: true,
				};
			}

			const id = `bg-${++seq}`;
			const dir = taskDir();
			mkdirSync(dir, { recursive: true });
			const logPath = join(dir, `${id}.log`);
			const fd = openSync(logPath, "a", 0o600);

			let child: ReturnType<typeof spawn>;
			try {
				child = spawn("/bin/bash", ["-c", params.command], {
					cwd: params.cwd ?? sessionCwd,
					detached: true, // own process group -> group kill works
					stdio: ["ignore", fd, fd],
					env: { ...process.env },
				});
			} catch (err) {
				closeSync(fd);
				return {
					content: [{ type: "text" as const, text: `Failed to spawn: ${(err as Error).message}` }],
					details: undefined,
					isError: true,
				};
			}
			closeSync(fd); // child holds its own descriptor

			const task: Task = {
				id,
				command: params.command,
				pid: child.pid ?? -1,
				logPath,
				status: "running",
				exitCode: null,
				readOffset: 0,
				startedAt: Date.now(),
				endedAt: null,
				timeoutHandle: null,
			};
			tasks.set(id, task);

			if (params.timeout && params.timeout > 0) {
				task.timeoutHandle = setTimeout(() => killTree(task, "timeout"), params.timeout * 1000);
				task.timeoutHandle.unref();
			}

			child.on("error", () => {
				task.status = "failed";
				task.endedAt = Date.now();
			});
			child.on("exit", (code, signal) => {
				if (task.timeoutHandle) clearTimeout(task.timeoutHandle);
				task.endedAt = Date.now();
				task.exitCode = code;
				if (task.status === "running") task.status = signal ? "killed" : "exited";
				notifyCompletion(task);
			});
			child.unref(); // don't keep the pi process alive for this child

			return {
				content: [
					{
						type: "text" as const,
						text:
							`Started background task ${id} (pid ${task.pid}).\n` +
							`Log: ${logPath}\n` +
							`Poll with task_output("${id}"); you will be notified when it finishes.`,
					},
				],
				details: { id, pid: task.pid, logPath },
				isError: false,
			};
		},
	});

	// --- task_output --------------------------------------------------------------

	pi.registerTool({
		name: "task_output",
		label: "Background task output",
		description:
			"Read a background task's status and any output produced since the last task_output call. " +
			"Call with no task_id to list all background tasks in this session.",
		parameters: Type.Object({
			task_id: Type.Optional(Type.String({ description: "Task id from bash_background (omit to list all tasks)" })),
		}),
		async execute(_toolCallId, params) {
			if (!params.task_id) {
				const all = [...tasks.values()];
				return {
					content: [
						{
							type: "text" as const,
							text: all.length === 0 ? "No background tasks in this session." : all.map(statusLine).join("\n"),
						},
					],
					details: undefined,
					isError: false,
				};
			}
			const task = tasks.get(params.task_id);
			if (!task) {
				return {
					content: [{ type: "text" as const, text: `Unknown task id: ${params.task_id}` }],
					details: undefined,
					isError: true,
				};
			}
			const maxRead = loadConfig().maxOutputBytes ?? 65536;
			let size = 0;
			try {
				size = statSync(task.logPath).size;
			} catch {
				// log missing (never wrote); size stays 0
			}
			let start = task.readOffset;
			let skippedNote = "";
			if (size - start > maxRead) {
				skippedNote = `[... skipped ${size - start - maxRead} bytes; see ${task.logPath} for full output ...]\n`;
				start = size - maxRead;
			}
			const chunk = readRange(task.logPath, start, size);
			task.readOffset = size;
			return {
				content: [
					{
						type: "text" as const,
						text: `${statusLine(task)}\n${skippedNote}${chunk || "(no new output)"}`,
					},
				],
				details: { id: task.id, status: task.status, exitCode: task.exitCode },
				isError: false,
			};
		},
	});

	// --- task_kill -------------------------------------------------------------------

	pi.registerTool({
		name: "task_kill",
		label: "Kill background task",
		description: "Terminate a running background task (SIGTERM, then SIGKILL after 5s).",
		parameters: Type.Object({
			task_id: Type.String({ description: "Task id from bash_background" }),
		}),
		async execute(_toolCallId, params) {
			const task = tasks.get(params.task_id);
			if (!task) {
				return {
					content: [{ type: "text" as const, text: `Unknown task id: ${params.task_id}` }],
					details: undefined,
					isError: true,
				};
			}
			if (task.status !== "running") {
				return {
					content: [{ type: "text" as const, text: `Task already finished: ${statusLine(task)}` }],
					details: undefined,
					isError: false,
				};
			}
			killTree(task, "killed");
			task.endedAt = Date.now();
			return {
				content: [{ type: "text" as const, text: `Killed: ${statusLine(task)}` }],
				details: { id: task.id },
				isError: false,
			};
		},
	});

	// --- cross-extension bus (checkpoint/rewind coordination) ---------------------------
	// Synchronous request/response: the emitter passes a mutable payload object.

	pi.events.on("pi-lab:bg-list", (payload: unknown) => {
		(payload as { running?: string[] }).running = runningTasks().map(statusLine);
	});

	pi.events.on("pi-lab:bg-kill-all", () => {
		for (const task of runningTasks()) killTree(task, "killed");
	});

	// --- cleanup -------------------------------------------------------------------------

	pi.on("session_shutdown", () => {
		for (const task of runningTasks()) killTree(task, "killed");
	});
}
