# Critic Structured Fix-Dispatch (Workstream 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single "implement all findings" send-findings message with findings clustered by subsystem/file and dispatched one fixer-subagent chain leg per cluster, so the chain test-run gate + D4 decompose-on-failure fire per cluster and a bad fix cannot corrupt others.

**Architecture:** Three pieces. (1) A pure `cluster.ts` module (no pi imports, unit-tested) that groups findings into clusters and builds the per-cluster fixer task text. (2) A behavior-preserving extraction of the existing chain-execution loop out of the subagent tool's `execute` closure into an exported `runChain()` — the same D4 + test-gate path `/implement` uses, now callable from other extensions the way `critiqueArtifact` already is. (3) `fix-dispatch.ts`, which clusters the critic's findings, forces the fix model, and dispatches the clusters through `runChain()`, wired into the critic send-findings branch behind `critic.fixDispatch`.

**Tech Stack:** TypeScript loaded by pi via jiti (no build step), esbuild→node `.mjs` assertion scripts for pure-module tests, `crow-local/qwen3.6-35b-a3b` as the default local fixer model.

## Global Constraints

- Every `extensions/*.ts` (or subdir `index.ts`) default-exports `(pi: ExtensionAPI) => void`. Pure helper modules (`cluster.ts`) export named functions only and MUST NOT import pi internals or pi-ai (so the loader gate and esbuild tests stay meaningful).
- **Bot-exclusion invariant:** the fix-dispatch path must no-op when `PI_BOT_PERMISSION_POLICY` is set or `PIBOT_SUBAGENT_DEPTH >= 1`. The critic extension is already bot-excluded at the top of its default function — the new code lives inside that guard, so inherit it; add no new ambient side effects that run before it.
- **No NUL bytes:** the Edit tool intermittently inserts a literal NUL byte where a normal character is meant. After editing ANY `extensions/critic/*.ts` or `extensions/subagent/*.ts` file, run `python3 -c "print(open('FILE','rb').read().count(b'\x00'))"` and expect `0`.
- **One local model slot:** every managed local model evicts the others (`lib/local-models.mjs`). Fix-dispatch must ensure the fixer model is serving and restore the prior model in the background afterward — never leave the session's model evicted. Ensure only when the fixer model differs from what's already running.
- **`runChain` extraction is behavior-preserving:** the D4 decompose logic and test-run gate took two adversarial reviews to get right. The extraction is a mechanical cut-and-move of the exact existing lines into a module-scope function — no logic edits. Verify the loader gate still passes AND a real 2-step chain still runs via tmux before moving on.
- **No `pi -p` for runtime checks of event-driven code** — verify via a `tmux` pi session (`tmux send-keys`), never `pi -p`.
- Config lives under the `critic` key in `~/.pi/agent/settings.json`, read fresh via the existing `loadConfig()`.
- Deterministic pure functions only in `cluster.ts` — no `Date.now()`, no `Math.random()` (clustering/order must be reproducible for tests).

---

## File Structure

- **Create `extensions/critic/cluster.ts`** — pure clustering + task-building. Exports `extractPrimaryFile`, `clusterFindings`, `buildFixChain`, and the types `FindingRef`, `SubsystemDef`, `Cluster`.
- **Create `extensions/critic/cluster.test.mjs`** — esbuild→node assertions for the three pure functions, wired into `test:critic`.
- **Create `extensions/subagent/agents/fixer.md`** — the fix-a-cluster agent (self-contained fix task, unlike `editor` which expects an architect proposal).
- **Create `extensions/critic/fix-dispatch.ts`** — `dispatchFixChain()`: cluster → force model → `runChain` → background restore → telemetry. Imports `runChain` from `../subagent/index.js` and the pure helpers from `./cluster.js`. Not unit-tested (spawns pi); runtime-verified.
- **Modify `extensions/subagent/index.ts`** — extract the inline chain loop (currently inside `execute`, lines ~453-655) into an exported module-scope `runChain()`; `execute` delegates to it. Export `RunChainOpts`/`RunChainResult`.
- **Modify `extensions/critic/index.ts`** — add `fixDispatch`/`fixMaxClusters`/`fixModel` to `CriticConfig` + `loadConfig`; track plan-mode state; branch the send-findings block on `cfg.fixDispatch`.
- **Modify `package.json`** — add `cluster.test.mjs` to the `test:critic` script.
- **Modify `CLAUDE.md` and `docs/ROADMAP.md`** — document the subsystem + config + telemetry.

---

## Task 1: Pure `extractPrimaryFile` — pull a cited file out of a finding's detail text

Findings are only `{category?, severity?, detail?}` — there is no structured `file` field. Clustering by file needs to extract the first path-looking token from the detail prose. Precision matters: `res.ok` or `array.map` must NOT read as files; `src/lib/client/sync.ts` and `+page.server.ts` must.

**Files:**
- Create: `extensions/critic/cluster.ts`
- Test: `extensions/critic/cluster.test.mjs`

**Interfaces:**
- Produces: `extractPrimaryFile(detail: string | undefined): string | null`

- [ ] **Step 1: Write the failing test**

Create `extensions/critic/cluster.test.mjs`:

```js
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = join(mkdtempSync(join(tmpdir(), "clu-")), "cluster.mjs");
execFileSync("npx", ["esbuild", "extensions/critic/cluster.ts", `--outfile=${out}`, "--format=esm", "--log-level=warning"]);
const { extractPrimaryFile, clusterFindings, buildFixChain } = await import(out);

const a = (n, c) => { if (!c) { console.error("FAIL", n); process.exit(1); } console.log("ok", n); };

// --- extractPrimaryFile ---
a("nested path", extractPrimaryFile("push in src/lib/client/sync.ts never checks res.ok") === "src/lib/client/sync.ts");
a("bare filename", extractPrimaryFile("drainMutations in localdb.ts wipes the outbox") === "localdb.ts");
a("sveltekit + prefix", extractPrimaryFile("the redirect lives in +page.server.ts (307)") === "+page.server.ts");
a("member access is not a file", extractPrimaryFile("the call never checks res.ok before draining") === null);
a("method chain is not a file", extractPrimaryFile("uses array.map to iterate") === null);
a("first file wins", extractPrimaryFile("sync.ts calls into server/sync.ts") === "sync.ts");
a("no file at all", extractPrimaryFile("the cursor resets past 1000 rows") === null);
a("undefined detail", extractPrimaryFile(undefined) === null);
a("framework name is not a file", extractPrimaryFile("this breaks under Node.js at runtime") === null);
a("framework name skipped, real file found", extractPrimaryFile("the Next.js route in page.tsx is wrong") === "page.tsx");
a("path-form js name is still a file", extractPrimaryFile("see build/vendor/node.js for the shim") === "build/vendor/node.js");

console.log("ALL CLUSTER TESTS PASS");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node extensions/critic/cluster.test.mjs`
Expected: FAIL — esbuild errors that `extensions/critic/cluster.ts` does not exist (or the import has no `extractPrimaryFile`).

