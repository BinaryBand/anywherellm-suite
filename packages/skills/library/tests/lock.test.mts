// A toolkit the user locks on the Library page: nothing the agent does changes or removes it, or its
// functions, until the user unlocks it there; its functions still run, and run only locked
// toolkits' functions; and an event without the page's secret locks or unlocks nothing.

import assert from "node:assert/strict";
import test from "node:test";
import { call, idOf, pageConfig, pageState, post, reset, runRecord } from "./harness.mts";

const LOCKED = /the user locked the toolkit chan on the Library page: it can't be changed or removed/;
const fn = (name: string, source: string) => ({ name, description: `${name}.`, source });

/** Posts `ev` for the toolkit `service` from the Library page, and lets the skill apply it. */
async function page(ev: string, service: string, secret = pageConfig().secret): Promise<void> {
  post({ secret, ev, service });
  await call({ action: "library" });
}

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
  post({ secret: pageConfig().secret, ev: "fn-delete", fn: "chan.say" });
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
