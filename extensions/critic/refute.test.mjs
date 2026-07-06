import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = join(mkdtempSync(join(tmpdir(), "ref-")), "refute.mjs");
execFileSync("npx", ["esbuild", "extensions/critic/refute.ts", `--outfile=${out}`, "--format=esm", "--log-level=warning"]);
const { parseRefuterVerdict, applyRefutations, resolveRefuteModel } = await import(out);

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

// --- resolveRefuteModel (WS1a follow-up: no hardcoded "other" model) ---
const managed = ["crow-local/qwen3.6-35b-a3b", "crow-local-27b/qwen3.6-27b", "crow-local-122b/qwen3.5-122b-a10b"];
const M35 = managed[0], M27 = managed[1], M122 = managed[2];

a("configured model wins when distinct", resolveRefuteModel({ mainModel: M35, configured: M122, diverse: M27, managedRefs: managed }) === M122);
a("configured equal to main falls through to diverse", resolveRefuteModel({ mainModel: M35, configured: M35, diverse: M27, managedRefs: managed }) === M27);
a("default: diverse when distinct from main", resolveRefuteModel({ mainModel: M35, diverse: M27, managedRefs: managed }) === M27);
a("main on diverse: first managed other is derived, not hardcoded", resolveRefuteModel({ mainModel: M27, diverse: M27, managedRefs: managed }) === M35);
a("no distinct managed model = skip (null)", resolveRefuteModel({ mainModel: M27, diverse: M27, managedRefs: [M27] }) === null);
a("empty managed list = skip (null)", resolveRefuteModel({ mainModel: M27, diverse: M27, managedRefs: [] }) === null);
a("unknown main model: diverse still used", resolveRefuteModel({ mainModel: null, diverse: M27, managedRefs: managed }) === M27);
a("unknown main model with configured: configured used", resolveRefuteModel({ mainModel: null, configured: M35, diverse: M27, managedRefs: managed }) === M35);

console.log("ALL REFUTER TESTS PASS");