- [ ] **Step 3: Write minimal implementation**

Create `extensions/critic/cluster.ts` with the header comment and this function:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node extensions/critic/cluster.test.mjs`
Expected: the `extractPrimaryFile` assertions print `ok …`; the run then fails at `clusterFindings`/`buildFixChain` being undefined (those come in Tasks 2-3). That partial pass is expected here.

- [ ] **Step 5: Commit**

```bash
git add extensions/critic/cluster.ts extensions/critic/cluster.test.mjs
git commit -m "critic: extractPrimaryFile — pull cited file from finding detail (WS2)"
```

---

## Task 2: Pure `clusterFindings` — group findings by subsystem, then file, then general

**Files:**
- Modify: `extensions/critic/cluster.ts`
- Test: `extensions/critic/cluster.test.mjs`

**Interfaces:**
- Consumes: `extractPrimaryFile` (Task 1)
- Produces:
  - `interface FindingRef { agent: string; severity?: string; category?: string; detail?: string }`
  - `interface SubsystemDef { globs?: string[]; invariants?: string[] }`
  - `interface Cluster { name: string; subsystem: string | null; files: string[]; invariants: string[]; findings: FindingRef[] }`
  - `clusterFindings(findings: FindingRef[], subsystems: Record<string, SubsystemDef>, changedFiles: string[], maxClusters: number): Cluster[]`

Grouping rule per finding, in order:
1. Its primary file matches a subsystem's globs → that subsystem's cluster.
2. Else it has a primary file → a per-file cluster keyed by that file.
3. Else → the single `general` cluster.

Cluster order: subsystem clusters (in `subsystems` declaration order), then file clusters (first-appearance order), then `general`. When cluster count exceeds `maxClusters`, repeatedly merge the two smallest clusters (by finding count) into a `misc` cluster until within the cap.

- [ ] **Step 1: Add the failing tests**

Append to `extensions/critic/cluster.test.mjs`, BEFORE the final `console.log("ALL CLUSTER TESTS PASS")` line:

```js
// --- clusterFindings ---
const subs = {
  sync: { globs: ["src/lib/client/sync.ts", "src/lib/server/sync.ts"], invariants: ["no update may be lost"] },
};
const changed = ["src/lib/client/sync.ts", "src/lib/server/sync.ts", "src/lib/device.ts"];

const F = [
  { agent: "code-critic", severity: "blocker", category: "correctness", detail: "src/lib/client/sync.ts never checks res.ok" },
  { agent: "code-critic", severity: "blocker", category: "correctness", detail: "src/lib/server/sync.ts cursor wrong past 1000 rows" },
  { agent: "code-critic", severity: "warn", category: "quality", detail: "device.ts crypto.randomUUID has no fallback" },
  { agent: "test-critic", severity: "warn", category: "tests", detail: "no repro for the cursor reset" },
];

let clusters = clusterFindings(F, subs, changed, 6);
const sync = clusters.find((c) => c.subsystem === "sync");
a("sync subsystem cluster exists", !!sync);
a("sync cluster gathers both sync findings", sync.findings.length === 2);
a("sync cluster carries subsystem files", sync.files.includes("src/lib/client/sync.ts") && sync.files.includes("src/lib/server/sync.ts"));
a("sync cluster carries invariants", sync.invariants.includes("no update may be lost"));

const dev = clusters.find((c) => c.subsystem === null && c.files.includes("device.ts"));
a("file cluster for device.ts", !!dev && dev.findings.length === 1);

const gen = clusters.find((c) => c.name === "general");
a("general cluster for no-file finding", !!gen && gen.findings.length === 1);
a("subsystem clusters come first", clusters[0].subsystem === "sync");

// cap/merge: 5 single-file findings, cap 3 → exactly 3 clusters, all findings preserved
const many = [1, 2, 3, 4, 5].map((i) => ({ agent: "c", severity: "warn", detail: `file${i}.ts has an issue` }));
const capped = clusterFindings(many, {}, [], 3);
a("cap respected", capped.length === 3);
a("no findings dropped on merge", capped.reduce((n, c) => n + c.findings.length, 0) === 5);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node extensions/critic/cluster.test.mjs`
Expected: FAIL — `clusterFindings is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `extensions/critic/cluster.ts`:

```ts
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
		const file = extractPrimaryFile(f.detail);
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

	// Cap: merge the two smallest clusters until within the cap.
	while (clusters.length > maxClusters) {
		clusters.sort((p, q) => p.findings.length - q.findings.length);
		const x = clusters.shift()!;
		const y = clusters.shift()!;
		const merged: Cluster = {
			name: "misc",
			subsystem: null,
			files: [...new Set([...x.files, ...y.files])],
			invariants: [...new Set([...x.invariants, ...y.invariants])],
			findings: [...x.findings, ...y.findings],
		};
		clusters.push(merged);
	}
	return clusters;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node extensions/critic/cluster.test.mjs`
Expected: all `extractPrimaryFile` + `clusterFindings` assertions print `ok …`; the run then fails at `buildFixChain` being undefined (Task 3). Expected partial pass.

- [ ] **Step 5: Commit**

```bash
git add extensions/critic/cluster.ts extensions/critic/cluster.test.mjs
git commit -m "critic: clusterFindings — group findings by subsystem/file (WS2)"
```

---

## Task 3: Pure `buildFixChain` — turn clusters into fixer chain steps

**Files:**
- Modify: `extensions/critic/cluster.ts`
- Test: `extensions/critic/cluster.test.mjs`

**Interfaces:**
- Consumes: `Cluster` (Task 2)
- Produces: `buildFixChain(clusters: Cluster[], agent?: string): Array<{ agent: string; task: string }>`

The task text embeds the cluster's files, invariants (if any), and findings, plus fix instructions. It ends with a literal `{previous}` placeholder so `runChain` threads the prior cluster's summary. It does NOT append a verdict block — `runChain` appends `VERDICT_INSTRUCTION` itself when `decomposeOnFailure` is on (avoid duplicating it).

