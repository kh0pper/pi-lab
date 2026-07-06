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
 *     "maxDiffBytes": 100000,
 *     "modelCard": true,              // auto-critique: card to pick the critic model
 *     "cardModels": ["crow-local-27b/qwen3.6-27b", "..."],
 *     "modelCardTimeoutSec": 45,      // card auto-picks Default after this
 *     "diverseModel": "crow-local-27b/qwen3.6-27b",
 *     "recallProbeEvery": 0,          // every Nth AUTO critique re-run code-critic on diverseModel (0=off)
 *     "fixDispatch": "chain",         // "chain" (default) | "message" (legacy single turn) | "off" (no send-findings offer)
 *     "fixMaxClusters": 6,            // cap on fixer-leg clusters; smallest merged beyond the cap
 *     "fixModel": "crow-local/qwen3.6-35b-a3b"  // optional override; default is the fixer agent's own model
 *   }
 *
 * Fix-review mode: every critique persists its findings per-cwd
 * (~/.pi/agent/critic-last-findings.json). When a new critique starts and the
 * last one FAILED (<4h, overlapping files), the artifact gains the original
 * findings verbatim, an invariant-restatement instruction, and the FULL
 * current contents of the overlapping files — a fix is judged against the
 * violated invariant, not the finding's wording, and never against diff
 * hunks alone.
 *
 * Subsystem review: a project may declare flows whose correctness spans files
 * in .pi/critique.json:
 *   { "subsystems": { "sync": { "globs": ["src/lib/**\/sync*.ts"],
 *                               "invariants": ["no update may be lost", ...] } } }
 * When changed files match a subsystem's globs, critics are instructed to
 * read ALL of the subsystem's files and verify the invariants end-to-end.
 *
 * Local critic models: when a model override names a managed local model
 * (settings.localModels) that isn't running, it is started (evicting the
 * loaded one per lab policy) and the previously running model is restored
 * in the background afterwards.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
// plain ESM shared with the hub/web UI — start/stop managed llama.cpp servers
import { isRunning, readLocalModels, startModel } from "../../lib/local-models.mjs";
import { raceWithPhone } from "../shared/remote-ask.js";
import { discoverAgents } from "../subagent/agents.js";
import { selectSiblings } from "./context.js";
import { buildVerdictRecoveryTask, writeCriticDebug } from "./debug.js";
import { dispatchFixChain } from "./fix-dispatch.js";
import type { FindingRef } from "./cluster.js";
import { applyRefutations, parseRefuterVerdict, REFUTER_INSTRUCTION, resolveRefuteModel, type RefutableFinding } from "./refute.js";
import {
	getFinalOutput,
	mapWithConcurrencyLimit,
	runSingleAgent,
	type SingleResult,
	type SubagentDetails,
} from "../subagent/run.js";

const TELEMETRY_PATH = resolve(homedir(), ".pi", "agent", "critic-telemetry.jsonl");
const LAST_FINDINGS_PATH = resolve(homedir(), ".pi", "agent", "critic-last-findings.json");

interface CriticConfig {
	enabled?: boolean;
	agents?: string[];
	baseRef?: string;
	maxDiffBytes?: number;
	/** Auto-run when a plan finishes executing (default true). */
	auto?: boolean;
	/** Model used when invoked as "/critique frontier". */
	frontierModel?: string;
	/** Show a model-picker card when auto-critique fires (default true). */
	modelCard?: boolean;
	/** provider/id choices on the card besides "Default bindings". */
	cardModels?: string[];
	/** Seconds before the card auto-picks Default (default 45). */
	modelCardTimeoutSec?: number;
	/** Diverse local model for recall probes and the default card list. */
	diverseModel?: string;
	/** Every Nth critique, re-run code-critic on diverseModel (0 = off). */
	recallProbeEvery?: number;
	/** Extra pathspecs (git `:(exclude)` globs) to drop from the reviewed diff. */
	excludeGlobs?: string[];
	/** Include same-directory sibling files as critic context (default true). */
	siblingContext?: boolean;
	/** Byte budget for inlined sibling contents in single-artifact mode. */
	siblingMaxBytes?: number;
	/** Adversarial refute-pass on blockers (default true). */
	refutePass?: boolean;
	/** Model the refuter runs on (default: a model different from the main critique). */
	refuteModel?: string;
	/** Max blockers refuted per run (beyond this they stand). */
	refuteMax?: number;
	/** Fix-dispatch mode for "Send findings": clustered fixer chain, single message, or off. */
	fixDispatch?: "chain" | "message" | "off";
	/** Max fix clusters (smallest merged beyond the cap). */
	fixMaxClusters?: number;
	/** Force this model on the fixer legs (default: the fixer agent's own model). */
	fixModel?: string;
}

/**
 * Lock/generated files a critic should never review — they bloat the diff
 * (a package-lock.json change is thousands of lines) and carry no reviewable
 * intent. Returned as git pathspec-exclude args to append after `-- .`.
 * settings `critic.excludeGlobs` extends this.
 */
const DEFAULT_EXCLUDES = [
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lockb",
	"Cargo.lock",
	"poetry.lock",
	"composer.lock",
	"Gemfile.lock",
	"go.sum",
	"**/*.min.js",
	"**/*.min.css",
	"**/*.map",
	"**/drizzle/meta/**",
	"**/migrations/meta/**",
];

function excludePathspec(cfg: CriticConfig): string[] {
	const globs = [...DEFAULT_EXCLUDES, ...(cfg.excludeGlobs ?? [])];
	return ["--", ".", ...globs.map((g) => `:(exclude)${g}`)];
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
	/** Verdict came from the one-turn recovery retry, not the original run. */
	recovered?: boolean;
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
	source: "manual" | "auto" | "tournament" | "probe";
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
		/** Resolved model the critic actually ran on (recall-gap analysis). */
		model?: string;
		/** Blockers of THIS agent's verdict knocked down by the refute-pass. */
		blockersRefuted?: number;
		/** Verdict came from the one-turn recovery retry (watch this rate). */
		recovered?: boolean;
	}>;
	/** Wall-clock of the whole critiqueArtifact call (all units + recoveries). */
	durationMs?: number;
	agree: boolean;
	userSentFindings: boolean | null;
	prior: { ts: number; passed: boolean; filesOverlap: number } | null;
	changedFiles?: string[];
	/** Blockers the refute-pass knocked down (downgraded to warn). */
	refuted?: Array<{ agent: string; detail: string; reason: string }>;
	tournamentId?: string;
	pickedWinner?: boolean;
	/** True when the artifact carried fix-review context (prior failed run). */
	fixReview?: boolean;
	/** Subsystem names (.pi/critique.json) whose globs matched this diff. */
	subsystems?: string[];
	/** For source:"probe" rows: ts of the main-run row this probe shadows. */
	probeOf?: number;
}

