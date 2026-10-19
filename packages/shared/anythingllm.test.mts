import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { serial } from "./anythingllm.mts";

/** The queues serial keeps in this process, by key. */
const queues = () => (globalThis as unknown as Record<symbol, Map<string, unknown>>)[Symbol.for("anywherellm-suite.serial")];

test("serial runs calls with one key one at a time, and calls with another key alongside", async () => {
  const order: string[] = [];
  const step = (name: string, ms: number) => async () => (order.push(`${name} starts`), await sleep(ms), order.push(`${name} ends`), name);
  const [a, b, c] = await Promise.all([serial("one", step("a", 30)), serial("one", step("b", 1)), serial("two", step("c", 1))]);
  assert.deepEqual([a, b, c], ["a", "b", "c"]);
  assert.ok(order.indexOf("a ends") < order.indexOf("b starts"), "b waits for a");
  assert.ok(order.indexOf("c ends") < order.indexOf("a ends"), "c waits for nothing of one");
});

test("a failed call doesn't stop the next, and a key is dropped once its calls are done", async () => {
  const failed = serial("gone", () => Promise.reject(new Error("no")));
  const next = serial("gone", () => "ran");
  await assert.rejects(failed, /no/);
  assert.equal(await next, "ran");
  await sleep(0);
  assert.ok(!queues().has("gone"), "the key is gone");
});
