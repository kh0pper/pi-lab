import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Compile the pure module to ESM and import it.
const out = join(mkdtempSync(join(tmpdir(), "ctx-")), "context.mjs");
execFileSync("npx", ["esbuild", "extensions/critic/context.ts", `--outfile=${out}`, "--format=esm", "--log-level=warning"]);
const { selectSiblings, mergeCarriedFindings } = await import(out);

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

// --- mergeCarriedFindings (fix-review continuity across failed runs) ---
const NOW = 1_000_000_000;
const f = (agent, detail, severity = "warn") => ({ agent, detail, severity });
const drain = f("test-critic", "src/lib/client/sync.ts: originalKeys collected after the push await loses during-push mutations", "blocker");
const tauto = f("test-critic", "tests/sync.test.ts: atomicity test never exercises a failure");
const prior = { ts: NOW - 60 * 60_000, passed: false, findings: [drain, tauto] };

// an unmatched prior finding is carried, tagged, and appended after current
let merged = mergeCarriedFindings(prior, [tauto], [tauto], NOW);
a("unresolved prior finding is carried", merged.length === 2);
a("carried finding is tagged", merged[1].detail.startsWith("[carried]"));
a("carried finding keeps severity", merged[1].severity === "blocker");
a("current findings come first, untagged", merged[0] === tauto);

// a prior finding re-raised in the current run is NOT duplicated
merged = mergeCarriedFindings(prior, [drain, tauto], [drain, tauto], NOW);
a("re-raised finding not duplicated", merged.length === 2);

// match set is currentAll (incl. refuted), base is currentSaved: a finding
// refuted THIS run must neither be saved nor carried back in
merged = mergeCarriedFindings(prior, [drain, tauto], [tauto], NOW);
a("refuted-this-run finding is not resurrected", merged.length === 1 && merged[0] === tauto);

// carry is idempotent across rounds — no [carried] [carried] stacking
const round2 = { ts: NOW - 30 * 60_000, passed: false, findings: mergeCarriedFindings(prior, [tauto], [tauto], NOW) };
merged = mergeCarriedFindings(round2, [], [], NOW);
a("carried tag does not stack", merged.every((x) => !x.detail.startsWith("[carried] [carried]")));

// staleness and passed runs do not carry
a("stale prior (>4h) not carried", mergeCarriedFindings({ ...prior, ts: NOW - 5 * 3600_000 }, [], [], NOW).length === 0);
a("passed prior not carried", mergeCarriedFindings({ ...prior, passed: true }, [], [], NOW).length === 0);
a("null prior ok", mergeCarriedFindings(null, [tauto], [tauto], NOW).length === 1);

// cap
const lots = { ts: NOW - 1000, passed: false, findings: Array.from({ length: 50 }, (_, i) => f("c", `finding number ${i} is unique`)) };
a("total capped at 30", mergeCarriedFindings(lots, [], [], NOW).length === 30);

console.log("ALL SIBLING TESTS PASS");