- [ ] **Step 1: Add the failing tests**

Append to `extensions/critic/cluster.test.mjs`, before the final `console.log`:

```js
// --- buildFixChain ---
const chain = buildFixChain(clusters);
a("one step per cluster", chain.length === clusters.length);
a("all steps use the fixer agent", chain.every((s) => s.agent === "fixer"));
const syncStep = chain[0];
a("step names its files", syncStep.task.includes("src/lib/client/sync.ts"));
a("step includes the invariant", syncStep.task.includes("no update may be lost"));
a("step includes finding detail", syncStep.task.includes("never checks res.ok"));
a("step asks to run tests", /run the (project's )?tests/i.test(syncStep.task));
a("step threads previous via placeholder", syncStep.task.includes("{previous}"));
a("no verdict block baked in", !syncStep.task.includes("```verdict"));
a("custom agent name honored", buildFixChain(clusters, "editor")[0].agent === "editor");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node extensions/critic/cluster.test.mjs`
Expected: FAIL — `buildFixChain is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `extensions/critic/cluster.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node extensions/critic/cluster.test.mjs`
Expected: PASS — ends with `ALL CLUSTER TESTS PASS`.

- [ ] **Step 5: Wire the test into `test:critic` and confirm the gate**

Edit `package.json` `test:critic`:

```json
"test:critic": "node extensions/critic/context.test.mjs && node extensions/critic/refute.test.mjs && node extensions/critic/cluster.test.mjs",
```

Run: `npm run test:extensions`
Expected: the loader gate passes and all three critic test scripts print their PASS lines.

- [ ] **Step 6: Commit**

```bash
git add extensions/critic/cluster.ts extensions/critic/cluster.test.mjs package.json
git commit -m "critic: buildFixChain + wire cluster tests into test:critic (WS2)"
```

---

## Task 4: `fixer` agent

The `editor` agent's prompt assumes "the previous step gives you a change proposal with per-file edit sketches" (architect/editor pair). Fix-dispatch has no architect — each leg receives findings directly. A dedicated `fixer` agent avoids misusing `editor`.

**Files:**
- Create: `extensions/subagent/agents/fixer.md`

**Interfaces:**
- Produces: an agent named `fixer`, discoverable via `discoverAgents(cwd, "user")`, model `crow-local/qwen3.6-35b-a3b`, with write + bash tools.

- [ ] **Step 1: Create the agent file**

Create `extensions/subagent/agents/fixer.md`:

```markdown
---
name: fixer
description: Fixes a cluster of code-review findings as direct file edits, adds regression tests, and runs the suite
model: crow-local/qwen3.6-35b-a3b
tools: read,write,edit,ls,find,grep,bash
---

You are the FIXER. You receive a small cluster of independent-critic findings
about a few related files, plus any invariants those files must uphold. Your
job is to make the code correct and prove it.

Process:
1. Read every in-scope file before you change anything.
2. For each finding: restate the underlying invariant to yourself, then apply
   the minimal edit that makes it hold on ALL failure paths (network error,
   HTTP error status, partial failure, concurrent actor, boundary values) —
   not just the one line the finding quoted.
3. If a finding names a testable failure, add or update a regression test that
   FAILS against the old behavior and passes after your fix.
4. Run the project's tests for these files (check package.json scripts or the
   Makefile). Report pass/fail counts. Fix anything you broke.
5. Stay inside the cluster's files unless a correct fix strictly requires more.

If a finding is wrong (the behavior is already correct, handled elsewhere, or
the finding misread the framework), do NOT edit blindly — say so in your
verdict with the concrete reason.

End your reply with the fenced verdict block your runtime instructions describe.
```

- [ ] **Step 2: Install the bridge and confirm discovery**

Run: `bash scripts/install-bridges.sh`
Then confirm the symlink exists:
Run: `ls -l ~/.pi/agent/agents/fixer.md`
Expected: a symlink pointing at `extensions/subagent/agents/fixer.md`.

- [ ] **Step 3: Commit**

```bash
git add extensions/subagent/agents/fixer.md
git commit -m "subagent: fixer agent — self-contained cluster fix leg (WS2)"
```

---

## Task 5: Extract `runChain()` from the subagent tool (behavior-preserving)

The chain loop with D4 decompose + test-run gate lives inside the subagent tool's `execute` closure (`extensions/subagent/index.ts`, the `if (params.chain && params.chain.length > 0) { … }` block, currently ~lines 453-655). Extract it verbatim into an exported module-scope `runChain()` so fix-dispatch can call the identical path. This is a mechanical move — do not change any decision logic.

**Files:**
- Modify: `extensions/subagent/index.ts`

**Interfaces:**
- Produces:
  - `interface RunChainOpts { cwd: string; agents: AgentConfig[]; chain: Array<{ agent: string; task: string; cwd?: string }>; toolsOverride?: string[]; signal?: AbortSignal; onUpdate?: OnUpdateCallback; makeDetails: (results: SingleResult[]) => SubagentDetails }`
  - `interface RunChainResult { results: SingleResult[]; error: { stepNo: number; agentName: string; result: SingleResult } | null }`
  - `export async function runChain(opts: RunChainOpts): Promise<RunChainResult>`

- [ ] **Step 1: Add the module-scope `runChain` function**

Immediately AFTER `runLegWithBudget` (ends ~line 177) in `extensions/subagent/index.ts`, add `runChain`. Its body is the exact contents of the current `if (params.chain …)` block with these purely mechanical substitutions:
- `ctx.cwd` → `opts.cwd`
- `agents` → `opts.agents`
- `params.chain` → `opts.chain`
- `params.toolsOverride` → `opts.toolsOverride`
- `signal` → `opts.signal`
- `onUpdate` → `opts.onUpdate`
- `makeDetails("chain")` → `opts.makeDetails`
- Move the local helper `fullFinalText` (currently defined inside `execute`) to inside `runChain` (it is only used by chain logic).
- Every place that currently does `return chainError(i + 1, step.agent, result)` (or `followUp`, or `r`) becomes `return { results, error: { stepNo: i + 1, agentName: step.agent, result: <that result> } }`.
- The final success `return { content: […], details: makeDetails("chain")(results) }` becomes `return { results, error: null }`.
- Delete the now-unused inner `chainError` closure from `runChain` (the caller formats errors).

Signature and skeleton:

