/**
 * context.ts — sibling-file selection for critic route-bundle context (1B).
 * PURE: no pi imports, so the loader gate stays meaningful and this is unit-testable.
 */

export const SIBLING_MAX_PER_DIR = 6;

/** Lock/generated/binary siblings a critic gains nothing from. */
export const SIBLING_SKIP_RE =
	/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|\.(min\.(js|css)|map|png|jpe?g|gif|ico|webp|avif|bmp|woff2?|ttf|otf|eot|wasm|gz|zip|pdf|mp[34]|mov|webm|db|sqlite|lockb)$/i;

function dirOf(p: string): string {
	const i = p.lastIndexOf("/");
	return i === -1 ? "" : p.slice(0, i);
}

/**
 * Repo-relative files in the same directory as a changed file, excluding the
 * changed files themselves and lock/generated/binary files, deduped, capped
 * per directory. Behavior that spans a framework's file-group (SvelteKit
 * +page.svelte / +page.server.ts, …) is surfaced so a critic reviewing one
 * half sees the other.
 */
export function selectSiblings(
	changedFiles: string[],
	lsFiles: string[],
	opts: { maxPerDir?: number } = {},
): string[] {
	const maxPerDir = opts.maxPerDir ?? SIBLING_MAX_PER_DIR;
	const changed = new Set(changedFiles);
	const dirs = new Set(changedFiles.map(dirOf));
	const out: string[] = [];
	const perDir = new Map<string, number>();
	const seen = new Set<string>();
	for (const f of lsFiles) {
		const d = dirOf(f);
		if (!dirs.has(d) || changed.has(f) || seen.has(f) || SIBLING_SKIP_RE.test(f)) continue;
		const n = perDir.get(d) ?? 0;
		if (n >= maxPerDir) continue;
		perDir.set(d, n + 1);
		seen.add(f);
		out.push(f);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Carried findings — fix-review continuity across failed runs.
//
// The sidecar used to hold only the LATEST run's findings, so a failed run
// with different findings silently dropped earlier unresolved ones (live run
// 2026-07-06: the drain-race P0 vanished between rounds — recall is
// stochastic run-to-run). A finding from a recent failed run now carries
// forward until a PASSED run clears the sidecar (existing semantics) or it
// is re-raised / refuted in the current run. Fail-safe direction: a stale
// carried finding costs one re-check that passes; a dropped real one costs
// the bug.
// ---------------------------------------------------------------------------

const CARRY_WINDOW_MS = 4 * 3600_000; // same recency rule as fix-review arming
const CARRY_MAX_TOTAL = 30;
const CARRY_TAG = "[carried]";

interface CarriedFinding {
	agent?: string;
	severity?: string;
	category?: string;
	detail?: string;
}

const normKey = (detail: string | undefined): string =>
	(detail ?? "")
		.replace(/^\[carried\]\s*/, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);

/**
 * Merge a prior failed run's unresolved findings into the set being saved.
 * `currentAll` (pre-refute-filter) is the match set — a finding re-raised OR
 * refuted this run is NOT carried; `currentSaved` (post-filter) is the base.
 * Carried findings are tagged once (idempotent) and the total is capped.
 */
export function mergeCarriedFindings(
	prior: { ts: number; passed: boolean; findings: CarriedFinding[] } | null | undefined,
	currentAll: CarriedFinding[],
	currentSaved: CarriedFinding[],
	now: number,
	maxTotal = CARRY_MAX_TOTAL,
): CarriedFinding[] {
	if (!prior || prior.passed || now - prior.ts > CARRY_WINDOW_MS) return currentSaved.slice(0, maxTotal);
	const seen = new Set(currentAll.map((f) => normKey(f.detail)));
	const carried: CarriedFinding[] = [];
	for (const f of prior.findings ?? []) {
		const key = normKey(f.detail);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		const detail = f.detail?.startsWith(CARRY_TAG) ? f.detail : `${CARRY_TAG} ${f.detail ?? ""}`;
		carried.push({ ...f, detail });
	}
	return [...currentSaved, ...carried].slice(0, maxTotal);
}
