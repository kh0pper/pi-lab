import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = join(mkdtempSync(join(tmpdir(), "clu-")), "cluster.mjs");
execFileSync("npx", ["esbuild", "extensions/critic/cluster.ts", `--outfile=${out}`, "--format=esm", "--log-level=warning"]);
const { extractPrimaryFile, canonicalizeFile, clusterFindings, buildFixChain, countFileEdits } = await import(out);

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

// --- canonicalizeFile (M2) ---
const cf = ["src/lib/client/sync.ts", "src/lib/server/sync.ts", "tests/stats.test.js", "src/lib/stats.js"];
a("bare basename canonicalizes to unique full path", canonicalizeFile("stats.test.js", cf) === "tests/stats.test.js");
a("ambiguous basename stays as cited", canonicalizeFile("sync.ts", cf) === "sync.ts");
a("dot-slash prefix stripped and matched", canonicalizeFile("./src/lib/stats.js", cf) === "src/lib/stats.js");
a("longer cited path suffix-matches a changed file", canonicalizeFile("/home/u/repo/src/lib/stats.js", cf) === "src/lib/stats.js");
a("unknown file stays as cited", canonicalizeFile("other/place.ts", cf) === "other/place.ts");
a("null passes through", canonicalizeFile(null, cf) === null);
a("partial basename segment does not match", canonicalizeFile("ats.test.js", cf) === "ats.test.js");

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

// "device.ts" is cited bare but canonicalizes to the changed file's full path (M2)
const dev = clusters.find((c) => c.subsystem === null && c.files.includes("src/lib/device.ts"));
a("file cluster for device.ts keyed on canonical path", !!dev && dev.findings.length === 1);

const gen = clusters.find((c) => c.name === "general");
a("general cluster for no-file finding", !!gen && gen.findings.length === 1);
a("subsystem clusters come first", clusters[0].subsystem === "sync");

// same file cited two path-forms → ONE cluster keyed on the full path (M2)
const twoForms = [
  { agent: "code-critic", severity: "blocker", detail: "stats.test.js asserts the wrong mean" },
  { agent: "test-critic", severity: "warn", detail: "tests/stats.test.js never runs the empty case" },
];
const collapsed = clusterFindings(twoForms, {}, ["tests/stats.test.js", "src/stats.js"], 6);
a("path-form variants collapse to one cluster", collapsed.length === 1);
a("collapsed cluster keyed on the full path", collapsed[0].name === "tests/stats.test.js" && collapsed[0].files.includes("tests/stats.test.js"));

// bare basename now matches a full-path subsystem glob (M2)
const subsGlob = { stats: { globs: ["tests/**"], invariants: ["stats invariants hold"] } };
const globbed = clusterFindings(
  [{ agent: "code-critic", severity: "blocker", detail: "stats.test.js asserts the wrong mean" }],
  subsGlob, ["tests/stats.test.js"], 6);
a("bare basename matches subsystem glob after canonicalization", globbed.length === 1 && globbed[0].subsystem === "stats");

// cap/merge: 5 single-file findings, cap 3 → exactly 3 clusters, all findings preserved
const many = [1, 2, 3, 4, 5].map((i) => ({ agent: "c", severity: "warn", detail: `file${i}.ts has an issue` }));
const capped = clusterFindings(many, {}, [], 3);
a("cap respected", capped.length === 3);
a("no findings dropped on merge", capped.reduce((n, c) => n + c.findings.length, 0) === 5);
a("cap emits a single misc bucket", capped.filter((c) => c.name === "misc").length === 1);

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

// --- countFileEdits (no-edit fixer-leg detection) ---
const msgs = [
  { role: "user", content: [{ type: "text", text: "task" }] },
  { role: "assistant", content: [
    { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
    { type: "toolCall", name: "edit", arguments: { path: "a.ts" } },
    { type: "toolCall", name: "bash", arguments: { command: "npx vitest run" } },
  ]},
  { role: "assistant", content: [{ type: "toolCall", name: "write", arguments: { path: "b.ts" } }] },
];
a("counts edit and write tool calls", countFileEdits(msgs) === 2);
a("read/bash are not edits", countFileEdits([msgs[1]].map(m => ({ ...m, content: m.content.filter(c => c.name !== "edit") }))) === 0);
a("empty transcript = zero", countFileEdits([]) === 0);
a("malformed entries are ignored", countFileEdits([null, {}, { role: "assistant", content: "not-an-array" }]) === 0);

console.log("ALL CLUSTER TESTS PASS");
