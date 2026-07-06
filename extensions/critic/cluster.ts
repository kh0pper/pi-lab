/**
 * Pure clustering for structured fix-dispatch (Workstream 2). No pi imports —
 * unit-tested via extensions/critic/cluster.test.mjs. Deterministic: no
 * Date/Math.random, so clustering and step order are reproducible.
 */

// A code-file extension allowlist keeps member-access tokens (res.ok, a.map)
// from reading as files while still catching real source paths. `+` is in the
// name class for SvelteKit route files (+page.server.ts).
const CODE_EXT =
	"ts|tsx|js|jsx|mjs|cjs|svelte|vue|py|go|rs|java|kt|rb|php|c|h|cpp|cc|cs|sql|json|yaml|yml|toml|md|css|scss|html|sh";
const FILE_RE = new RegExp(`(?<![\\w./+-])((?:[\\w.+-]+/)*[\\w.+-]+\\.(?:${CODE_EXT}))(?![\\w])`);

// Framework proper-nouns ending in .js read as files under the allowlist but
// are prose, not paths — reject them UNLESS they appear with a directory (a
// real vendored build/vendor/node.js should still cluster).
const FRAMEWORK_DENY = new Set([
	"node.js", "next.js", "vue.js", "nuxt.js", "express.js", "three.js",
	"d3.js", "react.js", "angular.js", "ember.js", "backbone.js", "jquery.js",
]);

/** First path-looking token (code-file extension) in a finding's detail, or null. */
export function extractPrimaryFile(detail: string | undefined): string | null {
	if (!detail) return null;
	const re = new RegExp(FILE_RE.source, "g");
	let m: RegExpExecArray | null;
	while ((m = re.exec(detail)) !== null) {
		const tok = m[1];
		if (!tok.includes("/") && FRAMEWORK_DENY.has(tok.toLowerCase())) continue;
		return tok;
	}
	return null;
}

/** Canonicalize a cited file token against the changed-file list (M2). A bare
 *  basename / partial path / absolute-prefixed path that unambiguously
 *  suffix-matches exactly one changed file resolves to that full repo-relative
 *  path — so the same file cited two ways keys ONE cluster and a bare basename
 *  matches full-path subsystem globs. Ambiguous or unknown tokens pass through
 *  unchanged (minus a leading "./"). */