```ts
export interface RunChainOpts {
	cwd: string;
	agents: AgentConfig[];
	chain: Array<{ agent: string; task: string; cwd?: string }>;
	toolsOverride?: string[];
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
}

export interface RunChainResult {
	results: SingleResult[];
	error: { stepNo: number; agentName: string; result: SingleResult } | null;
}

export async function runChain(opts: RunChainOpts): Promise<RunChainResult> {
	const results: SingleResult[] = [];
	let previousOutput = "";
	const cfg = subagentSettings();
	const decomposeOn = cfg.decomposeOnFailure !== false;
	const maxExtraLegs = typeof cfg.decomposeMaxExtraLegs === "number" ? cfg.decomposeMaxExtraLegs : 6;
	let extraLegsUsed = 0;

	const fullFinalText = (r: SingleResult): string => {
		for (let m = r.messages.length - 1; m >= 0; m--) {
			const msg = r.messages[m] as { role?: string; content?: Array<{ type?: string; text?: string }> };
			if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
			const text = msg.content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
			if (text.trim()) return text;
		}
		return "";
	};

	const legFailed = (r: SingleResult): { failed: boolean; hard: boolean; reason: string } => {
		const hard = r.exitCode !== 0 || r.stopReason === "error";
		if (hard) return { failed: true, hard: true, reason: r.errorMessage || r.stderr || "hard error" };
		if (!decomposeOn) return { failed: false, hard: false, reason: "" };
		const v = parseLegVerdict(fullFinalText(r));
		if (v.found && !v.ok) return { failed: true, hard: false, reason: v.reason ?? "verdict: not ok" };
		return { failed: false, hard: false, reason: "" };
	};

	for (let i = 0; i < opts.chain.length; i++) {
		const step = opts.chain[i];
		let taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
		if (decomposeOn) taskWithContext += VERDICT_INSTRUCTION;

		const chainUpdate: OnUpdateCallback | undefined = opts.onUpdate
			? (partial) => {
					const currentResult = partial.details?.results[0];
					if (currentResult) {
						opts.onUpdate!({ content: partial.content, details: opts.makeDetails([...results, currentResult]) });
					}
				}
			: undefined;

		const result = await runLegWithBudget(
			opts.cwd, opts.agents, step.agent, taskWithContext, step.cwd, i + 1, opts.signal, chainUpdate, opts.makeDetails, opts.toolsOverride,
		);
		results.push(result);

		const aborted = result.stopReason === "aborted";
		const configError = (result.stderr || "").startsWith("Unknown agent");
		const fail = legFailed(result);

		if (!fail.failed && !aborted) {
			previousOutput = stripVerdictBlocks(getFinalOutput(result.messages));
			const gateOn =
				cfg.testRunGate !== false &&
				(!opts.toolsOverride || opts.toolsOverride.length === 0 || opts.toolsOverride.includes("bash"));
			const untested = gateOn ? untestedTestEdits(result) : null;
			if (untested) {
				let followTask =
					`Verification follow-up: the previous step modified test files (${untested.join(", ")}) ` +
					`but never executed any tests. Run the relevant tests now with the project's runner ` +
					`(check package.json scripts / Makefile), fix any failures that step introduced, and ` +
					`report pass/fail counts.` +
					(previousOutput ? `\n\nWhat the previous step did:\n${previousOutput}` : "");
				if (decomposeOn) followTask += VERDICT_INSTRUCTION;
				const followUp = await runLegWithBudget(
					opts.cwd, opts.agents, step.agent, followTask, step.cwd, i + 1, opts.signal, chainUpdate, opts.makeDetails, opts.toolsOverride,
				);
				followUp.stepLabel = `${i + 1}.v`;
				results.push(followUp);
				const followFail = legFailed(followUp);
				const followVerdict = parseLegVerdict(fullFinalText(followUp));
				logDecompose({
					step: i + 1, agent: step.agent, trigger: "test-gate",
					reason: `untested test edits: ${untested.join(", ")}`,
					ran: followVerdict.ran, outcome: followFail.failed ? "followup-failed" : "followup-ok",
				});
				if (followFail.failed || followUp.stopReason === "aborted") {
					return { results, error: { stepNo: i + 1, agentName: step.agent, result: followUp } };
				}
				previousOutput = stripVerdictBlocks(getFinalOutput(followUp.messages));
			}
			continue;
		}

		if (aborted || !decomposeOn || configError || extraLegsUsed + 2 > maxExtraLegs) {
			logDecompose({
				step: i + 1, agent: step.agent, trigger: fail.hard ? "exit" : "verdict",
				reason: scrubEvidence(fail.reason),
				outcome: aborted ? "aborted" : !decomposeOn ? "disabled" : configError ? "config-error" : "cap-reached",
			});
			return { results, error: { stepNo: i + 1, agentName: step.agent, result } };
		}

		const evidence = scrubEvidence(fail.reason || fullFinalText(result));
		const splitPrompt =
			`A chain step failed and must be split. Failed step (agent: ${step.agent}):\n` +
			`${taskWithContext.slice(0, 4000)}\n\nFailure evidence: ${evidence}\n\n` +
			`Split it into 2-4 smaller sub-steps that together accomplish the original step; ` +
			`each must be independently executable by the same agent in a few tool calls. ` +
			`Output ONLY a numbered list (1. ... 4.), one sub-step per line, no preamble.`;
		const split = await runSingleAgent(
			opts.cwd, opts.agents, "splitter", splitPrompt, step.cwd, i + 1, opts.signal, chainUpdate, opts.makeDetails, opts.toolsOverride, maxStepsPerLeg(),
		);
		const subTasks = parseNumberedList(fullFinalText(split)).slice(0, Math.min(4, maxExtraLegs - extraLegsUsed));
		if (split.exitCode !== 0 || split.stopReason === "error" || subTasks.length < 2) {
			logDecompose({
				step: i + 1, agent: step.agent, trigger: fail.hard ? "exit" : "verdict", reason: evidence, outcome: "split-unparseable",
			});
			return { results, error: { stepNo: i + 1, agentName: step.agent, result } };
		}

		result.decomposed = true;
		let subPrev = previousOutput;
		let rescued = true;
		for (let k = 0; k < subTasks.length; k++) {
			let subTask =
				`${subTasks[k]}\n\nOriginal goal (this is one part of it): ${step.task.slice(0, 500)}` +
				(subPrev ? `\n\nContext from earlier work:\n${subPrev}` : "");
			if (decomposeOn) subTask += VERDICT_INSTRUCTION;
			const r = await runSingleAgent(
				opts.cwd, opts.agents, step.agent, subTask, step.cwd, i + 1, opts.signal, chainUpdate, opts.makeDetails, opts.toolsOverride, maxStepsPerLeg(),
			);
			r.stepLabel = `${i + 1}.${k + 1}`;
			results.push(r);
			extraLegsUsed++;
			const subFail = legFailed(r);
			if (subFail.failed || r.stopReason === "aborted" || r.budgetExceeded) {
				logDecompose({
					step: i + 1, agent: step.agent, trigger: fail.hard ? "exit" : "verdict",
					reason: evidence, subStepCount: subTasks.length, outcome: "sub-step-failed",
				});
				rescued = false;
				return { results, error: { stepNo: i + 1, agentName: step.agent, result: r } };
			}
			subPrev = stripVerdictBlocks(getFinalOutput(r.messages));
		}
		if (rescued) {
			logDecompose({
				step: i + 1, agent: step.agent, trigger: fail.hard ? "exit" : "verdict",
				reason: evidence, subStepCount: subTasks.length, outcome: "rescued",
			});
			previousOutput = subPrev;
		}
	}
	return { results, error: null };
}
```

- [ ] **Step 2: Delegate from `execute`**

Replace the entire `if (params.chain && params.chain.length > 0) { … }` block inside `execute` with a thin delegator that preserves the exact same tool-result shape:

```ts
if (params.chain && params.chain.length > 0) {
	const makeChainDetails = makeDetails("chain");
	const { results, error } = await runChain({
		cwd: ctx.cwd,
		agents,
		chain: params.chain,
		toolsOverride: params.toolsOverride,
		signal,
		onUpdate,
		makeDetails: makeChainDetails,
	});
	if (error) {
		const r = error.result;
		const errorMsg = r.errorMessage || r.stderr || getFinalOutput(r.messages) || "(no output)";
		return {
			content: [{ type: "text", text: `Chain stopped at step ${error.stepNo} (${error.agentName}): ${errorMsg}` }],
			details: makeChainDetails(results),
			isError: true,
		};
	}
	return {
		content: [{ type: "text", text: stripVerdictBlocks(getFinalOutput(results[results.length - 1].messages)) || "(no output)" }],
		details: makeChainDetails(results),
	};
}
```

- [ ] **Step 3: NUL-byte check**

Run: `python3 -c "print(open('extensions/subagent/index.ts','rb').read().count(b'\x00'))"`
Expected: `0`

- [ ] **Step 4: Loader gate**

Run: `npm run test:extensions`
Expected: PASS. `extensions/subagent/index.ts` is a known SKIP; the point is that the whole gate still exits 0 and the critic tests pass.

- [ ] **Step 5: Runtime smoke — exercise the load-bearing branches, not just the happy path (tmux, never `pi -p`)**

The extraction rewires the returns/telemetry of the D4 decompose split and the test-run gate follow-up — a happy-path chain never touches those (review C2). Run two smokes in a scratch dir (e.g. `/home/kh0pp/tmp/wschain`, a throwaway git repo with a `package.json` `test` script over one `*.test.js`), driving the subagent tool via `tmux send-keys` (never `pi -p` — chain runs are tool events, but drive through a real session to be safe).

Smoke A — happy path + `{previous}` threading: a 2-step `worker` chain, step 1 writes `one` to a file, step 2 reads it (via `{previous}`) and writes `two`. Confirm both files and both steps reported.

Smoke B — test-run gate fires post-extraction: one `worker`/`editor` step that EDITS a `*.test.js` file but is told NOT to run the tests. Confirm a follow-up leg appears with `stepLabel: "N.v"` AND a `~/.pi/agent/decompose-log.jsonl` row with `trigger:"test-gate"`. This proves the extracted gate still triggers and logs.

```bash
# after each smoke:
tail -3 ~/.pi/agent/decompose-log.jsonl    # Smoke B: expect a trigger:"test-gate" row
tmux kill-session -t wschain
```

Expected: Smoke A files correct; Smoke B produces the `N.v` follow-up leg and the `test-gate` decompose-log row. (A full decompose-split smoke — a leg that emits `ok:false` and gets split into sub-legs with `stepLabel` `N.k` and a `rescued`/`sub-step-failed` row — is ideal but harder to force deterministically; if time permits, force it by giving a step an impossible sub-goal and confirm a `rescued` or `sub-step-failed` row. At minimum, Smoke B must pass.)

- [ ] **Step 6: Commit**

```bash
git add extensions/subagent/index.ts
git commit -m "subagent: extract runChain() from the chain tool executor (WS2 prep)"
```

---

## Task 6: `dispatchFixChain()` — cluster the findings and run them through `runChain`

**Files:**
- Create: `extensions/critic/fix-dispatch.ts`

**Interfaces:**
- Consumes: `runChain`, `RunChainResult` (Task 5); `clusterFindings`, `buildFixChain`, `FindingRef`, `SubsystemDef`, `Cluster` (Tasks 1-3); `discoverAgents` (`../subagent/agents.js`); `SingleResult`, `SubagentDetails` (`../subagent/run.js`); `isRunning`, `startModel`, `readLocalModels` (`../../lib/local-models.mjs`).
- Produces:
  - `interface FixDispatchDeps { cwd: string; findings: FindingRef[]; subsystems: Record<string, SubsystemDef>; changedFiles: string[]; maxClusters: number; fixModel?: string; sessionModel: string | null; notify: (m: string, s?: "info" | "warning" | "error") => void; signal?: AbortSignal }`
  - `interface FixDispatchOutcome { dispatched: boolean; reason?: string; clusters: number; results: SingleResult[]; error: RunChainResult["error"] }`
  - `export async function dispatchFixChain(d: FixDispatchDeps): Promise<FixDispatchOutcome>`

`dispatched: false` with a `reason` tells the caller to fall back to the message path (e.g. no `fixer` agent, or zero clusters).

**Model-lifecycle contract (fixes review C1 — the strand-on-wrong-model race).** Fix-dispatch runs right after the critique's composed restore (`index.ts:1018`) has *kicked* a fire-and-forget background reload of the session's local model — so at dispatch time the session model is typically still loading and `findRunningManaged()` would return a transient (e.g. the refute model). Therefore fix-dispatch must NOT use `ensureCriticModel` (which recomputes `prev` from whatever is momentarily running and would restore to it). Instead the caller passes `sessionModel` — the managed local captured ONCE, before the critique swapped anything — and dispatch restores to exactly that. Dispatch manages the slot with the raw `local-models.mjs` primitives: ensure `fixModel` is serving (start only if not already running), and afterward, only if `sessionModel` is a managed local different from `fixModel`, background-restart `sessionModel`. When `fixModel === sessionModel` (the common 35b case) there is no swap and no restore — just a wait for the in-flight reload to finish.

- [ ] **Step 1: Write the module**

Create `extensions/critic/fix-dispatch.ts`:

```ts
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
```

- [ ] **Step 2: NUL-byte check + loader gate**

Run: `python3 -c "print(open('extensions/critic/fix-dispatch.ts','rb').read().count(b'\x00'))"` → expect `0`
Run: `npm run test:extensions` → expect PASS.

Note on the gate (review S1): the gate loops `for f in extensions/*.ts extensions/*/index.ts` — that glob matches only top-level `extensions/*.ts` and each subdir's `index.ts`. It does NOT match `extensions/critic/fix-dispatch.ts` or `extensions/critic/cluster.ts`, so neither is loaded by the gate and NO skip-list edit is needed. Just confirm `npm run test:extensions` still passes unchanged. (Do not add a `case` entry for `fix-dispatch.ts` — it would be dead code the loop never reaches.)

- [ ] **Step 3: Commit**

```bash
git add extensions/critic/fix-dispatch.ts
git commit -m "critic: dispatchFixChain — clustered fixer legs via runChain (WS2)"
```

---

## Task 7: Wire fix-dispatch into the critic send-findings branch

**Files:**
- Modify: `extensions/critic/index.ts`

**Interfaces:**
- Consumes: `dispatchFixChain` (Task 6); the existing `ensureCriticModel`, `loadSubsystems`, `loadConfig` in `index.ts`; `verdicts`, `changedList`, `ctx`, `cfg`, `row` in scope in the send-findings branch (~line 1097).

- [ ] **Step 1: Add config fields**

In the `CriticConfig` interface (near line 78), add:

```ts
	/** Fix-dispatch mode for "Send findings": clustered fixer chain, single message, or off. */
	fixDispatch?: "chain" | "message" | "off";
	/** Max fix clusters (smallest merged beyond the cap). */
	fixMaxClusters?: number;
	/** Force this model on the fixer legs (default: the fixer agent's own model). */
	fixModel?: string;
