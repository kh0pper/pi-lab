#!/usr/bin/env node
/**
 * Deterministic gate harness for permission-gating.ts (Phase 3.1, R8).
 *
 * Loads the LIVE shipped extension via pi's bundled jiti (same resolution as
 * bin/pi-extension-check), captures its `tool_call` handler with a mock
 * ExtensionAPI, and drives synthetic (event, ctx) pairs under controlled
 * PI_BOT_PERMISSION_POLICY / PIBOT_SUBAGENT_DEPTH env to assert block/allow.
 *
 * Covers the NEW multi-agent (subagent) clause (R6/R9 — opt-in + capability +
 * recursion-depth + fail-closed) AND a regression sweep of the Phase-2.2
 * cases (strict no-op without env, bash deny/allowlist, write_paths,
 * external_send draft-only, confirm[], the existing destructive-bash gate)
 * so the 3.1 change is proven to extend, not regress, the gate.
 *
 * `parseBotPolicy()` runs once per default()-invocation, so each case
 * sets env then RE-invokes default(mockPi) to rebuild the closure.
 *
 * Run on crow LIVE (real pi + node_modules): node bin/gate-harness.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve as rpath } from "node:path";

// --- resolve the active pi install + its bundled jiti (pi-extension-check parity)
let piBin = "";
try { piBin = execFileSync("bash", ["-lc", "command -v pi"], { encoding: "utf8" }).trim(); } catch {}
if (!piBin) {
  for (const c of execFileSync("bash", ["-lc", "ls -1 ~/.nvm/versions/node/v*/bin/pi 2>/dev/null || true"], { encoding: "utf8" }).trim().split("\n")) if (c) piBin = c;
}
if (!piBin) { console.error("FAIL: pi not found on PATH or nvm"); process.exit(3); }
const piTarget = execFileSync("readlink", ["-f", piBin], { encoding: "utf8" }).trim();
const piRoot = rpath(dirname(piTarget), "..");
let jiti = "";
for (const c of [piRoot + "/node_modules/jiti/lib/jiti.mjs", piRoot + "/node_modules/@mariozechner/jiti/lib/jiti.mjs"]) if (existsSync(c)) { jiti = c; break; }
if (!jiti) { console.error("FAIL: jiti not found under " + piRoot); process.exit(4); }
process.env.NODE_PATH = piRoot + "/node_modules" + (process.env.NODE_PATH ? ":" + process.env.NODE_PATH : "");
createRequire(import.meta.url)("node:module").Module._initPaths();

const GATE = rpath(dirname(new URL(import.meta.url).pathname), "..", "extensions", "permission-gating.ts");
const { createJiti } = await import(jiti);
const j = createJiti(piRoot, { interopDefault: true });
const mod = await j.import(GATE);
const extn = mod.default ?? mod;
if (typeof extn !== "function") { console.error("FAIL: default export not a function"); process.exit(2); }

// Build a fresh handler under the given env.
function handlerWith(policyEnv, depthEnv) {
  if (policyEnv === undefined) delete process.env.PI_BOT_PERMISSION_POLICY;
  else process.env.PI_BOT_PERMISSION_POLICY = policyEnv;
  if (depthEnv === undefined) delete process.env.PIBOT_SUBAGENT_DEPTH;
  else process.env.PIBOT_SUBAGENT_DEPTH = depthEnv;
  let h = null;
  extn({ on: (n, fn) => { if (n === "tool_call") h = fn; }, registerTool() {}, registerCommand() {} });
  return h;
}
const CTX = { hasUI: false, ui: { confirm: async () => false } };
let pass = 0, fail = 0;
async function expect(name, { policy, depth, event, blocked }) {
  const h = handlerWith(policy, depth);
  let r;
  try { r = await h(event, CTX); } catch (e) { r = { block: true, reason: "THREW:" + (e && e.message) }; }
  const isBlocked = !!(r && r.block);
  const ok = isBlocked === blocked;
  console.log((ok ? "PASS " : "FAIL ") + name + "  → " + (isBlocked ? "BLOCK(" + (r && r.reason || "").slice(0, 70) + ")" : "allow") + (ok ? "" : "  EXPECTED " + (blocked ? "block" : "allow")));
  ok ? pass++ : fail++;
}
const P = (o) => JSON.stringify(o);
const CAP = P({ multi_agent: true, model_capable: true });