/** Find the most recent same-cwd row within 4h for outcome linkage. */
function findPrior(cwd: string, changedFiles: string[]): CritiqueTelemetryRow["prior"] {
	try {
		const lines = readFileSync(TELEMETRY_PATH, "utf8").trim().split("\n");
		for (let i = lines.length - 1; i >= 0 && i >= lines.length - 200; i--) {
			const row = JSON.parse(lines[i]) as CritiqueTelemetryRow;
			if (row.cwd !== cwd) continue;
			if (row.source === "probe") continue; // probes shadow a main run — never a prior
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
// Fix-review sidecar — last critique's findings per cwd. A failed run's
// findings become mandatory context for the next run over the same files:
// the fix is judged against the violated invariant, in full-file context.
// ---------------------------------------------------------------------------

interface LastFindings {
	ts: number;
	ref: string;
	changedFiles: string[];
	passed: boolean;
	findings: Array<{ agent: string; category?: string; severity?: string; detail?: string }>;
}

function loadLastFindings(cwd: string): LastFindings | null {
	try {
		const map = JSON.parse(readFileSync(LAST_FINDINGS_PATH, "utf8")) as Record<string, LastFindings>;
		return map[cwd] ?? null;
	} catch {
		return null;
	}
}

function saveLastFindings(cwd: string, entry: LastFindings): void {
	try {
		let map: Record<string, LastFindings> = {};
		if (existsSync(LAST_FINDINGS_PATH)) {
			try {
				map = JSON.parse(readFileSync(LAST_FINDINGS_PATH, "utf8")) as Record<string, LastFindings>;
			} catch {
				map = {};
			}
		}
		map[cwd] = entry;
		writeFileSync(LAST_FINDINGS_PATH, JSON.stringify(map, null, 1));
	} catch {
		// best-effort
	}
}

/**
 * Build the FIX-REVIEW artifact section, or "" when not applicable.
 * `includeFullFiles` inlines the overlapping files' full current contents (a
 * fix judged against the whole file, not hunks). Pass FALSE in fan-out mode:
 * the note is appended to every chunk, so inlining files there multiplies a
 * ~96KB payload by the chunk count (measured: a fanned-out fix-review task hit
 * 470KB / ~117k tokens and stalled the local model for hours). In fan-out the
 * chunks already carry the diffs and critics read files with their tools.
 */
function buildFixReviewNote(cwd: string, changedFiles: string[], includeFullFiles: boolean): string {
	const last = loadLastFindings(cwd);
	if (!last || last.passed || Date.now() - last.ts > 4 * 3600_000) return "";
	const overlap = last.changedFiles.filter((f) => changedFiles.includes(f));
	if (overlap.length === 0 || last.findings.length === 0) return "";

	const mins = Math.round((Date.now() - last.ts) / 60000);
	const findingsText = last.findings
		.map((f) => `- [${f.severity ?? "?"}/${f.category ?? "?"}] (${f.agent}) ${f.detail ?? ""}`)
		.join("\n");

	// Full current contents of the overlapping files — a fix must be judged
	// against the whole file, never the diff hunks alone. Bounded inline;
	// oversized files fall back to a read-it-yourself pointer. Binary assets
	// (images, fonts, …) are skipped: inlining them is useless to a critic and
	// their bytes carry NULs that break child-process argv.
	const BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|avif|bmp|woff2?|ttf|otf|eot|wasm|gz|zip|pdf|mp[34]|mov|webm|db|sqlite)$/i;
	let filesBlock = "";
	let total = 0;
	if (!includeFullFiles) {
		filesBlock = `\n(Read the current contents of these files with your tools — they are: ${overlap.join(", ")})\n`;
	}
	for (const f of includeFullFiles ? overlap : []) {
		if (BINARY_EXT.test(f)) {
			filesBlock += `\n--- ${f} (binary asset — not inlined) ---\n`;
			continue;
		}
		try {
			const body = readFileSync(resolve(cwd, f), "utf8");
			if (body.includes("\u0000")) {
				filesBlock += `\n--- ${f} (binary content — not inlined) ---\n`;
				continue;
			}
			if (body.length > 48_000 || total + body.length > 96_000) {
				filesBlock += `\n--- ${f} (too large to inline — read it with your tools) ---\n`;
				continue;
			}
			total += body.length;
			filesBlock += `\n--- ${f} ---\n\`\`\`\n${body}\n\`\`\`\n`;
		} catch {
			filesBlock += `\n--- ${f} (deleted or unreadable) ---\n`;
		}
	}

	return (
		`\n\nFIX-REVIEW: a critique of this working tree FAILED ${mins} minutes ago and the current change is expected to address it. Original findings:\n${findingsText}\n\n` +
		`For EACH original finding: (1) restate the underlying invariant in one line; (2) enumerate the failure paths (network error, HTTP error status, partial failure, concurrent actor, boundary values) and verify each against the CURRENT code below, not just the changed lines; (3) search the touched files for OTHER violations of the same invariant. A fix that matches the finding's wording but not the invariant is a blocker.\n` +
		`For any finding whose invariant is mechanically testable, a fix WITHOUT an accompanying regression test that would fail against the old behavior is at least a warn (a fix you cannot prove stays fixed): say what test is missing and the exact old-behavior input it must reject.\n` +
		`\nFull current contents of the files under fix-review:\n${filesBlock}`
	);
}

// ---------------------------------------------------------------------------
// Subsystem review — project-declared multi-file flows (.pi/critique.json).
// ---------------------------------------------------------------------------

interface SubsystemDef {
	globs?: string[];
	invariants?: string[];
}

function loadSubsystems(cwd: string): Record<string, SubsystemDef> {
	try {
		const raw = JSON.parse(readFileSync(resolve(cwd, ".pi", "critique.json"), "utf8")) as {
			subsystems?: Record<string, SubsystemDef>;
		};
		return raw.subsystems ?? {};
	} catch {
		return {};
	}
}

/** Minimal glob→regex: ** crosses directories, * stays within one, ? one char. */
function globToRegExp(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "\u0001")
		.replace(/\*/g, "[^/]*")
		.replace(/\u0001/g, ".*")
		.replace(/\?/g, "[^/]");
	return new RegExp(`^${escaped}$`);
}

/** Subsystem artifact section + matched names. lsFiles = repo file list. */
function buildSubsystemNote(
	subsystems: Record<string, SubsystemDef>,
	changedFiles: string[],
	lsFiles: string[],
): { note: string; names: string[] } {
	let note = "";
	const names: string[] = [];
	for (const [name, def] of Object.entries(subsystems)) {
		const regs = (def.globs ?? []).map(globToRegExp);
		if (regs.length === 0) continue;
		if (!regs.some((re) => changedFiles.some((f) => re.test(f)))) continue;
		names.push(name);
		const members = lsFiles.filter((f) => regs.some((re) => re.test(f)));
		note +=
			`\n\nSUBSYSTEM REVIEW — this change touches the "${name}" subsystem. Its correctness spans ALL of these files; read every one with your tools (the diff alone is insufficient):\n` +
			members.map((m) => `- ${m}`).join("\n") +
			"\n" +
			(def.invariants?.length
				? `Verify these invariants hold END-TO-END across the flow; each violation is a finding:\n${def.invariants.map((s) => `- ${s}`).join("\n")}\n`
				: "");
	}
	return { note, names };
}

// ---------------------------------------------------------------------------
// Oversized-diff chunking — split a unified diff into per-file sections and
// greedily pack them into chunks under maxBytes, so every changed file's real
// diff gets inlined for a critic instead of the old "read it yourself" degrade.
// ---------------------------------------------------------------------------

function splitDiffByFile(diff: string): Array<{ file: string; text: string }> {
	const out: Array<{ file: string; text: string }> = [];
	// Each file section starts at a "diff --git a/… b/…" line.
	const parts = diff.split(/(?=^diff --git )/m).filter((s) => s.trim());
	for (const text of parts) {
		const m = text.match(/^diff --git a\/(.+?) b\/(.+?)(?:\n|$)/);
		out.push({ file: m ? m[2] : "(unknown)", text });
	}
	return out;
}

/** Greedy-pack file sections into <= maxBytes chunks. A single file whose diff
 *  alone exceeds maxBytes is TRUNCATED (with a marker) rather than blowing the
 *  chunk — a generated/vendored file that slipped past the exclude list should
 *  never balloon one critic task to 100k+ tokens. */
function packDiffChunks(diff: string, maxBytes: number): Array<{ files: string[]; text: string }> {
	const sections = splitDiffByFile(diff);
	const chunks: Array<{ files: string[]; text: string }> = [];
	let cur: { files: string[]; text: string } | null = null;
	for (const s of sections) {
		let text = s.text;
		if (Buffer.byteLength(text, "utf8") > maxBytes) {
			text = `${text.slice(0, maxBytes)}\n… [${s.file} diff truncated at ${maxBytes} bytes — read the full file with your tools]\n`;
		}
		const size = Buffer.byteLength(text, "utf8");
		if (cur && Buffer.byteLength(cur.text, "utf8") + size > maxBytes) {
			chunks.push(cur);
			cur = null;
		}
		if (!cur) cur = { files: [], text: "" };
		cur.files.push(s.file);
		cur.text += text;
	}
	if (cur) chunks.push(cur);
	return chunks;
}

// ---------------------------------------------------------------------------
// Local critic models — start a managed local model for the critics and
// restore whatever was running afterwards (lab policy: one local model at a
// time; every managed model evicts the others).
// ---------------------------------------------------------------------------

async function findRunningManaged(): Promise<string | null> {
	for (const ref of Object.keys(readLocalModels())) {
		if (await isRunning(ref)) return ref;
	}
	return null;
}

type Notify = (message: string, severity?: "info" | "warning" | "error") => void;

/**
 * Ensure `ref` is serving if it's a managed local model (no-op for cloud /
 * unmanaged refs). Returns a restore closure when a DIFFERENT managed model
 * had to be swapped out — call it after the critics finish; it restarts the
 * previous model in the background so the session's own model comes back.
 */
async function ensureCriticModel(ref: string, notify: Notify): Promise<(() => void) | null> {
	const managed = readLocalModels() as Record<string, unknown>;
	if (!managed[ref]) return null;
	if (await isRunning(ref)) return null;
	const prev = await findRunningManaged();
	notify(`Starting ${ref} for the critics${prev ? ` (swapping out ${prev})` : ""} — big models take a few minutes…`);
	await startModel(ref, {
		onProgress: (stage: string) => {
			if (stage.startsWith("stopping:")) notify(`Freeing RAM: stopping ${stage.slice(9)}`);
		},
	});
	if (!prev || prev === ref) return null;
	return () => {
		notify(`Critics done on ${ref} — restoring ${prev} in the background (local turns may fail until it's up)…`);
		void startModel(prev).then(
			() => notify(`${prev} is back up.`),
			(err: unknown) =>
				notify(`Failed to restore ${prev}: ${String((err as Error)?.message ?? err)} — run /serve ${prev}`, "error"),
		);
	};
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
	source: "manual" | "auto" | "tournament" | "probe";
	criticNames?: string[];
	modelOverride?: string;
	/**
	 * Oversized-diff fan-out: when set, EACH critic runs once per chunk (with
	 * that chunk's real inline diff) instead of once on `artifact`; the per-chunk
	 * verdicts are merged per critic. This replaces the old "diff too large —
	 * read the files yourself" degrade, where coverage depended on which files
	 * the model chose to open (the life post-mortem's framework-semantics misses
	 * were all in unopened files). `artifact` is ignored when chunks are present;
	 * `specNote` still appends to every chunk. Shared context (subsystem
	 * invariants, fix-review) should be baked into each chunk body by the caller.
	 */
	chunks?: Array<{ label: string; body: string }>;
	/** Telemetry fields */
	ref?: string;
	changedFiles?: string[];
	diffStats?: CritiqueTelemetryRow["diff"];
}

export interface CritiqueOutcome {
	// (no allPassed here: refutations can flip verdicts after critiqueArtifact
	// returns — consumers recompute from post-refute verdicts, like runCritique's
	// allPassedFinal, instead of trusting a pre-refute snapshot.)
	verdicts: Array<{ agent: string; verdict: Verdict; raw: string; model?: string }>;
	row: CritiqueTelemetryRow;
}

export async function critiqueArtifact(p: CritiqueArtifactParams): Promise<CritiqueOutcome | { missing: string[] }> {
	const startedAt = Date.now();
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

	// One critic run on one artifact body → a parsed verdict + raw output.
	// NUL-strip the task: the child pi is spawned with the task as an argv
	// element, and Node rejects argv containing NUL. Binary content
	// can leak in via inlined file contents (fix-review) or a diff hunk; a NUL
	// is never meaningful to a critic, so dropping it is safe.
	const runOne = async (name: string, body: string, label: string) => {
		const task = `${body}${p.specNote ?? ""}${verdictReminder}`.replace(/\u0000/g, "");
		const r = await runSingleAgent(
			p.cwd, agents, name, task,
			undefined, undefined, undefined, undefined, makeDetails,
		);
		const failed = r.exitCode !== 0 || r.stopReason === "error";
		const finalOutput = getFinalOutput(r.messages);
		let verdict: Verdict = failed
			? { passed: false, findings: [], parseError: r.errorMessage || r.stderr.slice(0, 200) || "critic process failed" }
			: parseVerdict(finalOutput);
		let raw = finalOutput;
		if (verdict.parseError && !failed && finalOutput.trim()) {
			// One-turn verdict recovery: the run completed but drifted past the
			// verdict contract (seen after multi-hour fix-review runs). Hand the
			// SAME agent its own analysis and ask for just the fenced block —
			// tightly budgeted; a failed recovery leaves the fail-closed error.
			try {
				const r2 = await runSingleAgent(
					p.cwd, agents, name, buildVerdictRecoveryTask(finalOutput),
					undefined, undefined, undefined, undefined, makeDetails, undefined, 4,
				);
				if (r2.exitCode === 0 && r2.stopReason !== "error") {
					const v2 = parseVerdict(getFinalOutput(r2.messages));
					if (!v2.parseError) {
						verdict = { ...v2, recovered: true };
						raw = `${finalOutput}\n\n[verdict recovered by one-turn retry]\n${getFinalOutput(r2.messages)}`;
					}
				}
			} catch {
				// recovery is best-effort; the original parse error stands
			}
		}
		if (verdict.parseError) {
			// Fail-closed is correct but was undiagnosable: persist the raw output
			// so a critic that worked for hours and emitted no verdict can be
			// inspected (2026-07-06 fix-review run: both critics, nothing to read).
			const dump = writeCriticDebug(
				resolve(homedir(), ".pi", "agent", "critic-debug"),
				{
					agent: name, label, model: r.model, cwd: p.cwd,
					parseError: verdict.parseError, exitCode: r.exitCode,
					stopReason: r.stopReason, stderr: failed ? r.stderr : undefined,
				},
				finalOutput,
				(r.messages as unknown[]).slice(-6),
			);
			if (dump) verdict.parseError += ` [raw: ${dump}]`;
		}
		return { agent: name, label, verdict, raw, model: r.model };
	};

	// Fan-out unit list: one per (critic × chunk), or one per critic on the
	// whole artifact. Concurrency-capped so a chunked run doesn't fire dozens
	// of pi processes at the single local model slot at once.
	const units = p.chunks?.length
		? criticNames.flatMap((name) => p.chunks!.map((c) => ({ name, body: c.body, label: c.label })))
		: criticNames.map((name) => ({ name, body: p.artifact, label: "" }));
	const partials = await mapWithConcurrencyLimit(units, 4, (u) => runOne(u.name, u.body, u.label));

	// Merge per critic: passed = every chunk passed; findings concatenated
	// (chunk-labelled when fanned out); parseError surfaced if any chunk failed
	// to yield a verdict (that chunk already counts as failed/fail-closed).
	const verdicts = criticNames.map((name) => {
		const mine = partials.filter((x) => x.agent === name);
		const multi = (p.chunks?.length ?? 0) > 1;
		const findings = mine.flatMap((x) =>
			x.verdict.findings.map((f) => (multi && x.label ? { ...f, detail: `[${x.label}] ${f.detail ?? ""}` } : f)),
		);
		const parseErrs = mine.filter((x) => x.verdict.parseError);
		const verdict: Verdict = {
			passed: mine.every((x) => x.verdict.passed),
			findings,
			parseError: parseErrs.length
				? `${parseErrs.length}/${mine.length} review unit(s) produced no verdict: ${parseErrs[0].verdict.parseError}`
				: undefined,
			recovered: mine.some((x) => x.verdict.recovered) || undefined,
		};
		return { agent: name, verdict, raw: mine.map((x) => x.raw).join("\n\n"), model: mine[0]?.model };
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
				model: v.model,
				recovered: v.verdict.recovered,
			};
		}),
		agree: parsed.length < 2 || parsed.every((v) => v.verdict.passed === parsed[0].verdict.passed),
		userSentFindings: null,
		prior: findPrior(p.cwd, p.changedFiles ?? []),
		changedFiles: p.changedFiles,
		durationMs: Date.now() - startedAt,
	};
	return { verdicts, row };
}

