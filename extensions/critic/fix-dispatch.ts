/**
 * Structured fix-dispatch (Workstream 2). Clusters critic findings by
 * subsystem/file and runs one `fixer` chain leg per cluster through the
 * shared runChain() path, so the test-run gate + D4 decompose fire per
 * cluster and a bad fix cannot corrupt the others.
 *
 * Not unit-tested (spawns pi child processes); the pure clustering it relies
 * on is covered by cluster.test.mjs. Runtime-verified via tmux.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRunning, readLocalModels, startModel } from "../../lib/local-models.mjs";
import { discoverAgents } from "../subagent/agents.js";
import type { SingleResult, SubagentDetails } from "../subagent/run.js";
import { type RunChainResult, runChain } from "../subagent/index.js";
import { buildFixChain, clusterFindings, type FindingRef, type SubsystemDef } from "./cluster.js";

const LOG_PATH = join(homedir(), ".pi", "agent", "fix-dispatch-log.jsonl");

export interface FixDispatchDeps {
	cwd: string;
	findings: FindingRef[];
	subsystems: Record<string, SubsystemDef>;
	changedFiles: string[];
	maxClusters: number;
	/** Force this model on the fixer legs; when unset, use the fixer agent's own model. */
	fixModel?: string;
	/**
	 * The managed local model the interactive session was running BEFORE the
	 * critique swapped anything — captured once by the caller. Dispatch restores
	 * to exactly this (never to a recomputed "currently running" model, which at
	 * dispatch time is the still-loading/transient one — review C1). null when
	 * the session is not on a managed local (e.g. a cloud model): nothing to
	 * restore, since cloud turns don't use the local slot.
	 */
	sessionModel: string | null;
	notify: (m: string, s?: "info" | "warning" | "error") => void;
	signal?: AbortSignal;
}

export interface FixDispatchOutcome {
	dispatched: boolean;
	reason?: string;
	clusters: number;
	results: SingleResult[];
	error: RunChainResult["error"];
}

/** Append + cap (like logDecompose): keep the file bounded (S4). */
function logDispatch(row: Record<string, unknown>): void {
	try {
		appendFileSync(LOG_PATH, `${JSON.stringify(row)}\n`);
		const lines = readFileSync(LOG_PATH, "utf8").split("\n");
		if (lines.length > 2000) writeFileSync(LOG_PATH, lines.slice(-1000).join("\n"));
	} catch {
		// best-effort
	}
}

const isManaged = (ref: string): boolean => Boolean((readLocalModels() as Record<string, unknown>)[ref]);

export async function dispatchFixChain(d: FixDispatchDeps): Promise<FixDispatchOutcome> {
	const clusters = clusterFindings(d.findings, d.subsystems, d.changedFiles, d.maxClusters);
	if (clusters.length === 0) {
		return { dispatched: false, reason: "no findings to cluster", clusters: 0, results: [], error: null };
	}

	const discovered = discoverAgents(d.cwd, "user").agents;
	const fixer = discovered.find((a) => a.name === "fixer");
	if (!fixer) {
		return { dispatched: false, reason: "fixer agent not found (run install-bridges.sh)", clusters: clusters.length, results: [], error: null };
	}

	// Force a single model on the fixer legs so we ensure exactly that one is
	// serving on the single local slot. Default: the fixer agent's own model.
	const fixModel = d.fixModel ?? (fixer as { model?: string }).model;
	const agents = fixModel ? discovered.map((a) => (a.name === "fixer" ? { ...a, forceModel: fixModel } : a)) : discovered;

	// Ensure fixModel is serving. Only manage the slot for a MANAGED local model;
	// a cloud fixModel (or none) needs no slot juggling. Start only if not already
	// running — the critique's restore may already be loading it. Fail-open to the
	// message fallback if the model won't start.
	let needsRestore = false;
	if (fixModel && isManaged(fixModel)) {
		try {
			if (!(await isRunning(fixModel))) {
				d.notify(`Fix-dispatch: starting ${fixModel} for the fixer legs (big models take a few minutes)…`, "info");
				await startModel(fixModel);
			}
			// Restore the session's model afterward only if it is a DIFFERENT managed local.
			needsRestore = Boolean(d.sessionModel && d.sessionModel !== fixModel && isManaged(d.sessionModel));
		} catch (err) {
			// startModel evicts peers BEFORE starting, so a throw here may already
			// have taken the session's model down — and this early return skips the
			// finally below (M4). Best-effort background restore, mirroring it.
			if (d.sessionModel && d.sessionModel !== fixModel && isManaged(d.sessionModel) && !(await isRunning(d.sessionModel).catch(() => false))) {
				d.notify(`Fix-dispatch aborted — restoring ${d.sessionModel} in the background…`, "info");
				void startModel(d.sessionModel).then(
					() => d.notify(`${d.sessionModel} is back up.`),
					(e2: unknown) => d.notify(`Failed to restore ${d.sessionModel}: ${String((e2 as Error)?.message ?? e2)} — run /serve ${d.sessionModel}`, "error"),
				);
			}
			return {
				dispatched: false,
				reason: `could not start fix model ${fixModel}: ${String((err as Error)?.message ?? err)}`,
				clusters: clusters.length,
				results: [],
				error: null,
			};
		}
	}

	const makeDetails = (results: SingleResult[]): SubagentDetails => ({
		mode: "chain",
		agentScope: "user",
		projectAgentsDir: null,
		results,
	});

	d.notify(
		`Fix-dispatch: ${clusters.length} cluster${clusters.length > 1 ? "s" : ""} (${clusters.map((c) => c.name).join(", ")}) → fixer legs on ${fixModel ?? "(agent default)"}…`,
		"info",
	);

	let out: RunChainResult;
	try {
		out = await runChain({
			cwd: d.cwd,
			agents,
			chain: buildFixChain(clusters),
			signal: d.signal,
			makeDetails,
		});
	} finally {
		// Background-restore the session model to the captured target (never a
		// recomputed prev). Fire-and-forget: it takes minutes; the session's next
		// local turn waits on /health as usual.
		if (needsRestore && d.sessionModel) {
			d.notify(`Fix-dispatch done — restoring ${d.sessionModel} in the background (local turns may fail until it's up)…`, "info");
			void startModel(d.sessionModel).then(
				() => d.notify(`${d.sessionModel} is back up.`),
				(err: unknown) => d.notify(`Failed to restore ${d.sessionModel}: ${String((err as Error)?.message ?? err)} — run /serve ${d.sessionModel}`, "error"),
			);
		}
	}

	logDispatch({
		v: 1,
		ts: Date.now(),
		cwd: d.cwd,
		clusters: clusters.map((c) => ({ name: c.name, subsystem: c.subsystem, findings: c.findings.length, files: c.files })),
		fixModel: fixModel ?? null,
		sessionModel: d.sessionModel,
		error: out.error ? { stepNo: out.error.stepNo, agent: out.error.agentName } : null,
		legs: out.results.length,
	});

	return { dispatched: true, clusters: clusters.length, results: out.results, error: out.error };
}
