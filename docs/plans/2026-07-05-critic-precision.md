# Critic Precision (Workstream 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce critic false positives and cross-file blindness — an evidence rule for behavioral blockers, sibling-file context, and an adversarial refute-pass that downgrades disproven blockers.

**Architecture:** Two prompt edits + two new PURE modules (`context.ts`, `refute.ts`, no pi imports so the loader gate stays meaningful) + a post-verdict refute stage wired into `runCritique` in `extensions/critic/index.ts`. The refute stage spawns a `refuter` agent on a DIFFERENT local model per blocker; a refuted blocker is downgraded to warn (never dropped). All downgrade/recount logic lives in the pure module (`applyRefutations`) so its invariants are unit-tested.

**Tech Stack:** TypeScript (jiti runtime, no build), pi subagent runner (`extensions/subagent/run.ts`), llama.cpp local models via `lib/local-models.mjs`. No vitest — pure modules are tested with esbuild→node assertion scripts; event-driven behavior is validated in a tmux pi session.

## Global Constraints

- Extensions load via jiti at pi session start — NO build step; edit and restart the session.
- `extensions/critic/index.ts` is a loader-gate SKIP (value-imports pi internals). New pure logic MUST go in modules with NO pi imports (like `extensions/subagent/verdict.ts`) so `npm run test:extensions` stays meaningful.
- NEVER runtime-verify event-driven code with `pi -p` (lifecycle events/bus don't fire in print mode, v0.74.2). Use `tmux send-keys`.
- Bot-exclusion invariant: the critic extension spawns subagents and manages model servers (ambient side effects) — it must no-op when `PI_BOT_PERMISSION_POLICY` is set or `PIBOT_SUBAGENT_DEPTH >= 1` (Task 4 adds this guard; it is currently missing).
- Local model policy: ONE local model at a time; every managed model evicts the others. Any refute-model start MUST use `ensureCriticModel`, and its restore must COMPOSE with the main critique's restore (keep the FIRST non-null restore closure — it points at the true original model; discard later ones). Never let two restores race.
- **Fail-closed parse errors are inviolable:** a verdict with `parseError` set NEVER becomes `passed: true`, no matter how many of its findings are refuted ("Unparseable output counts as FAILED", critic/index.ts header).
- No literal NUL or other control characters in source strings — write the 6-character escape sequence backslash-u-0-0-0-0 in string literals. After any edit that should contain it, verify with: `python3 -c "print(open('FILE','rb').read().count(b'\x00'))"` → must print 0.
- Commit messages: never attribute Claude as author/co-author.
- Model refs are always `provider/id` form.

## Decisions from plan review (2026-07-05)

- **Sidecar (fix-review) excludes refuted findings** — a disproven claim must not be re-litigated as an "original finding" in the next fix-review run. `saveLastFindings` filters `finding.refuted === true`, and `passed` uses the POST-refute verdict state.
- **Refute-pass may swap local models on manual runs** — unlike the recall probe, it runs BEFORE the send-findings confirm, so no agent turn can race the swap; restores are composed (see Global Constraints). It runs only when blockers exist, capped.
- **Refute model resolution uses the actually-resolved main model** (`row.verdicts[*].model`) — not a hardcoded guess — so `/agent-models` re-binds don't silently break the "different model" guarantee.

---

### Task 1: Evidence-or-downgrade rule (1A)

Prompt-only. Make a **blocker** that asserts runtime behavior carry proof, else it is a warn.

**Files:**
- Modify: `extensions/subagent/agents/code-critic.md`
- Modify: `extensions/subagent/agents/test-critic.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing code-facing. Behavioral contract only.

- [ ] **Step 1: Add the evidence rule to code-critic.md**

In `extensions/subagent/agents/code-critic.md`, under the `Rules:` list (after the race-claim rule), add:

```markdown
- A finding marked **blocker** that asserts a RUNTIME outcome — a test fails, code
  crashes, a call returns the wrong value — must carry proof: either (a) the exact
  command you ran and its actual output, or (b) a verbatim quote of the code lines that
  make the claim true. Reading is not running: if a cheap test/repro command exists, run
  it. A blocker asserting runtime behavior with neither proof is not a blocker — mark it
  `warn` and say you could not verify it.
```

- [ ] **Step 2: Add the same rule to test-critic.md**

In `extensions/subagent/agents/test-critic.md`, under `Rules:`, add the identical block (a test-critic constantly asserts "this test will fail" — this is where the shell.spec false positive came from):

```markdown
- A finding marked **blocker** that asserts a RUNTIME outcome — a test fails, code
  crashes, a call returns the wrong value — must carry proof: either (a) the exact
  command you ran and its actual output, or (b) a verbatim quote of the code lines that
  make the claim true. Reading is not running: if a cheap test/repro command exists, run
  it. A blocker asserting runtime behavior with neither proof is not a blocker — mark it
  `warn` and say you could not verify it.
```

- [ ] **Step 3: Verify the agent files still parse (bridges are symlinks — no reinstall needed)**

Run: `head -6 extensions/subagent/agents/code-critic.md && head -6 extensions/subagent/agents/test-critic.md`
Expected: frontmatter intact (`name:`, `model:` lines present).

- [ ] **Step 4: Commit**

```bash
git add extensions/subagent/agents/code-critic.md extensions/subagent/agents/test-critic.md
git commit -m "critic prompts: blocker asserting runtime behavior must carry a run/quote or downgrade to warn"
```

---

### Task 2: Sibling-file context (1B)

When the diff touches a file, surface its same-directory siblings (e.g. `+page.server.ts` next to `+page.svelte`) so cross-file framework behavior is visible. Lock/generated and binary files are filtered inside the pure module (testable).

**Files:**
- Create: `extensions/critic/context.ts` (PURE — no pi imports)
- Create: `extensions/critic/context.test.mjs` (assertion script)
- Modify: `extensions/critic/index.ts` (wire the note into `runCritique`; add config field)

**Interfaces:**
- Produces: `selectSiblings(changedFiles: string[], lsFiles: string[], opts?: { maxPerDir?: number }): string[]` — repo-relative sibling paths (same dir as a changed file, not themselves changed, deduped, capped per directory, lock/generated/binary filtered).
- Produces: `SIBLING_MAX_PER_DIR = 6`, `SIBLING_SKIP_RE: RegExp` (exported consts).
- Consumes (in index.ts): `selectSiblings` plus existing `readFileSync`/`resolve`.

- [ ] **Step 1: Write the failing test**

Create `extensions/critic/context.test.mjs`:

```javascript
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Compile the pure module to ESM and import it.
const out = join(mkdtempSync(join(tmpdir(), "ctx-")), "context.mjs");
execFileSync("npx", ["esbuild", "extensions/critic/context.ts", `--outfile=${out}`, "--format=esm", "--log-level=warning"]);
const { selectSiblings } = await import(out);

const a = (n, c) => { if (!c) { console.error("FAIL", n); process.exit(1); } console.log("ok", n); };

const ls = [
  "src/routes/+page.svelte", "src/routes/+page.server.ts", "src/routes/+layout.svelte",
  "src/routes/tasks/+page.svelte", "src/routes/tasks/+page.server.ts",
  "src/lib/util.ts",
];

// touching +page.svelte surfaces its same-dir siblings, not itself, not other dirs
let s = selectSiblings(["src/routes/+page.svelte"], ls);
a("includes same-dir sibling", s.includes("src/routes/+page.server.ts"));
a("includes layout sibling", s.includes("src/routes/+layout.svelte"));
a("excludes the changed file itself", !s.includes("src/routes/+page.svelte"));
a("excludes other directories", !s.includes("src/routes/tasks/+page.server.ts"));

// a changed file with no siblings yields nothing
a("no siblings → empty", selectSiblings(["src/lib/util.ts"], ls).length === 0);

// siblings already in the diff are not repeated
s = selectSiblings(["src/routes/+page.svelte", "src/routes/+page.server.ts"], ls);
a("sibling already changed is excluded", !s.includes("src/routes/+page.server.ts"));

// lock/generated/binary siblings are filtered
const withJunk = ["pkg/index.ts", "pkg/package-lock.json", "pkg/logo.png", "pkg/helper.ts"];
s = selectSiblings(["pkg/index.ts"], withJunk);
a("lockfile filtered", !s.includes("pkg/package-lock.json"));
a("binary filtered", !s.includes("pkg/logo.png"));
a("real sibling kept", s.includes("pkg/helper.ts"));

// per-dir cap
const many = Array.from({ length: 20 }, (_, i) => `d/f${i}.ts`).concat(["d/changed.ts"]);
a("per-dir cap respected", selectSiblings(["d/changed.ts"], many, { maxPerDir: 6 }).length === 6);

console.log("ALL SIBLING TESTS PASS");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node extensions/critic/context.test.mjs`
Expected: FAIL (esbuild error "Could not resolve extensions/critic/context.ts" — file does not exist yet).

- [ ] **Step 3: Write the pure module**

Create `extensions/critic/context.ts`:

```typescript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node extensions/critic/context.test.mjs`
Expected: `ALL SIBLING TESTS PASS`.

- [ ] **Step 5: Confirm the loader gate accepts the new pure module**

Run: `./bin/pi-extension-check extensions/critic/context.ts`
Expected: `OK`.

- [ ] **Step 6: Add the config field**

In `extensions/critic/index.ts`, inside `interface CriticConfig`, add:

```typescript
	/** Include same-directory sibling files as critic context (default true). */
	siblingContext?: boolean;
	/** Byte budget for inlined sibling contents in single-artifact mode. */
	siblingMaxBytes?: number;
```

- [ ] **Step 7: Import the helper, hoist the repo file list, and build the sibling note**

In `extensions/critic/index.ts`, add to the top imports:

```typescript
import { selectSiblings } from "./context.js";
```

`runCritique` currently fetches `git ls-files` inside the subsystem block only. Hoist it so subsystem, sibling, and (Task 4) refute stages share ONE fetch. Find the subsystem block:

```typescript
			// Subsystem review: project-declared multi-file flows (.pi/critique.json).
			let subsystemNote = "";
			let subsystemNames: string[] = [];
			const subsystems = loadSubsystems(ctx.cwd);
			if (Object.keys(subsystems).length > 0 && changedList.length > 0) {
				try {
					const lsFiles = (await pi.exec("git", ["ls-files"], { cwd: ctx.cwd })).stdout.trim().split("\n").filter(Boolean);
```

Replace with a hoisted fetch used by both notes:

```typescript
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
```

and inside the block change `buildSubsystemNote(subsystems, changedList, lsFiles)` to `buildSubsystemNote(subsystems, changedList, repoFiles)` (delete the now-unused inner `lsFiles` fetch line).

Then, AFTER the subsystem block (and after the existing `const oversized = …` line, which is ALREADY declared before the fix-review note in current code — do not move it), add the sibling note builder:

```typescript
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
```

(The `"\u0000"` above is the 6-character escape sequence — verify after editing per Global Constraints.)

Finally append `siblingNote` into the shared note. Find `const sharedNote = subsystemNote + fixReviewNote;` and change to:

```typescript
			const sharedNote = subsystemNote + siblingNote + fixReviewNote;
```

- [ ] **Step 8: NUL check + syntax check**

Run:
```bash
python3 -c "print('nul bytes:', open('extensions/critic/index.ts','rb').read().count(b'\x00'))"
npx esbuild extensions/critic/index.ts --outfile=/tmp/crit-t2.js --format=esm --log-level=warning && echo SYNTAX-OK
```
Expected: `nul bytes: 0` then `SYNTAX-OK`.

- [ ] **Step 9: Runtime-verify in a SCRATCH repo tmux session (no `-p`; never `~/life` — a critique there overwrites the fix-review sidecar Task 4's validation depends on)**

Run:
```bash
SCRATCH=$(mktemp -d /tmp/crit-scratch-XXXX)
cd "$SCRATCH" && git init -q . && mkdir -p src/routes
printf '<p>page</p>\n' > src/routes/+page.svelte
printf 'export const load = () => ({});\n' > src/routes/+page.server.ts
git add -A && git commit -qm base
printf '<p>changed</p>\n' > src/routes/+page.svelte
tmux kill-session -t crit-t2 2>/dev/null; tmux new-session -d -s crit-t2 -c "$SCRATCH" -x 200 -y 50 'pi'
sleep 12
tmux send-keys -t crit-t2 '/critique' Enter
sleep 20
tmux capture-pane -pt crit-t2 -S -40 | grep -iE "Running.*critics|Extension.*error"
```
Expected: `Running 2 critics on the diff …` and NO `Extension … error` line. This is a load/wiring smoke only — let it run to verdict or kill AFTER it completes (`tmux kill-session -t crit-t2`); no model overrides are involved so no restore is pending.

- [ ] **Step 10: Commit**

```bash
git add extensions/critic/context.ts extensions/critic/context.test.mjs extensions/critic/index.ts
git commit -m "critic: sibling-file (route-bundle) context — surface same-dir files to critics"
```

---

### Task 3: Refuter contract + pure downgrade logic (1C, part 1)

Pure parser for the refuter's fenced verdict, fail-**open-to-blocker**, PLUS the pure `applyRefutations` that performs downgrades and recomputes verdict state — so the fail-closed invariant (parse-error verdicts never pass) is unit-tested, not hoped for.

**Files:**
- Create: `extensions/critic/refute.ts` (PURE — no pi imports)
- Create: `extensions/critic/refute.test.mjs`

**Interfaces:**
- Produces: `parseRefuterVerdict(output: string): { refuted: boolean; reason?: string }` — `refuted:true` ONLY on a clean explicit fenced `{"refuted": true, ...}` with keys ⊆ {refuted, reason} (strict-keys on the fail-dangerous direction); anything else → `{ refuted: false }` (blocker stands).
- Produces: `REFUTER_INSTRUCTION: string`.
- Produces: `RefutableFinding = { category?; severity?; detail?; refuted?: boolean }`, `RefutableVerdict = { passed: boolean; findings: RefutableFinding[]; parseError?: string }`.
- Produces: `applyRefutations(verdicts: Array<{ agent: string; verdict: RefutableVerdict }>, results: Array<{ agent: string; finding: RefutableFinding; refuted: boolean; reason: string }>): Array<{ agent: string; detail: string; reason: string }>` — mutates in place: refuted findings get `severity:"warn"`, `refuted:true`, detail prefixed with the rebuttal; every touched verdict's `passed` is recomputed as `no blockers remain AND !parseError`; returns the refutation list with the PRE-mutation detail.

- [ ] **Step 1: Write the failing test**

Create `extensions/critic/refute.test.mjs`:

```javascript
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = join(mkdtempSync(join(tmpdir(), "ref-")), "refute.mjs");
execFileSync("npx", ["esbuild", "extensions/critic/refute.ts", `--outfile=${out}`, "--format=esm", "--log-level=warning"]);
const { parseRefuterVerdict, applyRefutations } = await import(out);

const a = (n, c) => { if (!c) { console.error("FAIL", n); process.exit(1); } console.log("ok", n); };

// --- parseRefuterVerdict ---
let v = parseRefuterVerdict('The redirect is server-side.\n```json\n{"refuted": true, "reason": "+page.server.ts throws redirect(307)"}\n```');
a("explicit refuted parsed", v.refuted === true && /page\.server/.test(v.reason));

v = parseRefuterVerdict('```json\n{"refuted": false, "reason": "confirmed real"}\n```');
a("explicit not-refuted", v.refuted === false);

a("no verdict = not refuted", parseRefuterVerdict("I could not decide.").refuted === false);
a("garbled = not refuted", parseRefuterVerdict("```json\n{refuted: yes}\n```").refuted === false);
a("non-boolean refuted = stands", parseRefuterVerdict('```json\n{"refuted": "maybe"}\n```').refuted === false);

// strict-keys on the dangerous direction: unrelated JSON with extra keys must NOT refute
a("refuted:true with extra keys = stands", parseRefuterVerdict('```json\n{"refuted": true, "data": {"x": 1}}\n```').refuted === false);
// but refuted:false with extra keys is fine to accept as not-refuted
a("refuted:false with extra keys = stands", parseRefuterVerdict('```json\n{"refuted": false, "data": 1}\n```').refuted === false);

v = parseRefuterVerdict('```json\n{"refuted": false}\n```\nwait no\n```json\n{"refuted": true, "reason": "x"}\n```');
a("last block wins", v.refuted === true);

// --- applyRefutations ---
const mk = () => {
  const f1 = { category: "correctness", severity: "blocker", detail: "drain race" };
  const f2 = { category: "tests", severity: "blocker", detail: "shell.spec will fail" };
  const verdicts = [
    { agent: "code-critic", verdict: { passed: false, findings: [f1] } },
    { agent: "test-critic", verdict: { passed: false, findings: [f2] } },
    { agent: "broken-critic", verdict: { passed: false, findings: [], parseError: "no verdict" } },
  ];
  return { f1, f2, verdicts };
};

// refuted blocker downgrades; its verdict flips to passed; survivor's verdict stays failed
let { f1, f2, verdicts } = mk();
let refuted = applyRefutations(verdicts, [
  { agent: "test-critic", finding: f2, refuted: true, reason: "server-side redirect exists" },
  { agent: "code-critic", finding: f1, refuted: false, reason: "" },
]);
a("refuted count", refuted.length === 1);
a("pre-mutation detail captured", refuted[0].detail === "shell.spec will fail");
a("downgraded to warn", f2.severity === "warn" && f2.refuted === true);
a("rebuttal prefixed", f2.detail.startsWith("[refuted: server-side redirect exists]"));
a("survivor untouched", f1.severity === "blocker" && !f1.refuted);
a("refuted verdict now passes", verdicts[1].verdict.passed === true);
a("survivor verdict still fails", verdicts[0].verdict.passed === false);

// THE INVARIANT: a parse-error verdict NEVER flips to passed, even with zero blockers
a("parse-error verdict stays failed", verdicts[2].verdict.passed === false);

// all blockers of a parse-error verdict refuted (hypothetically) → still failed
const f3 = { severity: "blocker", detail: "x" };
const pv = [{ agent: "pe", verdict: { passed: false, findings: [f3], parseError: "boom" } }];
applyRefutations(pv, [{ agent: "pe", finding: f3, refuted: true, reason: "y" }]);
a("parse-error verdict stays failed even when its blockers refute", pv[0].verdict.passed === false);

console.log("ALL REFUTER TESTS PASS");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node extensions/critic/refute.test.mjs`
Expected: FAIL (esbuild cannot resolve `extensions/critic/refute.ts`).

- [ ] **Step 3: Write the pure module**

Create `extensions/critic/refute.ts`:

```typescript
/**
 * refute.ts — refuter verdict contract, parser, and downgrade logic (1C).
 * PURE: no pi imports.
 *
 * FAIL-OPEN-TO-BLOCKER: unlike the leg verdict (which fails open to success),
 * a refuter that produces no clean verdict leaves the blocker STANDING. A
 * broken/uncertain refuter must never erase a real blocker. `refuted: true`
 * additionally requires strict keys (⊆ {refuted, reason}) — the refuter has
 * read/bash tools and can quote arbitrary JSON into its transcript; unrelated
 * JSON must not erase a blocker.
 *
 * FAIL-CLOSED PARSE ERRORS: applyRefutations never sets `passed: true` on a
 * verdict carrying `parseError` — "unparseable output counts as FAILED" holds
 * no matter what gets refuted.
 */

export const REFUTER_INSTRUCTION =
	"\n\nEnd your reply with exactly one fenced JSON block, nothing after it:\n" +
	"```json\n" +
	'{"refuted": true|false, "reason": "one line — why the blocker is wrong, or why it stands"}\n' +
	"```\n" +
	'Set "refuted": true ONLY if you found a concrete reason the blocker is wrong (behavior ' +
	"implemented in another file, a framework mechanism that handles it, an existing test that " +
	"covers it, a false assumption about runtime). If you are unsure, set false — do not refute on vibes.";

export interface RefutableFinding {
	category?: string;
	severity?: string;
	detail?: string;
	/** Set by applyRefutations — lets the sidecar filter disproven findings. */
	refuted?: boolean;
}

export interface RefutableVerdict {
	passed: boolean;
	findings: RefutableFinding[];
	parseError?: string;
}

function tryParse(raw: string): Record<string, unknown> | null {
	try {
		const v = JSON.parse(raw);
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export function parseRefuterVerdict(output: string): { refuted: boolean; reason?: string } {
	const blocks = [...output.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)];
	for (let i = blocks.length - 1; i >= 0; i--) {
		const obj = tryParse(blocks[i][1].trim());
		if (!obj || typeof obj.refuted !== "boolean") continue;
		if (obj.refuted === true) {
			// strict keys on the fail-dangerous direction only
			const keys = Object.keys(obj);
			if (keys.length > 2 || !keys.every((k) => k === "refuted" || k === "reason")) continue;
		}
		return { refuted: obj.refuted, reason: typeof obj.reason === "string" ? obj.reason : undefined };
	}
	// no clean verdict → blocker stands
	return { refuted: false };
}

/**
 * Apply refutation results: downgrade refuted findings in place (blocker →
 * warn, mark `refuted`, prefix the rebuttal) and recompute each touched
 * verdict's `passed` = "no blockers remain AND no parseError". Returns the
 * refutation list with PRE-mutation details (for telemetry/display).
 *
 * INTENDED SEMANTICS: recomputation overrides the critic's own `passed` —
 * warns never contribute to failure anywhere downstream (the verdict contract
 * keys `passed` on blockers only), so a verdict whose every blocker was
 * refuted correctly flips to passed. Everything downstream (confirm prompt,
 * fix-review sidecar arming, tournament trigger) keys off this recomputed state.
 */
export function applyRefutations(
	verdicts: Array<{ agent: string; verdict: RefutableVerdict }>,
	results: Array<{ agent: string; finding: RefutableFinding; refuted: boolean; reason: string }>,
): Array<{ agent: string; detail: string; reason: string }> {
	const refuted: Array<{ agent: string; detail: string; reason: string }> = [];
	const touched = new Set<RefutableVerdict>();
	for (const r of results) {
		if (!r.refuted) continue;
		refuted.push({ agent: r.agent, detail: (r.finding.detail ?? "").slice(0, 300), reason: r.reason });
		r.finding.severity = "warn";
		r.finding.refuted = true;
		r.finding.detail = `[refuted: ${r.reason}] ${r.finding.detail ?? ""}`;
		const owner = verdicts.find((v) => v.verdict.findings.includes(r.finding));
		if (owner) touched.add(owner.verdict);
	}
	for (const v of touched) {
		const blockers = v.findings.filter((f) => f.severity === "blocker").length;
		v.passed = blockers === 0 && !v.parseError;
	}
	return refuted;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node extensions/critic/refute.test.mjs`
Expected: `ALL REFUTER TESTS PASS`.

- [ ] **Step 5: Loader gate**

Run: `./bin/pi-extension-check extensions/critic/refute.ts`
Expected: `OK`.

- [ ] **Step 6: Commit**

```bash
git add extensions/critic/refute.ts extensions/critic/refute.test.mjs
git commit -m "critic: refuter contract + pure downgrade logic (fail-open-to-blocker, parse-errors stay failed)"
```

---

### Task 4: Refuter agent + refute-pass pipeline (1C, part 2)

A `refuter` agent runs on a model DIFFERENT from the main critique, per blocker; refuted blockers downgrade via `applyRefutations`; telemetry + display updated; model restores composed; bot guard added.

**Files:**
- Create: `extensions/subagent/agents/refuter.md`
- Modify: `extensions/critic/index.ts` (bot guard; config; `refuteBlockers()`; call in `runCritique` BEFORE the main restore fires; telemetry fields; display section; sidecar filter; `allPassedFinal` at ALL four downstream sites)

**Interfaces:**
- Consumes: `parseRefuterVerdict`, `REFUTER_INSTRUCTION`, `applyRefutations`, `RefutableFinding` (Task 3); `selectSiblings` result `siblings` (Task 2, in scope in `runCritique`); `runSingleAgent`, `getFinalOutput`, `mapWithConcurrencyLimit`, `discoverAgents` (already imported); `ensureCriticModel`, `Notify` type (already in index.ts).
- Produces: `refuteBlockers(cwd, agents, verdicts, taskContext, refuteMax, notify): Promise<Array<{ agent; finding; refuted; reason }>>` — spawns refuters (blockers in FAILED verdicts only, capped at `refuteMax`), returns raw results; NO model management inside (the caller owns the model lifecycle so restores compose).
- Telemetry additions on `CritiqueTelemetryRow`: `refuted?: Array<{ agent: string; detail: string; reason: string }>`; per-verdict `blockersRefuted?: number`.

- [ ] **Step 1: Add the bot-exclusion guard (currently missing — the critic extension spawns subagents and manages model servers)**

At the top of the default export in `extensions/critic/index.ts`:

```typescript
export default function (pi: ExtensionAPI) {
	// Bot-exclusion invariant: critics spawn subagent processes and (with the
	// refute pass / model card) manage local model servers. Bots have their own
	// policy system; nested subagents must not spawn critics.
	if (process.env["PI_BOT_PERMISSION_POLICY"]) return;
	if (Number(process.env["PIBOT_SUBAGENT_DEPTH"] ?? "0") >= 1) return;
```

(Behavior change: bot sessions lose `/critique`. This is what the CLAUDE.md invariant prescribes; note it in the commit message.)

- [ ] **Step 2: Create the refuter agent**

Create `extensions/subagent/agents/refuter.md`:

```markdown
---
name: refuter
description: Adversarially refutes a single critic blocker with fresh context — tries to prove it wrong
tools: read, grep, find, ls, bash
model: crow-local-27b/qwen3.6-27b
---

You are given ONE blocker finding from a code review. Your job is to try to prove it
WRONG — you are the defense, not the prosecution. Do not agree out of politeness.

Look specifically for:
- The behavior implemented in ANOTHER file the original critic did not read (e.g. a
  server-side load/redirect in a sibling file, a middleware, a base class).
- A framework mechanism that already handles the case.
- An existing test that already covers it.
- A false assumption about the runtime (sync vs async, when a hook fires, what a
  library call actually returns).

Read the cited files AND the sibling files you are given. If a cheap reproduction or
test command exists, run it — evidence beats argument.

Refute ONLY with a concrete reason. If you cannot find one, the blocker stands: say so.
Do not refute on vibes or general optimism.
```

- [ ] **Step 3: Add config fields + telemetry fields**

In `interface CriticConfig`, add:

```typescript
	/** Adversarial refute-pass on blockers (default true). */
	refutePass?: boolean;
	/** Model the refuter runs on (default: a model different from the main critique). */
	refuteModel?: string;
	/** Max blockers refuted per run (beyond this they stand). */
	refuteMax?: number;
```

In `CritiqueTelemetryRow`, add after `changedFiles?`:

```typescript
	/** Blockers the refute-pass knocked down (downgraded to warn). */
	refuted?: Array<{ agent: string; detail: string; reason: string }>;
```

And in the per-verdict object type add:

```typescript
		blockersRefuted?: number;
```

- [ ] **Step 4: Write `refuteBlockers` (spawn-only; caller owns models)**

Add imports at the top of `extensions/critic/index.ts`:

```typescript
import { applyRefutations, parseRefuterVerdict, REFUTER_INSTRUCTION, type RefutableFinding } from "./refute.js";
```

Add the function near `critiqueArtifact`:

```typescript
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
```

- [ ] **Step 5: Wire the pass into `runCritique` — INSIDE the model-lifecycle window, restores composed**

Locate the current critique invocation block:

```typescript
			let outcome: CritiqueOutcome | { missing: string[] } | undefined;
			try {
				outcome = await critiqueArtifact({
					...
				});
			} finally {
				// Restore the previously loaded local model as soon as the critics
				// are done — never wait on the interactive confirm below.
				restoreModel?.();
			}
			if (!outcome) return;
```

Replace the `finally` sequencing so the refute-pass runs BEFORE the (single, composed) restore — a background restore must never race the refute model's start:

```typescript
			let outcome: CritiqueOutcome | { missing: string[] } | undefined;
			try {
				outcome = await critiqueArtifact({
					...same args as before...
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
							// re-binds), not a guess. Fall back to override/default.
							const mainModel =
								outcome.verdicts.find((v) => v.model)?.model ?? modelOverride ?? "crow-local/qwen3.6-35b-a3b";
							const diverse = cfg.diverseModel ?? "crow-local-27b/qwen3.6-27b";
							let refuteModel = cfg.refuteModel ?? (mainModel === diverse ? "crow-local/qwen3.6-35b-a3b" : diverse);
							if (refuteModel === mainModel) refuteModel = mainModel === diverse ? "crow-local/qwen3.6-35b-a3b" : diverse;

							ctx.ui.notify(`Refute-pass: challenging blockers on ${refuteModel}…`, "info");
							let refuteReady = true;
							try {
								const r2 = await ensureCriticModel(refuteModel, (m, s) => ctx.ui.notify(m, s));
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
							const discovered = refuteReady ? discoverAgents(ctx.cwd, "user").agents : [];
							if (refuteReady && !discovered.some((a) => a.name === "refuter")) {
								ctx.ui.notify("refuter agent missing (run scripts/install-bridges.sh) — skipping refute-pass", "warning");
								refuteReady = false;
							}
							if (refuteReady) {
								const refAgents = discovered.map((a) => (a.name === "refuter" ? { ...a, forceModel: refuteModel } : a));
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
```

- [ ] **Step 6: Post-refute pass/fail + sidecar filtering (`allPassedFinal` at ALL downstream sites)**

Change the destructuring `const { allPassed, verdicts, row } = outcome;` to drop the now-unused pre-refute value, and derive the post-refute state:

```typescript
			const { verdicts, row } = outcome;
			// Post-refute state: refutations may have flipped verdicts. Parse-error
			// verdicts can never pass (applyRefutations enforces it).
			const allPassedFinal = verdicts.every((v) => v.verdict.passed);
```

Then update ALL FOUR downstream uses of `allPassed` to `allPassedFinal` — each matters:
1. `saveLastFindings(... passed: allPassed ...)` → `passed: allPassedFinal` — otherwise a run whose blockers were all refuted still arms fix-review mode.
2. The verdict header line `**Critique ${allPassed ? "PASSED ✓" : "FAILED ✗"}**` → `allPassedFinal`.
3. `busPayload.passed` → `allPassedFinal` (the tournament auto-trigger must see post-refute state).
4. The confirm guard `if (!allPassed && ctx.hasUI && !busPayload.handled)` → `!allPassedFinal`.

ALSO filter refuted findings out of the sidecar (decision from plan review — disproven claims must not become fix-review "original findings"). In the `saveLastFindings` call, change the findings mapping to:

```typescript
				findings: verdicts.flatMap((v) =>
					v.verdict.findings
						.filter((f) => !(f as RefutableFinding).refuted)
						.map((f) => ({ agent: v.agent, ...f })),
				),
```

- [ ] **Step 7: Add the refuted section to the displayed verdict**

Where the verdict `lines` are assembled (after the per-critic findings loop, before `pi.sendMessage`), append:

```typescript
			if (row.refuted && row.refuted.length > 0) {
				lines.push("", `**Refuted → downgraded to warn** (${row.refuted.length}):`);
				for (const r of row.refuted) lines.push(`  - (${r.agent}) ${r.detail.slice(0, 160)} — ${r.reason}`);
			}
```

- [ ] **Step 8: NUL check + syntax check + loader gate**

Run:
```bash
python3 -c "print('nul bytes:', open('extensions/critic/index.ts','rb').read().count(b'\x00'))"
npx esbuild extensions/critic/index.ts --outfile=/tmp/crit-t4.js --format=esm --log-level=warning && echo SYNTAX-OK
npm run test:extensions 2>&1 | tail -3
```
Expected: `nul bytes: 0`, `SYNTAX-OK`, gate output ends with the usual SKIP lines and exit 0.

- [ ] **Step 9: Install bridges so the new refuter agent symlinks in**

Run: `bash scripts/install-bridges.sh && ls -la ~/.pi/agent/agents/refuter.md`
Expected: symlink to `extensions/subagent/agents/refuter.md`.

- [ ] **Step 10: Runtime validation on `~/life` — full loop**

The `~/life` working tree still holds the fix agent's changes; the sidecar may be stale (>4h) by execution time — that only disables fix-review mode, which is NOT what this step validates. Run:

```bash
tmux kill-session -t crit-t4 2>/dev/null; tmux new-session -d -s crit-t4 -c /home/kh0pp/life -x 200 -y 55 'pi'
sleep 12
tmux send-keys -t crit-t4 '/critique 6f49c5b' Enter
# poll up to ~35 min (single local slot: 2 critics, then a model swap + refuter runs)
for i in $(seq 1 140); do tmux capture-pane -pt crit-t4 -S -800 | grep -qE "Critique (PASSED|FAILED)" && break; sleep 15; done
tmux capture-pane -pt crit-t4 -S -1000 | sed -n '/Refute-pass/,$p' | head -60
tail -1 ~/.pi/agent/critic-telemetry.jsonl | jq '{refuted, verdicts: [.verdicts[] | {agent, blockers, blockersRefuted, model}]}'
```

Expected observations (in order of importance):
1. `Refute-pass: challenging blockers on crow-local-27b/qwen3.6-27b…` appears AFTER the critics finish, and any model restore happens AFTER the refute pass (no `restoring…` line between critics and refute).
2. IF anything was refuted: the telemetry row has `refuted` entries and `blockersRefuted` counts, and refuted items show in the `Refuted → downgraded to warn` section. IF nothing was refuted, those fields are absent by design — observation 1 alone validates the pipeline.
3. GOAL (model-dependent, not a rollback trigger if missed): the shell.spec-style cross-file claim is refuted; the sync.ts drain-race blocker survives. If the refuter fails to refute anything, the pipeline is still validated by (1) — note the miss in the commit message and move on; prompt tuning is iterative.
4. Answer the send-findings dialog with "No" (Down, Enter) — this validation must not dispatch fixes.

Cleanup: `tmux kill-session -t crit-t4` ONLY after the verdict rendered (so the composed restore has fired); then verify the expected model is back: `curl -sf -m3 http://100.118.41.122:8003/health >/dev/null && echo 35b-up`.

- [ ] **Step 11: Commit**

```bash
git add extensions/subagent/agents/refuter.md extensions/critic/index.ts
git commit -m "critic: adversarial refute-pass — disprove blockers on a different model, downgrade refuted to warn

Also adds the missing bot-exclusion guard to the critic extension (spawns
subagents, manages model servers): bots and nested subagents no longer load
/critique, per the CLAUDE.md invariant."
```

---

### Task 5: Test wiring + docs

**Files:**
- Modify: `package.json` (run the pure-module tests as part of the gate)
- Modify: `CLAUDE.md` (critic bullet)
- Modify: `docs/ROADMAP.md` (note under the 2026-07-05 landed section)

**Interfaces:** none.

- [ ] **Step 1: Wire the pure-module tests into the gate**

In `package.json` `scripts`, add:

```json
		"test:critic": "node extensions/critic/context.test.mjs && node extensions/critic/refute.test.mjs",
```

The existing `test:extensions` script ENDS with `; exit $fail` — appending `&& npm run test:critic` after an `exit` would be DEAD CODE (the shell exits before evaluating it). Instead, change the script's tail from:

```
… done; exit $fail
```

to:

```
… done; [ "$fail" -ne 0 ] && exit 1; npm run test:critic
```

(If the loop failed, exit 1 immediately; otherwise the script's exit status becomes `test:critic`'s.)

- [ ] **Step 2: Verify the combined gate**

Run: `npm run test:extensions 2>&1 | tail -4`
Expected: ends with `ALL SIBLING TESTS PASS` / `ALL REFUTER TESTS PASS` and exit 0.

- [ ] **Step 3: Update the CLAUDE.md critic bullet**

Append to the `**Critics**` bullet in `CLAUDE.md`:

```markdown
 **Evidence rule**: a blocker asserting runtime behavior must carry a run/quote or is downgraded to warn. **Sibling context** (`critic.siblingContext`): same-directory files are surfaced so cross-file framework behavior (e.g. `+page.server.ts` beside `+page.svelte`) is visible. **Refute-pass** (`critic.refutePass`, default on): each blocker is handed to a `refuter` agent on a model DIFFERENT from the one that raised it (`critic.refuteModel`, default the diverse local; actual main model read from the run's verdicts); a refuted blocker downgrades to warn with the rebuttal shown (fail-open-to-blocker; parse-error verdicts can never flip to passed; refuted findings are filtered from the fix-review sidecar). Blockers only, capped `critic.refuteMax` (8); the refute model swap composes with the main restore (first-non-null closure wins) and always completes before the send-findings confirm. The critic extension is now bot-excluded (spawns subagents, manages model servers).
```

- [ ] **Step 4: Add a ROADMAP note**

Under `## LANDED 2026-07-05`, add:

```markdown
- **Critic precision (Workstream 1)** — evidence-or-downgrade rule, sibling-file context,
  adversarial refute-pass (blockers disproven on a different local model → warn). Spec:
  `docs/specs/2026-07-05-critic-precision-and-fix-dispatch-design.md`. Telemetry gains
  `refuted[]` + `blockersRefuted` — a refuted-rate to watch alongside the flip gate.
  Known follow-up (pre-existing, out of scope here): the recall probe's ensureCriticModel
  can race a composed restore's BACKGROUND startModel (findRunningManaged may observe an
  in-flight restore) — serialize model-lifecycle operations behind a single mutex/queue
  in lib/local-models.mjs when it next bites.
```

- [ ] **Step 5: Commit**

```bash
git add package.json CLAUDE.md docs/ROADMAP.md
git commit -m "docs+gate: critic precision — evidence rule, sibling context, refute-pass; pure-module tests wired into test:extensions"
```

---

## Self-Review

**Spec coverage:**
- 1A evidence rule → Task 1. ✓
- 1B sibling context (incl. lock/generated/binary filtering per spec) → Task 2. ✓
- 1C refute-pass → Task 3 (contract + pure downgrade logic) + Task 4 (agent, pipeline, composed model lifecycle, telemetry, display, sidecar filter). ✓
- Configurable refute model, default diverse, resolved from actual main model → Task 4 Step 5. ✓
- Fail-open-to-blocker + strict-keys on `refuted:true` → Task 3 (tested). ✓
- Parse-error verdicts never pass → Task 3 `applyRefutations` (tested), enforced at the only place `passed` is recomputed. ✓
- Downgrade-not-drop + rebuttal shown → Tasks 3/4. ✓
- Telemetry `refuted`/`blockersRefuted`, `firstBlocker`/`agree` recomputed → Task 4 Step 5. ✓
- Docs + test wiring → Task 5. ✓
- Deferred D (framework note): intentionally absent. ✓

**Plan-review criticals addressed:**
1. Parse-error flip → `applyRefutations` recomputes `passed = no blockers && !parseError`; unit-tested twice (Task 3 Step 1). ✓
2. Bogus `oversized` move → instruction deleted; Task 2 Step 7 states it is ALREADY declared before the insertion point and says "do not move it". ✓
3. Literal NUL in plan → snippet uses the escape; Global Constraints + Task 2 Step 8 / Task 4 Step 8 add a mandatory NUL byte-count check after editing. ✓
4. Restore race → refute-pass moved INSIDE the critique try/finally; single composed restore (first-non-null closure); explicitly validated in Task 4 Step 10 observation 1. ✓
5. `allPassedFinal` ambiguity → all FOUR sites enumerated with rationale (incl. `saveLastFindings`); sidecar additionally filters refuted findings. ✓

**Plan-review suggestions adopted:** refuter task context (changedList + ref + subsystems + siblings); `selectSiblings` filtering + hoisted single `git ls-files`; strict-keys; test wiring into the gate; `firstBlocker`/`agree`/pre-mutation-detail telemetry recompute; actual-model resolution; scratch-repo runtime check for Task 2 (preserves the `~/life` sidecar); refute-start notify; `Notify` type reuse; pure `applyRefutations` extraction; interface block matches the positional signature now. Questions answered in "Decisions from plan review".

**Placeholder scan:** no TBD/TODO; every code step shows full code; `...same args as before...` in Task 4 Step 5 refers to the unchanged `critiqueArtifact` argument list shown in current code at the marked location (an anchor, not an omission). ✓

**Type consistency:** `selectSiblings(changedFiles, lsFiles, opts)` — Tasks 2/4 consistent. `parseRefuterVerdict` → `{refuted, reason?}`; `applyRefutations(verdicts, results)` returns pre-mutation refuted list — defined Task 3, consumed Task 4 Step 5. `refuteBlockers(cwd, agents, verdicts, taskContext, refuteMax, notify)` positional — interface block and snippet match. `RefutableFinding.refuted` set in Task 3, filtered in Task 4 Step 6. ✓

## Review

- **2026-07-05 — adversarial review #1 (Plan subagent): REVISE.** 5 critical issues (parse-error verdicts could flip to passed; a factually wrong "move `oversized`" instruction that would crash every critique; a literal NUL byte in a plan snippet; the refute-pass racing the main critique's background model restore; ambiguous `allPassed` rename with sidecar consequences) + 9 suggestions + 3 questions. All criticals fixed in this revision (see Self-Review); high-value suggestions adopted; questions answered under "Decisions from plan review" (sidecar filters refuted findings; refute may swap on manual runs because it precedes the confirm; refute model resolved from actual verdict models; bot guard added).
- **2026-07-05 — adversarial review #2 (Plan subagent): all 5 round-1 criticals verified genuinely fixed** (composed-restore rule confirmed correct in all three model cases; object-identity in applyRefutations confirmed sound). Two NEW mechanical criticals, both fixed in this revision: (1) `test:extensions` ends with `exit $fail`, so appending `&&` made the new tests dead code — the tail is now rewritten to `[ "$fail" -ne 0 ] && exit 1; npm run test:critic`; (2) the "refute-pass skipped" catch fell through and spawned refuters at a dead model — now gated by a `refuteReady` flag, and the whole refute stage got its own try/catch (degrades to "blockers stand", never discards the completed critique). Suggestions adopted: failed-verdicts-only blocker targeting, dropped unused `allPassed` destructure, interface bullet aligned, intended verdict-flip semantics documented in the module comment, observation 2 made conditional, ROADMAP note for the pre-existing probe-vs-background-restore race. Questions answered: verdict-flip semantics confirmed intended (warns never gate downstream); probe race noted as out-of-scope follow-up.