```

`loadConfig()` already spreads the raw `critic` settings object, so these need no explicit parsing there — confirm by reading `loadConfig` and, if it maps fields explicitly rather than spreading, add the three fields to the mapping.

- [ ] **Step 2: Track plan-mode state**

Near the top of the extension's default function (where other `pi.events.on(...)` bridges are registered), add a plan-mode state tracker mirroring the tournament's:

```ts
	let planState = { enabled: false, executing: false };
	pi.events.on("plan-mode:state", (d) => {
		const s = d as { enabled?: boolean; executing?: boolean };
		planState = { enabled: Boolean(s.enabled), executing: Boolean(s.executing) };
	});
```

- [ ] **Step 3: Import dispatchFixChain**

Add to the imports at the top of `extensions/critic/index.ts`:

```ts
import { dispatchFixChain } from "./fix-dispatch.js";
import type { FindingRef } from "./cluster.js";
```

- [ ] **Step 4: Capture the session's local model BEFORE any critique model swap (review C1)**

The restore target for fix-dispatch must be the model the session was on before the critics/refute-pass swapped anything — not whatever is momentarily running when "Send findings" fires (by then the composed restore at `index.ts:1018` has kicked a still-in-flight reload). Capture it once, early in `runCritique`'s body, BEFORE the `if (modelOverride)` ensure block (~line 887). `findRunningManaged()` is already module-scope in `index.ts`:

```ts
			// Session's managed local model, captured BEFORE any critic/refute swap,
			// so fix-dispatch can restore to it deterministically (never to a
			// transient mid-reload model). null when the session isn't on a managed
			// local (cloud model → nothing to restore; local slot is free game).
			const sessionLocalModel = await findRunningManaged();