export function canonicalizeFile(token: string | null, changedFiles: string[]): string | null {
	if (!token) return null;
	const tok = token.replace(/^\.\//, "");
	const matches = changedFiles.filter((cf) => cf === tok || cf.endsWith(`/${tok}`) || tok.endsWith(`/${cf}`));
	return matches.length === 1 ? matches[0] : tok;
}

export interface FindingRef {
	agent: string;
	severity?: string;
	category?: string;
	detail?: string;
}

export interface SubsystemDef {
	globs?: string[];
	invariants?: string[];
}

export interface Cluster {
	name: string;
	subsystem: string | null;
	files: string[];
	invariants: string[];
	findings: FindingRef[];
}

/** Minimal glob→regex: ** crosses dirs, * stays within one, ? one char.
 *  (Mirrors the same helper in index.ts; kept local so this module stays
 *  pi-import-free and independently testable.) */
function globToRegExp(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "")
		.replace(/\*/g, "[^/]*")
		.replace(//g, ".*")
		.replace(/\?/g, "[^/]");
	return new RegExp(`^${escaped}$`);
}

export function clusterFindings(
	findings: FindingRef[],
	subsystems: Record<string, SubsystemDef>,
	changedFiles: string[],
	maxClusters: number,
): Cluster[] {
	const subNames = Object.keys(subsystems);
	const subRegs = subNames.map((n) => (subsystems[n].globs ?? []).map(globToRegExp));
	const matchSub = (file: string | null): string | null => {
		if (!file) return null;
		for (let i = 0; i < subNames.length; i++) {
			if (subRegs[i].some((re) => re.test(file))) return subNames[i];
		}
		return null;
	};

	// key → cluster, preserving first-seen order via an ordered key list.
	const byKey = new Map<string, Cluster>();
	const order: string[] = [];
	const ensure = (key: string, seed: () => Cluster): Cluster => {
		let c = byKey.get(key);
		if (!c) {
			c = seed();
			byKey.set(key, c);
			order.push(key);
		}
		return c;
	};

	for (const f of findings) {
		const file = canonicalizeFile(extractPrimaryFile(f.detail), changedFiles);
		const sub = matchSub(file);
		if (sub) {
			const members = changedFiles.filter((cf) => subRegs[subNames.indexOf(sub)].some((re) => re.test(cf)));
			const c = ensure(`sub:${sub}`, () => ({
				name: sub,
				subsystem: sub,
				files: members.length ? [...members] : file ? [file] : [],
				invariants: [...(subsystems[sub].invariants ?? [])],
				findings: [],
			}));
			c.findings.push(f);
		} else if (file) {
			const c = ensure(`file:${file}`, () => ({ name: file, subsystem: null, files: [file], invariants: [], findings: [] }));
			c.findings.push(f);
		} else {
			const c = ensure("general", () => ({ name: "general", subsystem: null, files: [], invariants: [], findings: [] }));
			c.findings.push(f);
		}
	}

	// Order: subsystem clusters (declaration order) → file clusters (first seen) → general.
	const rank = (key: string) => (key.startsWith("sub:") ? 0 : key === "general" ? 2 : 1);
	order.sort((x, y) => {
		const rx = rank(x);
		const ry = rank(y);
		if (rx !== ry) return rx - ry;
		if (rx === 0) return subNames.indexOf(x.slice(4)) - subNames.indexOf(y.slice(4));
		return 0; // file clusters keep first-seen order (stable sort)
	});
	let clusters = order.map((k) => byKey.get(k)!);

	// Cap: fold the smallest clusters into a SINGLE "misc" bucket (M1 — the
	// old merge-two-smallest loop could emit several clusters all named
	// "misc"). Survivors keep their order; misc goes last.
	if (clusters.length > maxClusters) {
		const bySize = [...clusters].sort((p, q) => p.findings.length - q.findings.length);
		const toMerge = new Set(bySize.slice(0, clusters.length - maxClusters + 1));
		const misc: Cluster = { name: "misc", subsystem: null, files: [], invariants: [], findings: [] };
		for (const c of clusters) {
			if (!toMerge.has(c)) continue;
			misc.files.push(...c.files.filter((f) => !misc.files.includes(f)));
			misc.invariants.push(...c.invariants.filter((i) => !misc.invariants.includes(i)));
			misc.findings.push(...c.findings);
		}
		clusters = [...clusters.filter((c) => !toMerge.has(c)), misc];
	}
	return clusters;
}

/** One fixer chain step per cluster. `{previous}` is left literal so runChain
 *  threads the earlier clusters' summaries; runChain appends the verdict block. */
export function buildFixChain(clusters: Cluster[], agent = "fixer"): Array<{ agent: string; task: string }> {
	return clusters.map((c) => {
		const filesBlock = c.files.length ? c.files.map((f) => `- ${f}`).join("\n") : "(no specific file — locate from the findings)";
		const invBlock = c.invariants.length
			? `\nInvariants that MUST hold across these files:\n${c.invariants.map((i) => `- ${i}`).join("\n")}\n`
			: "";
		const findingsBlock = c.findings
			.map((f) => `- [${f.severity ?? "?"}/${f.category ?? "?"}] (${f.agent}) ${f.detail ?? ""}`)
			.join("\n");
		const task =
			`Fix the independent-critic findings in the "${c.name}" cluster.\n\n` +
			`Files in scope:\n${filesBlock}\n${invBlock}\n` +
			`Findings to address (fix each, or explain in your verdict why it is wrong):\n${findingsBlock}\n\n` +
			`Instructions:\n` +
			`- Read every in-scope file before editing.\n` +
			`- Apply the minimal correct fix for each finding; fix the underlying invariant, not just the finding's wording.\n` +
			`- If a blocker names a testable failure, add or update a regression test that FAILS against the old behavior.\n` +
			`- Run the project's tests for these files (check package.json scripts / Makefile) and report pass/fail counts.\n` +
			`- Do not touch files outside this cluster's scope unless a fix strictly requires it.\n\n` +
			`Context from earlier clusters in this run (may be empty):\n{previous}`;
		return { agent, task };
	});
}
