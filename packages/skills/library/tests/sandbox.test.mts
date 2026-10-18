// The sandbox functions run in: QuickJS, its kit, its limits.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Told } from "#shared/errors";
import { vendoredVersions } from "../../../build.mjs";
import { LIMITS, check, run, type Kit } from "../src/sandbox.ts";

// The vendored packages' versions as build.mjs inlines them, for the modules a test imports from src.
(globalThis as unknown as { VENDORED_VERSIONS: Record<string, string> }).VENDORED_VERSIONS = vendoredVersions("library");

const soon = (ms = 2000) => Date.now() + ms;
const later = <T,>(value: T, ms = 10) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

test("a function awaits the host's kit and answers what it returns", async () => {
  const seen: unknown[] = [];
  const kit: Kit = {
    http: (req) => (seen.push(req), later({ status: 200, body: { echoed: req } })),
    log: (...args) => void seen.push(["log", ...args]),
  };
  const source = `
    async function main(input, kit) {
      const a = await kit.http({ path: "/a", n: input.n });
      kit.log("got", a.status);
      const b = await kit.http({ path: "/b" });
      return { a: a.body.echoed, b: b.status, sum: input.n + 1 };
    }`;
  const outcome = await run({ source, input: { n: 41 }, kit, deadline: soon() });
  assert.deepEqual(outcome, { ok: true, value: { a: { path: "/a", n: 41 }, b: 200, sum: 42 } });
  assert.deepEqual(seen, [{ path: "/a", n: 41 }, ["log", "got", 200], { path: "/b" }]);
});

test("a kit error reaches the script as an error it can catch, with only the message the host chose", async () => {
  const kit: Kit = {
    refused: () => Promise.reject(new Told("api.example.com isn't one of this toolkit's hosts")),
    broken: () => {
      throw new Error("a secret detail of the host");
    },
  };
  const source = `
    async function main(input, kit) {
      const caught = [];
      try { await kit.refused(); } catch (e) { caught.push(e.message); }
      try { kit.broken(); } catch (e) { caught.push(e.message); }
      return caught;
    }`;
  const outcome = await run({ source, input: null, kit, deadline: soon() });
  assert.deepEqual(outcome, { ok: true, value: ["api.example.com isn't one of this toolkit's hosts", "kit.broken failed"] });
});

test("a function that throws says what and on which of its lines", async () => {
  const source = "async function main() {\n  const x = null;\n  return x.y;\n}";
  const outcome = await run({ source, input: null, kit: {}, deadline: soon() });
  assert.equal(outcome.ok, false);
  assert.deepEqual(!outcome.ok && outcome.error, { name: "TypeError", message: "cannot read property 'y' of null", line: 3 });
});

test("a runaway loop is stopped at the deadline", async () => {
  const started = Date.now();
  const outcome = await run({ source: "async function main() { while (true) {} }", input: null, kit: {}, deadline: soon(300) });
  assert.equal(!outcome.ok && outcome.error.name, "Timeout");
  assert.ok(Date.now() - started < 2000);
});

test("a function that computes too long without awaiting is stopped, before or after an await, so AnythingLLM isn't held up", async () => {
  const kit: Kit = { tick: () => Promise.resolve(1) };
  for (const source of ["async function main() { while (true) {} }", "async function main(i, kit) { await kit.tick(); while (true) {} }"]) {
    const started = Date.now();
    const outcome = await run({ source, input: null, kit, deadline: soon(30_000) });
    assert.equal(!outcome.ok && outcome.error.name, "Busy", source);
    assert.match(!outcome.ok ? outcome.error.message : "", /without awaiting/);
    assert.ok(Date.now() - started < LIMITS.busyMs + 1500, "stopped at the limit, not the deadline");
  }
});

test("work split by awaits may take longer than the limit in all", async () => {
  const source = `async function main(i, kit) {
    for (let n = 0; n < 3; n++) { const until = Date.now() + ${LIMITS.busyMs * 0.6}; while (Date.now() < until) {} await kit.tick(); }
    return "done";
  }`;
  const outcome = await run({ source, input: null, kit: { tick: () => new Promise((r) => setTimeout(() => r(1), 5)) }, deadline: soon(30_000) });
  assert.deepEqual(outcome, { ok: true, value: "done" });
});

