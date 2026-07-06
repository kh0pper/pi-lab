/**
 * debug.ts — persist raw critic output when a verdict fails to parse.
 * PURE formatting + a best-effort writer; no pi imports (unit-tested via
 * extensions/critic/debug.test.mjs).
 *
 * Why: a critic that runs for hours and then emits no parseable verdict is
 * fail-closed (correct) but was undiagnosable — the raw output lived only in
 * the child process result and evaporated (2026-07-06 harness run: BOTH
 * critics parse-errored after ~2.5h and nothing could be inspected). Every
 * parse-failed review unit now dumps its final output + message tail to
 * ~/.pi/agent/critic-debug/, pruned to a small cap.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CriticDebugMeta {
	agent: string;
	label?: string;
	model?: string;
	cwd: string;
	parseError: string;
	exitCode?: number;
	stopReason?: string;
	stderr?: string;
}

const MSG_TRUNC = 20_000;

/** Render one parse-failure dump as a readable text document. */
export function formatCriticDebug(meta: CriticDebugMeta, finalOutput: string, messagesTail: unknown[]): string {
	const lines: string[] = [
		`# critic raw dump`,
		`agent: ${meta.agent}`,
		`label: ${meta.label || "(none)"}`,
		`model: ${meta.model ?? "(unknown)"}`,
		`cwd: ${meta.cwd}`,
		`exitCode: ${meta.exitCode ?? "(n/a)"}  stopReason: ${meta.stopReason ?? "(n/a)"}`,
		`parseError: ${meta.parseError}`,
	];
	if (meta.stderr) lines.push(`stderr: ${meta.stderr.slice(0, 2000)}`);
	lines.push("", `## final output (${finalOutput.length} chars)`, finalOutput || "(empty)");
	lines.push("", `## last ${messagesTail.length} message(s)`);
	for (const m of messagesTail) {
		let s: string;
		try {
			s = JSON.stringify(m);
		} catch {
			s = String(m);
		}
		lines.push(s.length > MSG_TRUNC ? `${s.slice(0, MSG_TRUNC)} …[truncated ${s.length - MSG_TRUNC} chars]` : s);
	}
	return lines.join("\n");
}

/**
 * One-turn verdict recovery: a critic that worked for a long time and then
 * ended WITHOUT the fenced verdict block gets a single cheap retry — same
 * agent (its system prompt carries the verdict contract), no re-review, no
 * tools, just "turn this analysis into the verdict block". The analysis is
 * tail-truncated: findings conclusions cluster at the end of long outputs.
 * A failed recovery leaves the original fail-closed parse error — recovery
 * can rescue work, never rubber-stamp it.
 */
export function buildVerdictRecoveryTask(finalOutput: string, maxChars = 48_000): string {
	const truncated = finalOutput.length > maxChars;
	const body = truncated ? finalOutput.slice(-maxChars) : finalOutput;
	return (
		"Your previous review run produced the analysis below but ended WITHOUT the fenced verdict JSON block your instructions require.\n\n" +
		"Do NOT redo the review. Do NOT use any tools. Based solely on the analysis below, end your reply with the fenced verdict JSON block " +
		"described in your instructions — findings and severities exactly as the analysis supports them, nothing written after the block. " +
		"If the analysis reaches no clear conclusion, emit a failed verdict saying so.\n\n" +
		`--- your analysis${truncated ? ` (start …[analysis truncated: showing the last ${maxChars} chars])` : ""} ---\n` +
		body
	);
}

let seq = 0;

/**
 * Write a dump into `dir` (created on demand), prune the dir to the newest
 * `cap` files, and return the written path — or null on any error (a debug
 * dump must never break a critique).
 */
export function writeCriticDebug(
	dir: string,
	meta: CriticDebugMeta,
	finalOutput: string,
	messagesTail: unknown[],
	cap = 30,
): string | null {
	try {
		mkdirSync(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const label = meta.label ? `-${meta.label.replace(/[^\w.-]+/g, "_")}` : "";
		const file = join(dir, `${stamp}-${String(seq++).padStart(3, "0")}-${meta.agent}${label}.txt`);
		writeFileSync(file, formatCriticDebug(meta, finalOutput, messagesTail));
		// Prune oldest beyond the cap (names sort chronologically by construction).
		const names = readdirSync(dir).sort();
		for (const stale of names.slice(0, Math.max(0, names.length - cap))) {
			rmSync(join(dir, stale), { force: true });
		}
		return existsSync(file) ? file : null;
	} catch {
		return null;
	}
}