// --- NEW subagent clause (R6/R9) ---
await expect("1 no env → subagent NOT gated (strict no-op, non-bot pi)", { policy: undefined, event: { toolName: "subagent", input: {} }, blocked: false });
await expect("2 multi_agent:false → subagent blocked", { policy: P({ multi_agent: false }), event: { toolName: "subagent", input: {} }, blocked: true });
await expect("3 multi_agent:true model_capable absent → blocked (R9 fail-closed)", { policy: P({ multi_agent: true }), event: { toolName: "subagent", input: {} }, blocked: true });
await expect("4 multi_agent:true model_capable:true depth unset → ALLOWED", { policy: CAP, event: { toolName: "subagent", input: {} }, blocked: false });
await expect("5 capable + PIBOT_SUBAGENT_DEPTH=1 → blocked (recursion cap)", { policy: CAP, depth: "1", event: { toolName: "subagent", input: {} }, blocked: true });
await expect("6 capable + PIBOT_SUBAGENT_DEPTH=0 → allowed", { policy: CAP, depth: "0", event: { toolName: "subagent", input: {} }, blocked: false });
await expect("7 capable + PIBOT_SUBAGENT_DEPTH=abc (unparseable) → blocked (NaN fail-closed)", { policy: CAP, depth: "abc", event: { toolName: "subagent", input: {} }, blocked: true });
await expect("8 malformed policy JSON → fail-closed → subagent blocked", { policy: "{not json", event: { toolName: "subagent", input: {} }, blocked: true });
await expect("9 capable → a NON-subagent tool (read) still allowed", { policy: CAP, event: { toolName: "read", input: { path: "/tmp/x" } }, blocked: false });

// --- Phase-2.2 regression sweep (must still hold) ---
await expect("10 bash:deny → bash blocked", { policy: P({ bash: "deny", write_paths: [] }), event: { toolName: "bash", input: { command: "ls" } }, blocked: true });
await expect("11 bash:allowlist 'git ' → 'git status' allowed", { policy: P({ bash: "allowlist", bash_allow: ["git "], write_paths: [] }), event: { toolName: "bash", input: { command: "git status" } }, blocked: false });
await expect("12 bash:allowlist → non-listed 'curl x' blocked", { policy: P({ bash: "allowlist", bash_allow: ["git "], write_paths: [] }), event: { toolName: "bash", input: { command: "curl http://x" } }, blocked: true });
await expect("13 write_paths → write inside allowed", { policy: P({ write_paths: ["/tmp/p30"] }), event: { toolName: "write", input: { path: "/tmp/p30/f.txt" } }, blocked: false });
await expect("14 write_paths → write to /etc blocked", { policy: P({ write_paths: ["/tmp/p30"] }), event: { toolName: "write", input: { path: "/etc/passwd" } }, blocked: true });
await expect("15 external_send:draft_only → gmail_send_email blocked", { policy: P({ external_send: "draft_only", write_paths: [] }), event: { toolName: "gmail_send_email", input: {} }, blocked: true });
await expect("16 external_send:draft_only → gmail_create_draft allowed", { policy: P({ external_send: "draft_only", write_paths: [] }), event: { toolName: "gmail_create_draft", input: {} }, blocked: false });
await expect("17 confirm:['x'] → x blocked unattended", { policy: P({ confirm: ["x"], write_paths: [] }), event: { toolName: "x", input: {} }, blocked: true });
await expect("18 no env + destructive 'sudo rm -rf /' → still blocked (existing gate, no UI)", { policy: undefined, event: { toolName: "bash", input: { command: "sudo rm -rf /" } }, blocked: true });

console.log("\nGATE-HARNESS: " + (fail ? "FAIL (" + fail + "/" + (pass + fail) + " failed)" : "PASS (" + pass + "/" + pass + ")"));
process.exit(fail ? 1 : 0);
