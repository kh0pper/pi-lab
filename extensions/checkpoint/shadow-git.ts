/**
 * shadow-git.ts — file-snapshot engine for the checkpoint extension.
 *
 * Maintains a "shadow" git repository per pi session: a detached GIT_DIR under
 * ~/.pi/agent/checkpoints/<sessionId>/git whose work-tree is the session cwd.
 * The user's own repo is never touched — git refuses to index anything under a
 * `.git` directory, all identity/config is passed per-invocation via -c flags,
 * and nothing here writes to the work-tree except restore().
 *
 * Every checkpoint is `add -A && commit` in the shadow repo (blobs are
 * content-deduplicated, so repeated snapshots of a mostly-unchanged tree are
 * cheap). Restore is `reset --hard <sha>` — reverts modified files AND deletes
 * files created after the checkpoint. Each checkpoint sha is pinned under
 * refs/checkpoints/ and gc is disabled, so commits that become unreachable
 * after a rewind (the "redo" side) can't be pruned out from under index.json.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_EXCLUDES = [
	"node_modules/",
	".cache/",
	".venv/",
	"venv/",
	"__pycache__/",
	"dist/",
	"build/",
	"target/",
	"*.log",
	"*.gguf",
	"*.safetensors",
	"*.bin",
	".DS_Store",
];

export interface ShadowGitOptions {
	gitDir: string;
	workTree: string;
	timeoutMs?: number;
	excludePatterns?: string[];
}

export class ShadowGit {
	private readonly gitDir: string;
	private readonly workTree: string;
	private readonly timeoutMs: number;
	private readonly excludePatterns: string[];
	/** Serializes all git operations for this session (snapshot vs restore races). */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(opts: ShadowGitOptions) {
		this.gitDir = opts.gitDir;
		this.workTree = opts.workTree;
		this.timeoutMs = opts.timeoutMs ?? 30000;
		this.excludePatterns = opts.excludePatterns ?? [];
	}

	private run(
		args: string[],
		opts?: { timeoutMs?: number; maxBuffer?: number },
	): Promise<{ stdout: string; stderr: string; code: number; truncated: boolean }> {
		return new Promise((resolvePromise) => {
			execFile(
				"git",
				[
					"--git-dir",
					this.gitDir,
					"--work-tree",
					this.workTree,
					"-c",
					"user.name=pi-checkpoint",
					"-c",
					"user.email=checkpoint@pi.local",
					"-c",
					"commit.gpgsign=false",
					"-c",
					"gc.auto=0",
					"-c",
					"advice.addEmbeddedRepo=false",
					...args,
				],
				{ cwd: this.workTree, timeout: opts?.timeoutMs ?? this.timeoutMs, maxBuffer: opts?.maxBuffer ?? 8 * 1024 * 1024 },
				(err, stdout, stderr) => {
					// maxBuffer overflow must fail LOUDLY (a truncated binary patch
					// silently corrupts a tournament apply).
					const truncated = Boolean(err && /maxBuffer/.test(String((err as Error).message)));
					const code = err ? ((err as { code?: number }).code as number | undefined) ?? -1 : 0;
					resolvePromise({
						stdout: stdout ?? "",
						stderr: stderr ?? "",
						code: truncated ? -2 : typeof code === "number" ? code : -1,
						truncated,
					});
				},
			);
		});
	}

	/** Chain an operation onto the per-session mutex. */
	private locked<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.queue.then(fn, fn);
		this.queue = next.catch(() => {});
		return next;
	}

	private async ensureRepo(): Promise<void> {
		if (existsSync(join(this.gitDir, "HEAD"))) return;
		mkdirSync(this.gitDir, { recursive: true });
		const r = await this.run(["init", "--quiet"]);
		if (r.code !== 0) throw new Error(`shadow git init failed: ${r.stderr.slice(0, 200)}`);
		const excludeFile = join(this.gitDir, "info", "exclude");
		mkdirSync(join(this.gitDir, "info"), { recursive: true });
		writeFileSync(excludeFile, [...DEFAULT_EXCLUDES, ...this.excludePatterns].join("\n") + "\n");
	}

	/** Snapshot the work-tree. Returns the commit sha (HEAD sha when nothing changed). */
	snapshot(label: string): Promise<string> {
		return this.locked(async () => {
			await this.ensureRepo();
			const add = await this.run(["add", "-A", "--", "."]);
			if (add.code !== 0) throw new Error(`shadow git add failed: ${add.stderr.slice(0, 200)}`);
			const msg = label.replace(/\n/g, " ").slice(0, 120) || "checkpoint";
			const commit = await this.run(["commit", "--quiet", "--no-verify", "-m", msg]);
			// exit 1 with nothing-to-commit is fine — reuse HEAD
			if (commit.code !== 0 && !/nothing to commit|nothing added/i.test(commit.stdout + commit.stderr)) {
				throw new Error(`shadow git commit failed: ${commit.stderr.slice(0, 200) || commit.stdout.slice(0, 200)}`);
			}
			const rev = await this.run(["rev-parse", "HEAD"]);
			if (rev.code !== 0) throw new Error("shadow git rev-parse failed (empty repo and nothing to commit?)");
			const sha = rev.stdout.trim();
			await this.run(["update-ref", `refs/checkpoints/${sha.slice(0, 12)}`, sha]);
			return sha;
		});
	}

	/**
	 * Restore the work-tree to `sha`. Takes a safety snapshot first (the "redo
	 * point") and returns its sha. Note: the user's own git state (.git, branch
	 * heads, index) is NOT restored — same gap as Claude Code's rewind.
	 */
	restore(sha: string): Promise<{ safetySha: string }> {
		return this.locked(async () => {
			await this.ensureRepo();
			// inline snapshot (can't call this.snapshot() — already inside the lock)
			await this.run(["add", "-A", "--", "."]);
			await this.run(["commit", "--quiet", "--no-verify", "-m", "pre-rewind (redo point)"]);
			const rev = await this.run(["rev-parse", "HEAD"]);
			const safetySha = rev.stdout.trim();
			if (safetySha) await this.run(["update-ref", `refs/checkpoints/${safetySha.slice(0, 12)}`, safetySha]);
			const reset = await this.run(["reset", "--hard", "--quiet", sha], this.timeoutMs * 2);
			if (reset.code !== 0) throw new Error(`shadow git reset failed: ${reset.stderr.slice(0, 200)}`);
			return { safetySha };
		});
	}

	/** Short change summary between two checkpoints (for the restore message). */
	async diffStat(fromSha: string, toSha: string): Promise<string> {
		const r = await this.run(["diff", "--stat", `${fromSha}..${toSha}`]);
		if (r.code !== 0) return "";
		const lines = r.stdout.trim().split("\n");
		return lines.length > 12 ? [...lines.slice(0, 11), `… (${lines.length - 11} more)`].join("\n") : r.stdout.trim();
	}

	// -------------------------------------------------------------------------
	// Tournament support (D5). NOTE for all three: shadow info/exclude paths
	// (node_modules, *.log, *.gguf, … + checkpoints.excludePatterns) are
	// INVISIBLE to snapshot/diff/restore/apply — an attempt's changes to
	// excluded files are neither scored nor re-applied.
	// -------------------------------------------------------------------------

	/** Plain-text unified diff between two checkpoints (for critics/humans). */
	diffText(fromSha: string, toSha: string): Promise<string> {
		return this.locked(async () => {
			const r = await this.run(["diff", `${fromSha}..${toSha}`], { maxBuffer: 16 * 1024 * 1024 });
			if (r.truncated) throw new Error("diff exceeds 16MB buffer");
			if (r.code !== 0) throw new Error(`shadow diff failed: ${r.stderr.slice(0, 200)}`);
			return r.stdout;
		});
	}

	/** Binary-safe patch between two checkpoints (64MB cap; overflow fails loudly). */
	diffBinary(fromSha: string, toSha: string): Promise<string> {
		return this.locked(async () => {
			const r = await this.run(["diff", "--binary", `${fromSha}..${toSha}`], { maxBuffer: 64 * 1024 * 1024 });
			if (r.truncated) throw new Error("diff exceeds 64MB buffer — refusing to truncate a binary patch");
			if (r.code !== 0) throw new Error(`shadow diff failed: ${r.stderr.slice(0, 200)}`);
			return r.stdout;
		});
	}

	/** Numstat between two checkpoints. */
	diffNumstat(fromSha: string, toSha: string): Promise<{ files: number; insertions: number; deletions: number; fileList: string[] }> {
		return this.locked(async () => {
			const r = await this.run(["diff", "--numstat", `${fromSha}..${toSha}`]);
			if (r.code !== 0) throw new Error(`shadow numstat failed: ${r.stderr.slice(0, 200)}`);
			let insertions = 0;
			let deletions = 0;
			const fileList: string[] = [];
			const rows = r.stdout.trim() ? r.stdout.trim().split("\n") : [];
			for (const line of rows) {
				const [a, b, f] = line.split("\t");
				insertions += Number(a) || 0;
				deletions += Number(b) || 0;
				if (f) fileList.push(f);
			}
			return { files: rows.length, insertions, deletions, fileList };
		});
	}

	/**
	 * Apply a patch to the work tree. The temp patch file lives INSIDE the
	 * checkpoint dir (never the work tree — it would be swept into the next
	 * snapshot). `threeWay` uses the shadow repo's baseline blobs.
	 */
	applyPatch(patchText: string, opts?: { threeWay?: boolean }): Promise<{ ok: boolean; stderr: string }> {
		return this.locked(async () => {
			const patchPath = join(this.gitDir, "..", `patch-${process.pid}-${Math.floor(Math.random() * 1e6)}.diff`);
			writeFileSync(patchPath, patchText);
			try {
				const r = await this.run([
					"apply",
					"--binary",
					...(opts?.threeWay ? ["--3way"] : []),
					patchPath,
				]);
				return { ok: r.code === 0, stderr: r.stderr.slice(0, 400) };
			} finally {
				try {
					rmSync(patchPath, { force: true });
				} catch {
					// temp cleanup best-effort
				}
			}
		});
	}
}
