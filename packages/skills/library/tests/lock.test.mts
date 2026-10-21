// A toolkit the user locks on the Library page: nothing the agent does changes or removes it, or its
// functions, until the user unlocks it there; its functions still run, and run only locked
// toolkits' functions, and its keys are for locked toolkits only; and an event without the page's
// secret locks or unlocks nothing.

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { call, giveKey, idOf, outcome, page, pageState, post, reset, runRecord } from "./harness.mts";

const LOCKED = /the user locked the toolkit chan on the Library page: it can't be changed or removed/;
const fn = (name: string, source: string) => ({ name, description: `${name}.`, source });

test.beforeEach(async () => {
  reset();
  await call({ action: "save", service: "chan", toolkit: { title: "A channel" }, function: fn("say", "async function main(i, kit) { kit.state.set({ n: 1 }); return 'said'; }") });
  await call({ action: "library" }); // writes the Library page
});

test("a locked toolkit can't be saved, changed or removed by the agent, and its functions still run", async () => {
  await page("toolkit-lock", "chan");
  assert.equal(pageState().toolkits[0].locked, true);
  assert.match(await call({ action: "library" }), /- chan: A channel \(locked by the user: it can't be changed or removed\)\./);
  assert.match(await call({ action: "library", service: "chan" }), /^Toolkit chan: A channel \(locked by the user/);
  assert.match(await call({ action: "save", service: "chan", toolkit: { notes: "changed" } }), LOCKED);
  assert.match(await call({ action: "save", service: "chan", function: fn("say", "async function main() { return 'forged'; }") }), LOCKED);
  assert.match(await call({ action: "save", service: "chan", function: fn("other", "async function main() { return 1; }") }), LOCKED);
  assert.match(await call({ action: "save", service: "chan", remove: "say" }), LOCKED);
  assert.match(await call({ action: "save", service: "chan", remove: "chan" }), LOCKED);
  const run = runRecord(idOf(await call({ action: "run", name: "chan.say" })));
  assert.equal(run.result, "said", "it runs as the user read it");

  await page("toolkit-unlock", "chan");
  assert.equal(pageState().toolkits[0].locked, false);
  assert.match(await call({ action: "save", service: "chan", function: fn("say", "async function main() { return 'changed'; }") }), /Saved chan\.say, version 2/);
});

test("the page deletes nothing in a locked toolkit; unlocked first, it does", async () => {
  await page("toolkit-lock", "chan");
  post({ ev: "fn-delete", fn: "chan.say" });
  await page("toolkit-delete", "chan");
  assert.deepEqual(pageState().toolkits.map((t: { service: string; functions: unknown[] }) => [t.service, t.functions.length]), [["chan", 1]]);
  await page("toolkit-unlock", "chan");
  await page("toolkit-delete", "chan");
  assert.match(await call({ action: "library" }), /^The library is empty/);
});

test("an event without the page's secret locks and unlocks nothing", async () => {
  await page("toolkit-lock", "chan", "not-the-secret");
  assert.equal(pageState().toolkits[0].locked, false);
  await page("toolkit-lock", "chan");
  await page("toolkit-unlock", "chan", "not-the-secret");
  assert.equal(pageState().toolkits[0].locked, true);
});

test("a locked toolkit's functions run only locked toolkits' functions", async () => {
  await call({ action: "save", service: "chan", function: fn("relay", "async function main(i, kit) { return kit.run('helper.x', {}); }") });
  await call({ action: "save", service: "helper", toolkit: { title: "Helper" }, function: fn("x", "async function main() { return 'helped'; }") });
  await page("toolkit-lock", "chan");
  const refused = runRecord(idOf(await call({ action: "run", name: "chan.relay" })));
  assert.equal(refused.status, "error");
  assert.match(refused.error.message, /chan is locked, and a locked toolkit's functions run only locked toolkits' functions: helper isn't locked/);
  await page("toolkit-lock", "helper");
  assert.equal(runRecord(idOf(await call({ action: "run", name: "chan.relay" }))).result, "helped");
});

test("a key a locked toolkit names is for locked toolkits only: not for call, nor an unlocked toolkit, until the user unlocks it", async (t) => {
  const api = http.createServer((req, res) => res.end(JSON.stringify(req.headers.authorization === "Bearer tok-1" ? "posted" : "no key")));
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => api.close());
  const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  await giveKey("tok", "127.0.0.1", "tok-1");
  const posting = "async function main(i, kit) { return (await kit.http({ method: 'POST', path: '/topic', body: 'hi' })).body; }";
  const kit = (title: string) => ({ title, base_urls: [base], secrets: [{ label: "tok", as: "bearer" }] });
  await call({ action: "save", service: "chan", toolkit: kit("A channel"), function: fn("send", posting) });
  await call({ action: "save", service: "other", toolkit: kit("Another"), function: fn("send", posting) });
  const called = (auth: unknown = { key: "tok", as: "bearer" }) => call({ action: "call", url: `${base}/topic`, method: "POST", body: "hi", auth });
  assert.equal(await outcome("other.send"), "posted", "before the lock, any toolkit naming it");
  assert.match(await called(), /"posted"/);

  await page("toolkit-lock", "chan");
  assert.equal(await outcome("chan.send"), "posted", "the locked toolkit");
  assert.match(await outcome("other.send"), /the key "tok" can't be used by the other toolkit: kept for locked toolkits \(chan\)/);
  assert.match(await called(), /the key "tok" can't be used in call: kept for locked toolkits \(chan\)/);
  assert.match(await called("bearer"), /can't be used in call/, "nor found by its host");
  assert.match(await call({ action: "library", service: "other" }), /tok \(bearer, [^)]*, not usable here: kept for locked toolkits \(chan\)\)/);

  await page("toolkit-lock", "other");
  assert.equal(await outcome("other.send"), "posted", "another locked toolkit");
  await page("toolkit-unlock", "other");
  await page("toolkit-unlock", "chan");
  assert.equal(await outcome("other.send"), "posted", "unlocked, it's free again");
  assert.match(await called(), /"posted"/);
});
