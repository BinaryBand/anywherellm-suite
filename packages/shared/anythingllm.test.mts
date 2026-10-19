import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { perProcess, serial } from "./anythingllm.mts";

// serial's order (one key at a time, other keys alongside, a failure not stopping the next) is
// tested through inTurn, which is built on it (pages.test.mts).

test("serial drops a key once its calls are done, so keys don't pile up", async () => {
  const queues = perProcess("serial", () => new Map<string, unknown>());
  const failed = serial("gone", () => Promise.reject(new Error("no")));
  const next = serial("gone", () => "ran");
  assert.ok(queues.has("gone"), "kept while calls wait");
  await assert.rejects(failed, /no/);
  assert.equal(await next, "ran");
  await sleep(0);
  assert.ok(!queues.has("gone"), "the key is gone");
});