/**
 * Refute-pass spawns (1C): one `refuter` run per standing blocker, on agents
 * already forceModel-bound by the caller. Returns raw results for
 * applyRefutations. NO model management here — the caller owns ensure/restore
 * so the refute swap composes with the main critique's restore instead of
 * racing it. Fail-open-to-blocker: an errored refuter yields refuted:false.
 */
async function refuteBlockers(
	cwd: string,
	agents: ReturnType<typeof discoverAgents>["agents"],
	verdicts: CritiqueOutcome["verdicts"],
	taskContext: string,
	refuteMax: number,
	notify: Notify,
): Promise<Array<{ agent: string; finding: RefutableFinding; refuted: boolean; reason: string }>> {
	const targets: Array<{ agent: string; finding: RefutableFinding }> = [];
	for (const v of verdicts) {
		if (v.verdict.passed) continue; // blockers in passed verdicts never gate anything
		for (const f of v.verdict.findings) {
			if (f.severity === "blocker") targets.push({ agent: v.agent, finding: f });
		}
	}
	if (targets.length === 0) return [];
	const capped = targets.slice(0, refuteMax);
	if (targets.length > refuteMax) notify(`Refute-pass: ${targets.length} blockers, refuting first ${refuteMax}`, "info");

	return mapWithConcurrencyLimit(capped, 3, async (t) => {
		const task =
			`A code reviewer raised this BLOCKER. Try to prove it wrong.\n\n[${t.finding.category ?? "?"}] (raised by ${t.agent}) ${t.finding.detail ?? ""}\n` +
			taskContext +
			REFUTER_INSTRUCTION;
		const r = await runSingleAgent(
			cwd, agents, "refuter", task,
			undefined, undefined, undefined, undefined,
			(rs) => ({ mode: "parallel", agentScope: "user", projectAgentsDir: null, results: rs }),
		);
		if (r.exitCode !== 0 || r.stopReason === "error") return { ...t, refuted: false, reason: "" };
		const v = parseRefuterVerdict(getFinalOutput(r.messages));
		return { ...t, refuted: v.refuted, reason: v.reason ?? "" };
	});
}