```

Declare `sessionLocalModel` at `runCritique`'s **function-body scope** — the same level as `changedList` (~line 776) and `subsystems` (~line 807), so it is still in scope at the send-findings branch (~1097) — immediately before the `if (modelOverride)` block at ~887. Do NOT put it inside the inner `try` that starts at ~923 (a `const` there is block-scoped and would be out of scope at 1097 → compile error). Nothing swaps the model before this point (`pickCriticModel` at ~855 only selects a ref; it never calls `startModel`), so `findRunningManaged()` returns the true pre-critique session model. It adds one `findRunningManaged()` call (a few `/health` probes) per critique — negligible next to running the critics.

- [ ] **Step 5: Branch the send-findings block**

Replace the current `if (send) { … pi.sendUserMessage(...) }` body (~lines 1097-1108) with a dispatch-mode branch. The `row.userSentFindings = send;` line already exists at ~1096 just above the `if (send)` — either start your cut at 1096 (replacing the assignment too) OR drop the leading `row.userSentFindings = send;` from the snippet below so it isn't set twice (harmless if duplicated, but keep it clean). Keep the exact current message text as the `"message"` fallback in a local helper so behavior is unchanged when `fixDispatch: "message"`:

```ts
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
							ctx.ui.notify("Fix-dispatch: plan mode active — sending findings as a message instead of spawning fixer legs.", "info");
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
								ctx.ui.notify(`Fix-dispatch: ${outcome.clusters} cluster(s) fixed across ${outcome.results.length} leg(s). Run /critique to judge the fixes.`, "info");
							}
						} catch (err) {
							ctx.ui.notify(`Fix-dispatch errored (${String((err as Error)?.message ?? err)}) — sending findings as a message.`, "warning");
							sendMessageFallback();
						}
					}
				}
