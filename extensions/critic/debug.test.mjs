import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = join(mkdtempSync(join(tmpdir(), "cdbg-")), "debug.mjs");
execFileSync("npx", ["esbuild", "extensions/critic/debug.ts", `--outfile=${out}`, "--format=esm", "--log-level=warning"]);
const { formatCriticDebug, writeCriticDebug, buildVerdictRecoveryTask } = await import(out);

const a = (n, c) => { if (!c) { console.error("FAIL", n); process.exit(1); } console.log("ok", n); };

// --- formatCriticDebug (pure) ---
const meta = {
  agent: "code-critic", label: "part 2/3", model: "crow-local/qwen3.6-35b-a3b",
  cwd: "/home/u/proj", parseError: "no parseable verdict JSON in critic output",
  exitCode: 0, stopReason: "stop",
};
const doc = formatCriticDebug(meta, "final analysis text without a verdict block", [
  { role: "assistant", content: [{ type: "text", text: "intermediate turn" }] },
  { role: "toolResult", content: [{ type: "text", text: "x".repeat(50_000) }] },
]);
a("doc names the agent", doc.includes("code-critic"));
a("doc carries the parse error", doc.includes("no parseable verdict JSON"));
a("doc carries the label", doc.includes("part 2/3"));
a("doc carries the final output", doc.includes("final analysis text without a verdict block"));
a("doc carries message tail", doc.includes("intermediate turn"));
a("long message entries are truncated", !doc.includes("x".repeat(25_000)));
a("empty final output is called out", formatCriticDebug(meta, "", []).includes("(empty)"));

// --- writeCriticDebug ---
const dir = join(mkdtempSync(join(tmpdir(), "cdbg-dir-")), "critic-debug");
const p1 = writeCriticDebug(dir, meta, "raw one", []);
a("returns the written path", typeof p1 === "string" && p1.startsWith(dir));
a("creates the dir and file", existsSync(p1));
a("file content includes the raw output", readFileSync(p1, "utf8").includes("raw one"));
const p2 = writeCriticDebug(dir, { ...meta, agent: "test-critic" }, "raw two", []);
a("distinct files per dump", p1 !== p2 && existsSync(p2));

// prune: with cap 5, after many writes only the newest 5 remain
for (let i = 0; i < 9; i++) writeCriticDebug(dir, meta, `raw ${i}`, [], 5);
const left = readdirSync(dir);
a("prunes to the cap", left.length === 5);

// never throws on an uncreatable dir — returns null (dir path under a regular
// file → ENOTDIR; avoid /proc paths, where mkdir can hang on some kernels)
const blocker = join(mkdtempSync(join(tmpdir(), "cdbg-file-")), "plainfile");
writeFileSync(blocker, "not a dir");
const bad = writeCriticDebug(join(blocker, "sub"), meta, "raw", []);
a("uncreatable dir returns null instead of throwing", bad === null);

// --- buildVerdictRecoveryTask ---
const task = buildVerdictRecoveryTask("the analysis body with findings");
a("recovery task embeds the analysis", task.includes("the analysis body with findings"));
a("recovery task demands only the verdict block", /verdict/i.test(task) && /do not.*tools/i.test(task.replace(/\n/g, " ")));
a("recovery task forbids redoing the review", /do not redo/i.test(task));

// head-truncation keeps the TAIL (findings usually conclude an analysis)
const long = "HEAD-MARKER " + "y".repeat(60_000) + " TAIL-MARKER";
const tTask = buildVerdictRecoveryTask(long, 10_000);
a("truncated task keeps the tail", tTask.includes("TAIL-MARKER"));
a("truncated task drops the head", !tTask.includes("HEAD-MARKER"));
a("truncation is called out", /truncated/i.test(tTask));
a("short analyses are not truncated", !/…\[analysis truncated/.test(buildVerdictRecoveryTask("short", 10_000)));

console.log("ALL CRITIC-DEBUG TESTS PASS");