export default function (pi: ExtensionAPI) {
	// Bot-exclusion invariant: critics spawn subagent processes and (with the
	// refute pass / model card) manage local model servers. Bots have their own
	// policy system; nested subagents must not spawn critics.
	if (process.env["PI_BOT_PERMISSION_POLICY"]) return;
	if (Number(process.env["PIBOT_SUBAGENT_DEPTH"] ?? "0") >= 1) return;

	// Bridge web-dispatched invocations ("command:critique" bus events) — they
	// bypass registerCommand, so capture a ctx and route them to the same logic.
	let lastCtx: ExtensionCommandContext | null = null;
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx as unknown as ExtensionCommandContext;
	});

	// Plan-mode state (mirrors the tournament's tracker): fix-dispatch must not
	// spawn write-capable fixer legs while a read-only plan is active/executing.
	let planState = { enabled: false, executing: false };
	pi.events.on("plan-mode:state", (d) => {
		const s = d as { enabled?: boolean; executing?: boolean };
		planState = { enabled: Boolean(s.enabled), executing: Boolean(s.executing) };
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
			// 160KB ≈ 40k tokens — fits a single inline review in a 256k-context
			// local model, so the critic sees the WHOLE change at once (better
			// cross-file reasoning than chunking). The old 100KB cap predated the
			// @file task path that removed the argv size limit. Fan-out now only
			// triggers for genuinely huge diffs.
			const maxDiffBytes = cfg.maxDiffBytes ?? 160_000;

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

			// Collect the diff (uncommitted vs ref; fall back to last commit when
			// clean). Lock/generated files are excluded — they carry no reviewable
			// intent and a single one (package-lock.json) can dwarf the real change.
			const exArgs = excludePathspec(cfg);
			let diff = (await pi.exec("git", ["diff", ref, ...exArgs], { cwd: ctx.cwd })).stdout;
			let refNote = `vs ${ref}`;
			if (!diff.trim() && ref === "HEAD") {
				ref = "HEAD~1";
				diff = (await pi.exec("git", ["diff", "HEAD~1", ...exArgs], { cwd: ctx.cwd })).stdout;
				refNote = "working tree clean — reviewing last commit (HEAD~1)";
			}
			if (!diff.trim()) {
				ctx.ui.notify("Nothing to critique (empty diff)", "info");
				return;
			}

			const changedFiles = (await pi.exec("git", ["diff", "--name-only", ref, ...exArgs], { cwd: ctx.cwd })).stdout.trim();
			const changedList = changedFiles ? changedFiles.split("\n").filter(Boolean) : [];

			// Optional spec: newest plan artifact if the repo has one (B3 writes these).
			let specNote = "";
			const plansDir = resolve(ctx.cwd, ".pi", "plans");
			if (existsSync(plansDir)) {
				const newest = (await pi.exec("bash", ["-lc", `ls -t '${plansDir}'/*.md 2>/dev/null | head -1`], { cwd: ctx.cwd })).stdout.trim();
				if (newest) specNote = `\n\nSpec/plan document (read it and judge conformance): ${newest}`;
			}

			// Whether the diff will fan out decides how heavy fix-review can be:
			// full-file inline is fine for a single small artifact, but in fan-out
			// it is appended to every chunk (see buildFixReviewNote).
			const oversized = Buffer.byteLength(diff, "utf8") > maxDiffBytes;

			// Fix-review: a failed critique of overlapping files < 4h ago makes this
			// run a re-review — original findings + invariant restatement, plus full
			// file contents when NOT fanning out.
			const fixReviewNote = buildFixReviewNote(ctx.cwd, changedList, !oversized);

			// Repo file list — shared by subsystem, sibling (1B), and refute (1C) stages.
			let repoFiles: string[] = [];
			try {
				repoFiles = (await pi.exec("git", ["ls-files"], { cwd: ctx.cwd })).stdout.trim().split("\n").filter(Boolean);
			} catch {
				// additive context only — never block the critique
			}

			// Subsystem review: project-declared multi-file flows (.pi/critique.json).
			let subsystemNote = "";
			let subsystemNames: string[] = [];
			const subsystems = loadSubsystems(ctx.cwd);
			if (Object.keys(subsystems).length > 0 && changedList.length > 0 && repoFiles.length > 0) {
				try {
					const built = buildSubsystemNote(subsystems, changedList, repoFiles);
					subsystemNote = built.note;
					subsystemNames = built.names;
				} catch {
					// subsystem context is additive — never block the critique on it
				}
			}

			// Sibling-file context (1B): surface same-dir files so cross-file
			// framework behavior (e.g. +page.server.ts next to +page.svelte) is
			// visible. Inline (bounded) only when NOT fanning out; in fan-out the
			// note would multiply per chunk, so emit names only there.
			let siblingNote = "";
			let siblings: string[] = [];
			if (cfg.siblingContext !== false && changedList.length > 0 && repoFiles.length > 0) {
				siblings = selectSiblings(changedList, repoFiles);
				if (siblings.length > 0) {
					if (oversized) {
						siblingNote = `\n\nSibling files in the same directories as the changed files — behavior may span them, read them with your tools: ${siblings.join(", ")}\n`;
					} else {
						const budget = cfg.siblingMaxBytes ?? 40_000;
						let block = "";
						let total = 0;
						for (const f of siblings) {
							try {
								const body = readFileSync(resolve(ctx.cwd, f), "utf8");
								if (body.includes("\u0000") || body.length > 24_000 || total + body.length > budget) {
									block += `\n--- ${f} (read with your tools) ---\n`;
									continue;
								}
								total += body.length;
								block += `\n--- ${f} ---\n\`\`\`\n${body}\n\`\`\`\n`;
							} catch {
								/* skip unreadable */
							}
						}
						siblingNote = `\n\nSibling files in the same directories as the changed files — behavior may span them:\n${block}`;
					}
				}
			}

			// Auto-critique model card: pick which model the critics run on
			// (default bindings / diverse local / frontier). Races phone + TUI;
			// auto-picks Default after the countdown so unattended runs proceed.
			if (source === "auto" && !modelOverride && cfg.modelCard !== false && ctx.hasUI) {
				modelOverride = await pickCriticModel(ctx, cfg);
			}

			// Shared context every critic must see regardless of how the diff is
			// carved up (subsystem invariants + fix-review findings/files).
			const sharedNote = subsystemNote + siblingNote + fixReviewNote;

			// Oversized → fan out: pack per-file diffs into byte-bounded chunks so
			// EVERY changed file's real diff is inlined for a critic (no more
			// "read the files yourself", where unopened files went unreviewed).
			let chunks: Array<{ label: string; body: string }> | undefined;
			if (oversized) {
				const packed = packDiffChunks(diff, maxDiffBytes);
				if (packed.length > 1) {
					chunks = packed.map((c, i) => ({
						label: `part ${i + 1}/${packed.length}`,
						body:
							`Unified diff (${refNote}) — PART ${i + 1} of ${packed.length} (the change was split by file to fit; review THIS part's files fully, and read any others you need with your tools):\n` +
							`Files in this part: ${c.files.join(", ")}\n\n\`\`\`diff\n${c.text}\n\`\`\`` +
							sharedNote,
					}));
				}
			}

			const artifact =
				(oversized
					? `The diff is too large to inline (> ${maxDiffBytes} bytes). Changed files (${refNote}):\n${changedFiles}\n\nRun \`git diff ${ref} -- <file>\` yourself per file and review every change.`
					: `Unified diff (${refNote}):\n\n\`\`\`diff\n${diff}\n\`\`\``) +
				sharedNote;

			// Session's managed local model, captured BEFORE any critic/refute swap,
			// so fix-dispatch can restore to it deterministically (never to a
			// transient mid-reload model). null when the session isn't on a managed
			// local (cloud model → nothing to restore; local slot is free game).
			const sessionLocalModel = await findRunningManaged();

			// Managed local model overrides may need their server started (and the
			// previously loaded model restored afterwards — one local at a time).
			let restoreModel: (() => void) | null = null;
			if (modelOverride) {
				try {
					restoreModel = await ensureCriticModel(modelOverride, (m, s) => ctx.ui.notify(m, s));
				} catch (err) {
					ctx.ui.notify(
						`Could not start ${modelOverride}: ${String((err as Error)?.message ?? err)} — falling back to default critic bindings`,
						"warning",
					);
					modelOverride = undefined;
				}
			}

			ctx.ui.notify(
				`Running ${criticNames.length} critics on the diff (${refNote})${modelOverride ? ` on ${modelOverride}` : ""}${chunks ? ` [fan-out: ${chunks.length} parts]` : ""}${fixReviewNote ? " [fix-review]" : ""}${subsystemNames.length ? ` [subsystem: ${subsystemNames.join(", ")}]` : ""}…`,
				"info",
			);

			// diff stats for telemetry (cheap numstat alongside the existing calls)
			let diffStats: CritiqueTelemetryRow["diff"] = null;
			try {
				const numstat = (await pi.exec("git", ["diff", "--numstat", ref, ...exArgs], { cwd: ctx.cwd })).stdout.trim();
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

			let outcome: CritiqueOutcome | { missing: string[] } | undefined;
			try {
				outcome = await critiqueArtifact({
					cwd: ctx.cwd,
					artifact,
					chunks,
					specNote,
					source,
					criticNames,
					modelOverride,
					ref,
					changedFiles: changedList,
					diffStats,
				});

				// ---- Refute-pass (1C): disprove blockers on a DIFFERENT model ----
				// Runs INSIDE this try so the composed restore below fires after it,
				// but in its OWN try/catch: the refute stage is additive — an
				// unexpected failure degrades to "blockers stand", never discards
				// the completed critique (no verdict message / telemetry lost).
				try {
					if (cfg.refutePass !== false && outcome && !("missing" in outcome)) {
						// Only blockers in FAILED verdicts matter — a blocker-severity
						// finding inside a passed:true verdict violates the critic
						// contract and never gates anything downstream.
						const hasBlockers = outcome.verdicts.some(
							(v) => !v.verdict.passed && v.verdict.findings.some((f) => f.severity === "blocker"),
						);
						if (hasBlockers) {
							// The model the critics ACTUALLY ran on (respects /agent-models
							// re-binds), not a guess. Null when unknown — resolveRefuteModel
							// then can't check diversity and just takes configured/diverse.
							const mainModel = outcome.verdicts.find((v) => v.model)?.model ?? modelOverride ?? null;
							const refuteModel = resolveRefuteModel({
								mainModel,
								configured: cfg.refuteModel,
								diverse: cfg.diverseModel ?? "crow-local-27b/qwen3.6-27b",
								managedRefs: Object.keys(readLocalModels() as Record<string, unknown>),
							});

							let refuteReady = refuteModel !== null;
							if (!refuteReady) {
								ctx.ui.notify(
									`Refute-pass skipped: no model distinct from the critics' (${mainModel ?? "unknown"}) — set critic.refuteModel or add a second entry to settings.localModels.`,
									"warning",
								);
							} else {
								ctx.ui.notify(`Refute-pass: challenging blockers on ${refuteModel}…`, "info");
								try {
									const r2 = await ensureCriticModel(refuteModel!, (m, s) => ctx.ui.notify(m, s));
									// Compose restores: the FIRST non-null closure points at the
									// true original model; discard later ones.
									if (!restoreModel) restoreModel = r2;
								} catch (err) {
									ctx.ui.notify(
										`Refute-pass skipped: could not start ${refuteModel}: ${String((err as Error)?.message ?? err)}`,
										"warning",
									);
									refuteReady = false; // actually skip — do NOT spawn refuters at a dead model
								}
							}
							const discovered = refuteReady ? discoverAgents(ctx.cwd, "user").agents : [];
							if (refuteReady && !discovered.some((a) => a.name === "refuter")) {
								ctx.ui.notify("refuter agent missing (run scripts/install-bridges.sh) — skipping refute-pass", "warning");
								refuteReady = false;
							}
							if (refuteReady) {
								const refAgents = discovered.map((a) => (a.name === "refuter" ? { ...a, forceModel: refuteModel! } : a));
								const taskContext =
									`\nThe change under review (${refNote}) touches these files: ${changedList.join(", ")}` +
									(siblings.length ? `\nSibling files you may read: ${siblings.join(", ")}` : "") +
									(subsystemNames.length ? `\nDeclared subsystems in play: ${subsystemNames.join(", ")}` : "");
								const results = await refuteBlockers(
									ctx.cwd, refAgents, outcome.verdicts, taskContext, cfg.refuteMax ?? 8,
									(m, s) => ctx.ui.notify(m, s),
								);
								const refuted = applyRefutations(outcome.verdicts, results);
								if (refuted.length > 0) {
									const row = outcome.row;
									row.refuted = refuted;
									// Recompute per-verdict telemetry from post-refute findings.
									for (const rv of row.verdicts) {
										const v = outcome.verdicts.find((x) => x.agent === rv.agent);
										if (!v) continue;
										const blockers = v.verdict.findings.filter((f) => f.severity === "blocker");
										rv.blockersRefuted = refuted.filter((r) => r.agent === rv.agent).length;
										rv.blockers = blockers.length;
										rv.warns = v.verdict.findings.length - blockers.length;
										rv.passed = v.verdict.passed;
										rv.firstBlocker = blockers[0]?.detail?.slice(0, 200);
									}
									const parsed = outcome.verdicts.filter((v) => !v.verdict.parseError);
									row.agree = parsed.length < 2 || parsed.every((v) => v.verdict.passed === parsed[0].verdict.passed);
								}
							}
						}
					}
				} catch (err) {
					ctx.ui.notify(
						`Refute-pass failed (blockers stand): ${String((err as Error)?.message ?? err)}`,
						"warning",
					);
				}
			} finally {
				// Single composed restore — after critique AND refute-pass, before
				// the interactive confirm below (no agent turn can race the swap).
				restoreModel?.();
			}
			if (!outcome) return;
			if ("missing" in outcome) {
				ctx.ui.notify(`Missing critic agents: ${outcome.missing.join(", ")} (run scripts/install-bridges.sh)`, "error");
				return;
			}
			const { verdicts, row } = outcome;
			// Post-refute state: refutations may have flipped verdicts. Parse-error
			// verdicts can never pass (applyRefutations enforces it).
			const allPassedFinal = verdicts.every((v) => v.verdict.passed);
			if (fixReviewNote) row.fixReview = true;
			if (subsystemNames.length > 0) row.subsystems = subsystemNames;

			// Persist findings for the NEXT run's fix-review detection (a passed
			// run clears the failed state). EXCEPTION: a run in which EVERY
			// verdict parse-errored carries no review information — saving its
			// empty findings would wipe a prior failed run's sidecar and disarm
			// fix-review (2026-07-06: a double-parse-error round erased the
			// drain-race finding the next round needed). Keep the prior state.
			const allParseErrors = verdicts.length > 0 && verdicts.every((v) => v.verdict.parseError);
			if (!allParseErrors) {
				saveLastFindings(ctx.cwd, {
					ts: row.ts,
					ref,
					changedFiles: changedList,
					passed: allPassedFinal,
					findings: verdicts.flatMap((v) =>
						v.verdict.findings
							.filter((f) => !(f as RefutableFinding).refuted)
							.map((f) => ({ agent: v.agent, ...f })),
					),
				});
			}
			const lines: string[] = [`**Critique ${allPassedFinal ? "PASSED ✓" : "FAILED ✗"}** (${refNote})`, ""];
			for (const v of verdicts) {
				const icon = v.verdict.passed ? "✓" : "✗";
				lines.push(
					`${icon} **${v.agent}**${v.verdict.recovered ? " (verdict recovered by one-turn retry)" : ""}${v.verdict.parseError ? ` — ${v.verdict.parseError} (fail-closed)` : ""}`,
				);
				for (const f of v.verdict.findings) {
					lines.push(`  - [${f.severity ?? "?"}/${f.category ?? "?"}] ${f.detail ?? ""}`);
				}
				if (v.verdict.findings.length === 0 && !v.verdict.parseError) lines.push("  - no findings");
			}
			if (row.refuted && row.refuted.length > 0) {
				lines.push("", `**Refuted → downgraded to warn** (${row.refuted.length}):`);
				for (const r of row.refuted) lines.push(`  - (${r.agent}) ${r.detail.slice(0, 160)} — ${r.reason}`);
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
				passed: allPassedFinal,
				verdicts: row.verdicts,
				changedFiles: row.changedFiles ?? [],
				handled: false,
			};
			pi.events.emit("pi-lab:critique-verdict", busPayload);

			// `fixDispatch: "off"` disables the fix offer entirely — the verdict was
			// already displayed above; skip the "send to the agent?" confirm so
			// neither a chain dispatch nor a message is triggered (userSentFindings
			// stays null). "chain" (default) and "message" both still offer it.
			if (!allPassedFinal && ctx.hasUI && !busPayload.handled && (cfg.fixDispatch ?? "chain") !== "off") {
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
					const failedVerdicts = verdicts.filter((v) => !v.verdict.passed);
					const findingsText = failedVerdicts
						.map(
							(v) =>
								`${v.agent}:\n${v.verdict.findings.map((f) => `- [${f.severity}/${f.category}] ${f.detail}`).join("\n") || v.verdict.parseError}`,
						)
						.join("\n\n");
					const sendMessageFallback = () =>
						pi.sendUserMessage(
							`Independent critics reviewed the current diff and found blocking issues. Address each one (or explain why it's wrong):\n\n${findingsText}`,
						);

					const mode = cfg.fixDispatch ?? "chain";
					pi.events.emit("plan-mode:get", {}); // refresh planState
					const planActive = planState.enabled || planState.executing;

					if (mode === "message" || planActive) {
						if (planActive && mode === "chain") {
							ctx.ui.notify(
								"Fix-dispatch: plan mode active — sending findings as a message instead of spawning fixer legs.",
								"info",
							);
						}
						sendMessageFallback();
					} else {
						// mode === "chain" (default). Cluster the failed verdicts' findings
						// and dispatch one fixer leg per cluster. Fall back to the message
						// path if there is nothing to dispatch (e.g. no fixer agent).
						const findings: FindingRef[] = failedVerdicts.flatMap((v) =>
							v.verdict.findings.map((f) => ({ agent: v.agent, severity: f.severity, category: f.category, detail: f.detail })),
						);
						try {
							const outcome = await dispatchFixChain({
								cwd: ctx.cwd,
								findings,
								subsystems,
								changedFiles: changedList,
								maxClusters: cfg.fixMaxClusters ?? 6,
								fixModel: cfg.fixModel,
								sessionModel: sessionLocalModel,
								notify: (m, s) => ctx.ui.notify(m, s),
							});
							if (!outcome.dispatched) {
								ctx.ui.notify(`Fix-dispatch fell back to a message: ${outcome.reason}`, "warning");
								sendMessageFallback();
							} else if (outcome.error) {
								ctx.ui.notify(
									`Fix-dispatch: cluster ${outcome.error.stepNo} (${outcome.error.agentName}) failed — review the working tree; the next /critique will judge the fixes.`,
									"warning",
								);
							} else {
								ctx.ui.notify(
									`Fix-dispatch: ${outcome.results.length} fixer leg(s) completed over ${outcome.clusters} cluster(s). Legs are fail-open — run /critique to judge whether the findings are actually fixed.`,
									"info",
								);
							}
						} catch (err) {
							ctx.ui.notify(
								`Fix-dispatch errored (${String((err as Error)?.message ?? err)}) — sending findings as a message.`,
								"warning",
							);
							sendMessageFallback();
						}
					}
				}
			}
			// Append AFTER the confirm (userSentFindings is the human label);
			// passed / no-UI / handled paths append with null immediately.
			appendCritiqueTelemetry(row);

			// Recall probe (opt-in): every Nth AUTO critique, shadow it with
			// code-critic on the diverse local model over the SAME artifact.
			// Cross-model disagreement on identical inputs is the recall-gap
			// signal the tournament.auto flip criteria need.
			//
			// AUTO-ONLY and never after send-findings, because the lab has ONE
			// local model slot: the probe must EVICT the session's model to load
			// the diverse one, so it can only run when the session is idle. An
			// auto-critique fires right after a plan completes (idle) — safe. A
			// manual /critique means the user is in the loop; hijacking their
			// model would strand their next local turn (observed: send-findings
			// dispatched an agent turn, the probe evicted 35b under it, the turn
			// died with connection errors). For a diverse row on demand, run
			// `/critique <provider/id>` explicitly (that records modelOverride).
			const probeEvery = cfg.recallProbeEvery ?? 0;
			if (
				probeEvery > 0 &&
				source === "auto" &&
				row.userSentFindings !== true &&
				!modelOverride &&
				rowsSinceLastProbe() >= probeEvery
			) {
				void runRecallProbe(ctx, cfg, { artifact, specNote, ref, changedFiles: changedList, diffStats }, row);
			}
	};

	/** Non-probe telemetry rows since the last probe row (∞ when no file). */
	function rowsSinceLastProbe(): number {
		try {
			const lines = readFileSync(TELEMETRY_PATH, "utf8").trim().split("\n").filter(Boolean);
			let n = 0;
			for (let i = lines.length - 1; i >= 0; i--) {
				try {
					if ((JSON.parse(lines[i]) as CritiqueTelemetryRow).source === "probe") return n;
				} catch {
					continue;
				}
				n++;
			}
			return n;
		} catch {
			return Number.MAX_SAFE_INTEGER;
		}
	}

	async function runRecallProbe(
		ctx: ExtensionCommandContext,
		cfg: CriticConfig,
		base: {
			artifact: string;
			specNote: string;
			ref: string;
			changedFiles: string[];
			diffStats: CritiqueTelemetryRow["diff"];
		},
		mainRow: CritiqueTelemetryRow,
	): Promise<void> {
		const diverse = cfg.diverseModel ?? "crow-local-27b/qwen3.6-27b";
		ctx.ui.notify(`Recall probe: re-running code-critic on ${diverse} over the same diff…`, "info");
		let restore: (() => void) | null = null;
		try {
			restore = await ensureCriticModel(diverse, (m, s) => ctx.ui.notify(m, s));
		} catch (err) {
			ctx.ui.notify(`Recall probe skipped: ${String((err as Error)?.message ?? err)}`, "warning");
			return;
		}
		try {
			const out = await critiqueArtifact({
				cwd: ctx.cwd,
				artifact: base.artifact,
				specNote: base.specNote,
				source: "probe",
				criticNames: ["code-critic"],
				modelOverride: diverse,
				ref: base.ref,
				changedFiles: base.changedFiles,
				diffStats: base.diffStats,
			});
			if ("missing" in out) return;
			out.row.probeOf = mainRow.ts;
			appendCritiqueTelemetry(out.row);
			const nBlockers = (r: CritiqueTelemetryRow) => r.verdicts.reduce((n, v) => n + v.blockers, 0);
			const main = nBlockers(mainRow);
			const probe = nBlockers(out.row);
			const novel =
				probe > 0
					? out.verdicts
							.flatMap((v) => v.verdict.findings)
							.filter((f) => f.severity === "blocker")
							.slice(0, 6)
							.map((f) => `- ${f.detail}`)
							.join("\n")
					: "";
			pi.sendMessage(
				{
					customType: "critic-probe",
					content: `**Recall probe** (${diverse}): ${probe} blocker(s) vs ${main} from the main run.${probe > main && novel ? `\n${novel}` : ""}`,
					display: true,
					details: undefined,
				},
				{ triggerTurn: false },
			);
		} finally {
			restore?.();
		}
	}

	/**
	 * Model-picker card for the critics: Default bindings / configured local
	 * models / frontier. Phone card races the TUI selector; the TUI countdown
	 * auto-picks Default so unattended auto-critiques never stall.
	 */
	async function pickCriticModel(ctx: ExtensionCommandContext, cfg: CriticConfig): Promise<string | undefined> {
		const diverse = cfg.diverseModel ?? "crow-local-27b/qwen3.6-27b";
		const frontier = cfg.frontierModel ?? "zai-coding/glm-5.1";
		const refs = (cfg.cardModels ?? [diverse, "crow-local-nemotron/nemotron-3-super-120b-a12b", frontier]).filter(
			Boolean,
		);
		const managed = readLocalModels() as Record<string, unknown>;
		const states = await Promise.all(
			refs.map(async (r) => ({ ref: r, local: !!managed[r], running: managed[r] ? await isRunning(r) : null })),
		);
		const DEFAULT = "Default bindings";
		const options = [
			{ label: DEFAULT, description: "each critic on its configured model" },
			...states.map((s) => ({
				label: s.ref,
				description: s.local
					? s.running
						? "local — running now"
						: "local — will swap the loaded model, then restore it"
					: "cloud",
			})),
		];
		const timeoutMs = Math.max(5, cfg.modelCardTimeoutSec ?? 45) * 1000;
		const picked = await raceWithPhone(
			pi,
			{ question: "Auto-critique is starting — which model should the critics run on?", header: "Critique model", options },
			(signal) =>
				ctx.ui.select(
					"Critic model:",
					options.map((o) => `${o.label}  — ${o.description}`),
					{ signal, timeout: timeoutMs },
				),
		);
		if (!picked) return undefined;
		const ref = picked.split("  —")[0].trim();
		return refs.includes(ref) ? ref : undefined;
	}

	// Auto-critique when a plan finishes executing (the long-local-flow case:
	// generation just ended, validation should start without being asked).
	pi.events.on("plan-mode:complete", () => {
		if (!lastCtx) return;
		if (loadConfig().auto === false) return;
		void runCritique("", lastCtx, "auto");
	});

	pi.registerCommand("critique", {
		description:
			"Independent critics on the diff: /critique [base-ref] [frontier|provider/id] · /critique model (picker) · /critique auto on|off",
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
			if (trimmed === "model" || trimmed.startsWith("model ")) {
				// Same card the auto path shows; picked model becomes this run's
				// override. Remaining tokens (if any) are the base ref.
				const rest = trimmed.slice(5).trim();
				const picked = await pickCriticModel(ctx, loadConfig());
				return runCritique(picked ? `${picked} ${rest}`.trim() : rest, ctx);
			}
			return runCritique(trimmed, ctx);
		},
	});
}
