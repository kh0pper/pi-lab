/**
 * sessions.mjs — shared pi session enumeration / spawn / teleport logic.
 *
 * Plain ESM with no pi imports so BOTH pi extensions (extensions/session-web)
 * and the standalone pi-hub daemon (hub/server.mjs) can use it.
 *
 * pi stores sessions at ~/.pi/agent/sessions/<cwd-encoded>--/<ts>_<uuid>.jsonl;
 * line 1 is {"type":"session","version":3,"id","timestamp","cwd"}.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SESSIONS_DIR = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(os.homedir(), ".pi", "agent", "sessions");

/** cwd substrings that mark bot/bundle workspaces — hidden from listings by default. */
export const DEFAULT_EXCLUDE_CWD_PATTERNS = ["/.crow-mpa/"];

function firstLine(filePath) {
	// Sessions can be large; read just enough for line 1.
	const fd = fs.openSync(filePath, "r");
	try {
		const buf = Buffer.alloc(4096);
		const n = fs.readSync(fd, buf, 0, buf.length, 0);
		const text = buf.slice(0, n).toString("utf8");
		const nl = text.indexOf("\n");
		return nl === -1 ? text : text.slice(0, nl);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Enumerate on-disk sessions, newest first.
 * @returns [{ id, cwd, file, mtimeMs, sizeBytes, startedAt }]
 */
export function listSessions({ limit = 50, excludeCwdPatterns = DEFAULT_EXCLUDE_CWD_PATTERNS } = {}) {
	const out = [];
	let dirs = [];
	try {
		dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
	} catch {
		return out;
	}
	for (const dir of dirs) {
		const dirPath = path.join(SESSIONS_DIR, dir.name);
		let files = [];
		try {
			files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const f of files) {
			const file = path.join(dirPath, f);
			try {
				const stat = fs.statSync(file);
				const header = JSON.parse(firstLine(file));
				if (header?.type !== "session" || !header.cwd) continue;
				const cwd = header.cwd;
				if (excludeCwdPatterns.some((p) => cwd.includes(p))) continue;
				out.push({
					id: header.id ?? "",
					cwd,
					file,
					mtimeMs: stat.mtimeMs,
					sizeBytes: stat.size,
					startedAt: header.timestamp ?? null,
				});
			} catch {
				// unreadable/corrupt session file — skip
			}
		}
	}
	out.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return out.slice(0, limit);
}

/** The shell command a human runs to teleport into a session from any terminal. */
export function teleportCommand(session) {
	return `cd '${session.cwd.replace(/'/g, "'\\''")}' && pi --session '${session.file.replace(/'/g, "'\\''")}'`;
}

/** tmux session name for a pi session id (or fresh spawn). */
function tmuxName(seed) {
	return `pi-${String(seed).replace(/[^\w-]+/g, "").slice(0, 12) || Math.floor(performance.now() * 1000).toString(36)}`;
}

function execFileP(cmd, args, opts = {}) {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, opts, (err, stdout, stderr) => {
			if (err) reject(Object.assign(err, { stdout, stderr }));
			else resolve({ stdout, stderr });
		});
	});
}

/**
 * Spawn a pi session inside a detached tmux session (survives the caller,
 * attachable from any terminal, fires extension lifecycle events — unlike -p).
 * @returns { tmuxSession, command }
 */
export async function spawnSession({ cwd, prompt, resumeFile, model }) {
	if (!cwd || !fs.existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
	// Argument-injection hardening: these values arrive from the (authenticated)
	// web API; none of them may smuggle extra pi flags.
	if (model && /^-/.test(model)) throw new Error("invalid model");
	if (prompt && /^-/.test(prompt.trim())) throw new Error("prompt must not start with '-'");
	if (resumeFile) {
		const real = fs.realpathSync(resumeFile);
		if (!real.startsWith(SESSIONS_DIR + path.sep) || !real.endsWith(".jsonl")) {
			throw new Error("resumeFile must be a session .jsonl under the pi sessions dir");
		}
		resumeFile = real;
	}
	const name = tmuxName(resumeFile ? path.basename(resumeFile).slice(0, 8) : Date.now().toString(36));
	const piArgs = ["pi"];
	if (resumeFile) piArgs.push("--session", resumeFile);
	if (model) piArgs.push("--model", model);
	if (prompt) piArgs.push(prompt);
	// tmux new-session -d -s <name> -c <cwd> pi [args...] — argv form, no shell string.
	await execFileP("tmux", ["new-session", "-d", "-s", name, "-c", cwd, ...piArgs]);
	return { tmuxSession: name, command: `tmux attach -t ${name}` };
}

/** Running tmux sessions that look like pi sessions (pi-*). */
export async function listTmuxPiSessions() {
	try {
		const { stdout } = await execFileP("tmux", ["list-sessions", "-F", "#{session_name}\t#{session_created}\t#{pane_current_path}"]);
		return stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [name, created, cwd] = line.split("\t");
				return { name, createdAt: Number(created) * 1000 || null, cwd: cwd ?? "" };
			})
			.filter((s) => s.name.startsWith("pi-"));
	} catch {
		return []; // no tmux server running
	}
}
