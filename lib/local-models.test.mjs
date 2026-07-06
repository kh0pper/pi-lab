/**
 * Tests for the model-lifecycle serialization queue (ROADMAP 2c): every
 * mutating op (startModel/stopModel, incl. background restores) runs through
 * one in-process FIFO queue so the critics / refute-pass / fix-dispatch swap
 * points can't interleave compose up/down on the single local slot.
 *
 * Run from the repo root: node lib/local-models.test.mjs
 */
import { enqueueLifecycle, startModel, stopModel } from "./local-models.mjs";

const a = (n, c) => { if (!c) { console.error("FAIL", n); process.exit(1); } console.log("ok", n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- FIFO ordering: op2 must not start until op1 settles ---
{
  const log = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const p1 = enqueueLifecycle(async () => { log.push("1-start"); await gate; log.push("1-end"); return "one"; });
  const p2 = enqueueLifecycle(async () => { log.push("2-start"); return "two"; });
  await sleep(30);
  a("second op waits for the first", log.join(",") === "1-start");
  release();
  a("return values propagate", (await p1) === "one" && (await p2) === "two");
  a("strict FIFO order", log.join(",") === "1-start,1-end,2-start");
}

// --- rejection isolation: a failed op rejects its caller but never wedges the queue ---
{
  const boom = enqueueLifecycle(async () => { throw new Error("compose exploded"); });
  let caught = null;
  await boom.catch((e) => { caught = e.message; });
  a("rejection propagates to the caller", caught === "compose exploded");
  a("queue survives a rejection", (await enqueueLifecycle(async () => "alive")) === "alive");
}

// --- startModel/stopModel actually go through the queue ---
{
  let release;
  const gate = new Promise((r) => { release = r; });
  const long = enqueueLifecycle(() => gate);
  let stopSettled = false;
  let startSettled = false;
  // Unknown refs reject fast ("not a managed local model") WITHOUT touching
  // docker — but only once the queue reaches them.
  const pStop = stopModel("nope/not-a-model").catch(() => { stopSettled = true; });
  const pStart = startModel("nope/not-a-model").catch(() => { startSettled = true; });
  await sleep(30);
  a("stopModel is queued behind a pending op", stopSettled === false);
  a("startModel is queued behind a pending op", startSettled === false);
  release();
  await long; await pStop; await pStart;
  a("queued stopModel ran and rejected on unknown ref", stopSettled === true);
  a("queued startModel ran and rejected on unknown ref", startSettled === true);
}

console.log("ALL LOCAL-MODELS TESTS PASS");
