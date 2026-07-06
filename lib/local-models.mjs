/**
 * local-models.mjs — start/stop the lab's llama.cpp docker servers so model
 * switching can LOAD models, not just point at them.
 *
 * Shared by extensions/web (phone UI), extensions/local-models.ts (TUI
 * /serve command), and anything else. Config in ~/.pi/agent/settings.json:
 *
 *   "localModels": {
 *     "crow-local-122b/qwen3.5-122b-a10b": {
 *       "composeDir": "/home/kh0pp/crow-addons/llamacpp-vulkan-qwen35-122b",
 *       "url": "http://100.118.41.122:8004/v1",
 *       "group": "heavy"          // starting one "heavy" stops the others
 *     },
 *     ...
 *   }
 *
 * Models in the same non-null `group` are mutually exclusive (RAM budget):
 * starting one composes the others in its group down first.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");

/** { "<provider/id>": {composeDir, url, group} } — live-read each call. */
export function readLocalModels() {
	try {
		const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
		return raw.localModels ?? {};
	} catch {
		return {};
	}
}

function execFileP(cmd, args, opts = {}) {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, opts, (err, stdout, stderr) => {
			if (err) reject(Object.assign(err, { stdout, stderr }));
			else resolve({ stdout, stderr });
		});
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is the server answering? (fast probe; null = not a managed local model) */
export async function isRunning(ref) {
	const entry = readLocalModels()[ref];
	if (!entry?.url) return null;
	try {
		const res = await fetch(`${entry.url.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(1500) });
		return res.ok;
	} catch {
		return false;
	}
}

/** Annotate a list of provider/id refs with local/running state. */
export async function annotate(refs) {
	const managed = readLocalModels();
	return Promise.all(
		refs.map(async (ref) => {
			if (!managed[ref]) return { ref, local: false, running: null };
			return { ref, local: true, running: await isRunning(ref) };
		}),
	);
}

// ---------------------------------------------------------------------------
// Lifecycle serialization (ROADMAP 2c). Critics, the refute-pass, and
// fix-dispatch are three swap points on the single local slot in one pi
// session — plus their fire-and-forget background restores. Interleaved
// compose up/down can strand the slot empty or let findRunningManaged observe
// an in-flight restore. Every MUTATING op runs through one in-process FIFO
// queue: a queued op starts only after the previous one settles; a rejection
// propagates to its own caller but never wedges the queue. Read-only probes
// (isRunning/annotate/readLocalModels) stay unserialized. NOTE: per-process
// only — the hub and other pi sessions are separate processes and remain
// unsynchronized (acceptable: the in-session swap points were the races seen).
// ---------------------------------------------------------------------------
let lifecycleTail = Promise.resolve();

/** Run `fn` after every previously enqueued lifecycle op has settled. */
export function enqueueLifecycle(fn) {
	const run = lifecycleTail.then(fn);
	lifecycleTail = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

export function stopModel(ref) {
	return enqueueLifecycle(async () => {
		const entry = readLocalModels()[ref];
		if (!entry?.composeDir) throw new Error(`not a managed local model: ${ref}`);
		await execFileP("docker", ["compose", "down"], { cwd: entry.composeDir });
	});
}

/**
 * Start a managed model server (composing down same-group peers first) and
 * wait until it answers. Big models take minutes to load — default 10 min
 * (the health deadline starts when the queued op RUNS, not when enqueued).
 * onProgress(stage) gets "stopping:<ref>" | "starting" | "loading".
 */
export function startModel(ref, opts = {}) {
	return enqueueLifecycle(() => startModelNow(ref, opts));
}

async function startModelNow(ref, { timeoutMs = 600_000, onProgress } = {}) {
	const managed = readLocalModels();
	const entry = managed[ref];
	if (!entry?.composeDir) throw new Error(`not a managed local model: ${ref}`);

	// Eviction: `evicts` lists the groups this model pushes out (its own
	// group included = heavies swap each other). Falls back to same-group-
	// only for entries without an evicts list. User policy ("swap
	// everything"): heavies evict standard + heavy; standards evict heavy —
	// so bringing a qwen back also clears the heavyweight automatically.
	const evicts = entry.evicts ?? (entry.group ? [entry.group] : []);
	for (const [peerRef, peer] of Object.entries(managed)) {
		if (peerRef === ref || !peer.group || !evicts.includes(peer.group)) continue;
		if (await isRunning(peerRef)) {
			onProgress?.(`stopping:${peerRef}`);
			await execFileP("docker", ["compose", "down"], { cwd: peer.composeDir });
		}
	}

	onProgress?.("starting");
	await execFileP("docker", ["compose", "up", "-d"], { cwd: entry.composeDir });

	onProgress?.("loading");
	const deadline = Date.now() + timeoutMs;
	// llama.cpp answers /v1/models with 200 WHILE the weights are still
	// loading — switching then fails. /health returns 503 until truly ready.
	const base = entry.url.replace(/\/+$/, "").replace(/\/v1$/, "");
	const healthUrl = `${base}/health`;
	const modelsUrl = `${entry.url.replace(/\/+$/, "")}/models`;
	let healthSupported = true;
	while (Date.now() < deadline) {
		try {
			if (healthSupported) {
				const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
				if (res.status === 404) healthSupported = false; // non-llama server
				else if (res.ok) return true;
			} else {
				const res = await fetch(modelsUrl, { signal: AbortSignal.timeout(2000) });
				if (res.ok) return true;
			}
		} catch {
			// not up yet
		}
		await sleep(4000);
	}
	throw new Error(`${ref} did not become healthy within ${Math.round(timeoutMs / 60000)} min`);
}