```

Notes:
- `subsystems` is in scope in this branch (loaded ~line 807 in the same `runCritique` function); `sessionLocalModel` comes from Step 4; `changedList` from ~line 776.
- **Live progress is intentionally NOT streamed (review S2, accepted deviation).** Fix-dispatch runs the fixer legs silently, exactly like the sibling `critiqueArtifact`/refute-pass subagent calls in this same extension — those also don't thread `onUpdate`. Traceability instead comes from the pre-dispatch notify (lists cluster names), the per-outcome summary notify, `~/.pi/agent/fix-dispatch-log.jsonl`, and the per-leg rows in `decompose-log.jsonl`. Threading `onUpdate` → `pi.sendMessage` for live per-leg progress is a reasonable follow-up, out of scope for v1.
- **Handoff/bg-task guards are intentionally omitted (review S5).** Unlike the tournament (which suspends checkpoints and runs unattended on the auto path), fix-dispatch fires only from behind the interactive `ctx.hasUI && !busPayload.handled` "Send findings" confirm — a human is present and chose to dispatch. Plan-mode is the one guard that matters (a read-only plan must not be violated by write-capable fixer legs), and it is handled above. This matches the message path, which has no handoff/bg guards either.

- [ ] **Step 6: NUL-byte check**

Run: `python3 -c "print(open('extensions/critic/index.ts','rb').read().count(b'\x00'))"`
Expected: `0`

- [ ] **Step 7: Loader gate**

Run: `npm run test:extensions`
Expected: PASS (critic/index.ts is a SKIP; the cluster/refute/context tests pass).

- [ ] **Step 8: Commit**

```bash
git add extensions/critic/index.ts
git commit -m "critic: dispatch clustered fixer legs on Send-findings (critic.fixDispatch) (WS2)"
```

---

## Task 8: Runtime validation — clustered fixer legs on a real multi-cluster diff (tmux)

Validate end-to-end that "Send findings" now spawns one fixer leg per cluster, the test-run gate fires per leg, and the working tree is coherently fixed. Use a controlled scratch repo so the run is reproducible and does NOT touch `~/life` (that work is deferred/uncommitted).

**Files:** none (validation only).

- [ ] **Step 1: Build a two-cluster scratch repo**

Use an explicit scratch path — `$CLAUDE_JOB_DIR` is NOT set inside a tmux `pi` session (it belongs to this Claude Code job, not pi). Use `SCRATCH=$(mktemp -d /home/kh0pp/tmp/fixdemo.XXXX)` (or any dir outside `~/life`). Create a throwaway git repo there with:
- `package.json` with a real `test` script (e.g. `node --test` over two `*.test.js` files),
- two source files in different directories (so they cluster separately), each with a small, real bug a critic would flag (e.g. an off-by-one and a missing null-check),
- a `.pi/critique.json` declaring one subsystem covering one of the files with an invariant,
- a committed baseline so `git diff` shows the buggy change.

This scratch repo is deliberately isolated and never touches `~/life` (deferred/uncommitted).

- [ ] **Step 2: Run a critique that fails, then Send findings — in tmux**

```bash
tmux new-session -d -s fixdemo "cd $SCRATCH && pi"
# send-keys: /critique   (wait for the FAILED verdict + the "Send findings" card)
# answer the card: Send findings
# wait for the fixer legs to complete
```

Watch for: the `Fix-dispatch: N clusters → fixer legs…` notice, one leg per cluster in the subagent progress, and (for any leg that edits a test file) a `N.v` test-gate follow-up leg.

- [ ] **Step 3: Confirm the outcome**

- `git diff` in the scratch repo shows both bugs fixed, changes confined to each cluster's files.
- `npm test` in the scratch repo passes.
- `~/.pi/agent/fix-dispatch-log.jsonl` has a row listing the clusters.
- `~/.pi/agent/decompose-log.jsonl` shows any `test-gate` / `rescued` rows that fired.
- A follow-up `/critique` runs in fix-review mode and judges the fixes (sidecar carried the prior findings).

- [ ] **Step 4: Verify the fallbacks (no new commits)**

- Set `critic.fixDispatch: "message"` in `~/.pi/agent/settings.json`, restart the tmux pi, repeat: confirm the OLD single-message behavior (one `sendUserMessage`, no fixer legs).
- With `fixDispatch` back to `"chain"`, enter plan mode, run a critique that fails, Send findings: confirm the "plan mode active — sending findings as a message" fallback.

- [ ] **Step 5: Tear down**

```bash
tmux kill-session -t fixdemo
rm -rf "$SCRATCH"
```

No commit — this task produces only confirmation that the wired behavior works.

---

## Task 9: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/ROADMAP.md`
- Modify: `extensions/critic/index.ts` (config doc comment block only)

- [ ] **Step 1: CLAUDE.md — critic bullet**

In the `## Key subsystems` → Critics bullet, add a sentence documenting fix-dispatch: findings clustered by subsystem/file into one `fixer` chain leg per cluster via the shared `runChain()`, so the test-run gate + D4 fire per cluster; config `critic.fixDispatch` = `chain` (default) | `message` (legacy single send-findings message) | `off`, `critic.fixMaxClusters` (6), `critic.fixModel`; plan-mode active falls back to the message path; telemetry `~/.pi/agent/fix-dispatch-log.jsonl`. Mention `runChain` was extracted from the subagent tool so critic and `/implement` share the exact chain path.

- [ ] **Step 2: ROADMAP.md — mark Workstream 2 landed**

Add a LANDED entry for structured fix-dispatch (K2 editor/fixer-leg chain) referencing the design doc and this plan, and note the interaction with the flip-gate telemetry (cluster labels).

- [ ] **Step 3: Config doc comment in `extensions/critic/index.ts`**

Extend the config example comment block near the top of `index.ts` (the `"diverseModel"/"recallProbeEvery"` block ~lines 32-33) with the three `fix*` keys and one-line meanings.

- [ ] **Step 4: NUL-byte check + gate**