test("a function waiting on the host is stopped at the deadline, and the host is told to stop too", async () => {
  let aborted = false;
  const stop = new AbortController();
  stop.signal.addEventListener("abort", () => (aborted = true));
  const kit: Kit = { forever: () => new Promise(() => {}) };
  const outcome = await run({ source: "async function main(i, kit) { await kit.forever(); return 1; }", input: null, kit, deadline: soon(200), stop });
  assert.equal(!outcome.ok && outcome.error.name, "Timeout");
  assert.ok(aborted, "the stop signal fired, so a kit call in flight can end");
});

test("a run stopped from outside says it was stopped", async () => {
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 100);
  const outcome = await run({ source: "async function main(i, kit) { await kit.forever(); }", input: null, kit: { forever: () => new Promise(() => {}) }, deadline: soon(), stop });
  assert.equal(!outcome.ok && outcome.error.name, "Stopped");
});

test("a function that uses too much memory is stopped", async () => {
  const outcome = await run({ source: "async function main() { const a = []; while (true) a.push('x'.repeat(1e5)); }", input: null, kit: {}, deadline: soon(3000) });
  assert.equal(outcome.ok, false);
  assert.match(!outcome.ok ? `${outcome.error.name} ${outcome.error.message}` : "", /out of memory|Timeout/);
});

test("a function reaches nothing of the host: no process, require, fetch or files", async () => {
  const source = `async function main() {
    let escaped;
    try { escaped = typeof this.constructor.constructor("return process")(); } catch (e) { escaped = "threw " + e.message; }
    return [typeof process, typeof require, typeof fetch, typeof globalThis.std, typeof globalThis.os, escaped];
  }`;
  const outcome = await run({ source, input: null, kit: {}, deadline: soon() });
  assert.deepEqual(outcome, { ok: true, value: ["undefined", "undefined", "undefined", "undefined", "undefined", "threw 'process' is not defined"] });
});

test("an answer is JSON within its limit", async () => {
  const big = await run({ source: `async function main() { return "x".repeat(${LIMITS.resultChars + 10}); }`, input: null, kit: {}, deadline: soon() });
  assert.equal(!big.ok && big.error.name, "TooLarge");
  const none = await run({ source: "async function main() {}", input: null, kit: {}, deadline: soon() });
  assert.deepEqual(none, { ok: true, value: null });
});

test("the prelude runs first and may add helpers to kit; its own error names its file", async () => {
  const prelude = { "prelude/twice.js": "kit.twice = async (x) => 2 * x;" };
  const outcome = await run({ source: "async function main(input, kit) { return kit.twice(input); }", input: 21, kit: {}, prelude, deadline: soon() });
  assert.deepEqual(outcome, { ok: true, value: 42 });
  const broken = await run({ source: "async function main() {}", input: null, kit: {}, prelude: { "prelude/bad.js": "kit.x = ;" }, deadline: soon() });
  assert.match(!broken.ok ? broken.error.message : "", /^prelude\/bad\.js: /);
});

test("check finds a syntax error with its line, and a source without main", async () => {
  assert.equal(await check("async function main(input, kit) { return 1; }"), null);
  const syntax = await check("async function main() {\n  return (;\n}");
  assert.equal(syntax?.name, "SyntaxError");
  assert.equal(syntax?.line, 2);
  assert.equal((await check("async function helper() {}"))?.name, "NoMain");
  assert.ok(await check("while (true) {}\nasync function main() {}"), "a top level that never ends doesn't hold the check up");
});

test("many runs at once each get their own runtime and leave nothing behind", async () => {
  const kit: Kit = { wait: (ms) => later(ms, Number(ms)) };
  const outcomes = await Promise.all(Array.from({ length: 50 }, (_, i) => run({ source: "async function main(i, kit) { await kit.wait(5); return i * 2; }", input: i, kit, deadline: soon() })));
  assert.deepEqual(outcomes.map((o) => o.ok && o.value), Array.from({ length: 50 }, (_, i) => i * 2));
  // And the ones that time out while waiting don't break the ones after them.
  await Promise.all(Array.from({ length: 10 }, () => run({ source: "async function main(i, kit) { await kit.wait(1000); }", input: null, kit, deadline: soon(20) })));
  const after = await run({ source: "async function main() { return 'still fine'; }", input: null, kit: {}, deadline: soon() });
  assert.deepEqual(after, { ok: true, value: "still fine" });
});