Run: `python3 -c "print(open('extensions/critic/index.ts','rb').read().count(b'\x00'))"` → expect `0`
Run: `npm run test:extensions` → expect PASS.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/ROADMAP.md extensions/critic/index.ts
git commit -m "docs: structured fix-dispatch (WS2) — critic bullet, config, ROADMAP"
```

---

## Self-Review

**Spec coverage** (design doc Workstream 2):
- Clustering by subsystem then file then general, cap/merge → Task 2 (`clusterFindings`). ✓
- Findings cite files via detail parsing → Task 1 (`extractPrimaryFile`). ✓
- One editor/fixer leg per cluster via the chain runner with `{previous}` threading → Tasks 3 (`buildFixChain`), 5 (`runChain`), 6 (`dispatchFixChain`). ✓
- Runs through the same path `/implement` uses (chain → runLegWithBudget → test-run gate → D4) → Task 5 extraction makes this literally the same code. ✓
- Config `critic.fixDispatch` = chain|message|off, default chain → Task 7. ✓ (`fixMaxClusters`, `fixModel` added.)
- Spawned from the critic extension, not the main agent (isolation) → Task 6/7 (`dispatchFixChain`, not `sendUserMessage`). ✓
- Guardrails: bot-exclusion (inherited), plan-mode fallback, toolsOverride (none — fixer needs write+bash) → Global Constraints + Task 7 plan-mode branch. ✓
- Traceability: per-cluster labels in progress + decompose-log + a fix-dispatch-log → Task 6 telemetry, Task 8 validation. ✓
- Interaction with fix-review: next `/critique` judges the fixes → Task 8 Step 3. ✓
- Testing: unit-test `clusterFindings` (subsystem/file/cap/general), runtime dispatch of a multi-cluster diff → Tasks 2, 8. ✓

**Deferred (design doc "later", not in v1):** per-cluster micro-critique (`critic.fixReviewPerCluster`) — explicitly deferred in the spec, not planned here.

**Placeholder scan:** every code step contains full code; no TBD/TODO/"add error handling" placeholders. ✓

**Type consistency:** `FindingRef`, `SubsystemDef`, `Cluster` defined in Task 2 and used unchanged in Tasks 3/6/7; `RunChainOpts`/`RunChainResult` defined in Task 5 and consumed in Task 6; `dispatchFixChain`'s `FixDispatchDeps`/`FixDispatchOutcome` defined in Task 6 and consumed in Task 7. `sessionModel: string | null` in `FixDispatchDeps` (Task 6) is fed by `sessionLocalModel = await findRunningManaged()` (Task 7 Step 4), whose return type is `Promise<string | null>`. ✓

## Risks / open items

- **Model thrash on the single slot (bounded, correctness preserved).** Fix-dispatch is a third swap point after the critics + refute-pass. It restores to `sessionModel` captured ONCE before any swap (Task 7 Step 4), never to a recomputed "currently running" model — so it can no longer strand the session on a transient model (review C1). Common case `fixModel === sessionModel` (35b): no swap, no restore, just a wait for the in-flight reload. The serialize-behind-one-mutex follow-up (ROADMAP "Known follow-up" 2c) is still the real fix for overlapping loads; this plan makes the outcome correct but not maximally efficient.
- **Premature `isRunning` after the in-flight reload (validate in Task 8).** `isRunning` probes `/v1/models`, which llama.cpp answers 200 while weights are still loading. Because the refute-pass almost always swaps, the composed restore at `index.ts:1018` is usually reloading the session model when fix-dispatch fires — so `isRunning(fixModel)` may return true prematurely and dispatch skips its own `startModel`, sending fixer legs at a not-yet-ready model. This is pre-existing behavior the plan inherits (a fixer leg's first request could 503 until `/health` is green). During Task 8 runtime validation, watch the first fixer leg for a transient model-not-ready error; if it bites, gate dispatch's readiness on `/health` (as `startModel` does) rather than `isRunning`. Not a revision defect — flagged so validation catches it.
- **Clustering depends on findings citing files.** The evidence/quote rule (Workstream 1, shipped) raised citation rates, which helps clustering — nice compounding. Findings with no locatable file collapse into `general`, which still gets fixed (just less isolated).
- **`runChain` extraction is the riskiest change** (load-bearing D4 logic, can't unit-test). Mitigated by making it a mechanical move and gating on the tmux smokes — happy-path + the test-run-gate branch (Task 5 Step 5, review C2) — before anything depends on it.
- **`fix-dispatch.ts` importing `../subagent/index.js`** pulls the whole subagent extension module at critic load. No cycle (subagent does not import critic) and no double-registration (importing a module does not call its default export). The loader gate's glob does not match `fix-dispatch.ts`, so no skip-list edit is needed (review S1).

## Review

**Reviewer:** staff-engineer adversarial review (Plan subagent), 2026-07-06.
**Verdict:** REVISE → all critical issues and suggestions addressed inline (below); no redesign required. The reviewer independently verified as SOUND: the `runChain` variable-capture completeness + byte-for-byte tool-result equivalence, the plan-mode fallback being race-free (synchronous `plan-mode:get`→`state`), bot-exclusion inheritance, the `globToRegExp` U+0001 sentinel, no import cycle / no double-registration, `forceModel` wiring, and `clusterFindings` determinism.

Resolutions:
- **C1 (model-lifecycle strand race)** — FIXED. Dropped `ensureCriticModel`'s recomputed-`prev` restore; dispatch now takes `sessionModel` captured once before any swap (Task 7 Step 4) and restores to exactly that via raw `local-models.mjs` primitives (Task 6). Risks section + Model-lifecycle contract updated.
- **C2 (smoke misses decompose/test-gate branches)** — FIXED. Task 5 Step 5 now requires a test-run-gate smoke (`N.v` follow-up + `trigger:"test-gate"` decompose-log row), with a decompose-split smoke encouraged.
- **S1 (loader-gate premise wrong)** — FIXED. Removed the dead skip-list edit; the gate glob doesn't match `fix-dispatch.ts`.
- **S2 (no live progress)** — RESOLVED as an accepted deviation: silent legs match the sibling `critiqueArtifact`/refute-pass pattern; traceability via notifies + logs; `onUpdate` threading noted as follow-up (Task 7 Step 5 notes).
- **S3 (`extractPrimaryFile` framework false-positives)** — FIXED. Added `FRAMEWORK_DENY` + three tests (Task 1).
- **S4 (unbounded log)** — FIXED. `logDispatch` now caps at 2000→1000 lines like `logDecompose` (Task 6).
- **S5 (handoff/bg guards)** — RESOLVED: rationale documented (dispatch is behind the interactive confirm; only plan-mode matters) (Task 7 Step 5 notes).
- **Q3 (`$CLAUDE_JOB_DIR` in tmux)** — FIXED. Task 8 uses an explicit `mktemp -d` scratch path, never `~/life`.

**Second round (2026-07-06):** VERDICT **APPROVE — ready to execute.** The reviewer verified against real code that the C1 resolution is correct (nothing swaps the model before the `sessionLocalModel` capture point — `pickCriticModel` at ~855 only selects, never starts; `findRunningManaged` returns `Promise<string|null>`; `startModel` is idempotent and fail-open-wrapped), the `../../lib/local-models.mjs` import path + exports are right, and the `extractPrimaryFile` global-regex rewrite keeps the lookbehind and terminates. No critical issues. Applied its two wording fixes (Task 7 Step 4 function-body-scope placement footgun; the duplicate `row.userSentFindings` cut point) and recorded its health-gate question (premature `isRunning` after the 1018 reload) as a Task 8 validation item in Risks.
