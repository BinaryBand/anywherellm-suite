// Locking a toolkit and its targets: a target a locked toolkit uses is for locked toolkits only, a
// locked toolkit uses a target only as it was when the user locked it (its host, port, account and
// host key are pinned), and a toolkit locked before pins existed is pinned once, when first opened.
// The machines don't exist: what is under test is the refusal that comes before any connection.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { call, idOf, library, pageState, post, reset, runRecord, until } from "./harness.mts";

const FINGERPRINT = `SHA256:${"A".repeat(43)}`;
const saveTarget = (fields: Record<string, unknown> = {}) => post({ ev: "target-save", label: "box", host: "box.internal", port: "22", login: "sandbox", fingerprint: FINGERPRINT, private: true, sealed: "", ...fields });
// A function that runs one command and answers what became of it.
const SOURCE = `async function main(i, kit) { try { await kit.ssh.exec({ target: kit.target, command: "id", timeout_s: 1 }); return "ran"; } catch (e) { return String(e.message); } }`;
const kitFile = (service: string) => path.join(library, "toolkits", service, "toolkit.json");
const kitJson = (service: string) => JSON.parse(fs.readFileSync(kitFile(service), "utf8"));

async function toolkit(service: string, target: string): Promise<void> {
  const source = SOURCE.replace("kit.target", JSON.stringify(target));
  await call({ action: "save", service, toolkit: { title: service, targets: [target] }, function: { name: "go", description: "Runs id.", source } });
}
async function answer(service: string): Promise<string> {
  return runRecord(idOf(await call({ action: "run", name: `${service}.go` }))).result;
}
async function page(ev: string, service: string): Promise<void> {
  post({ ev, service });
  await call({ action: "library" });
}
async function registered(n: number): Promise<void> {
  await call({ action: "library" });
  await until(() => pageState().result?.n === n);
}

test.beforeEach(async () => {
  reset();
  await call({ action: "library" });
  saveTarget();
  await registered(1);
});

const HELD = /can't be used by the \w+ toolkit: kept for locked toolkits \(locked\)/;
const CHANGED = /can't be used by the locked toolkit: changed since the user locked locked/;

test("an unlocked toolkit can't use a target a locked toolkit holds, by its name or by another name for the same account", async () => {
  await toolkit("locked", "box");
  await toolkit("other", "box");
  assert.doesNotMatch(await answer("other"), HELD, "nothing holds it yet");
  await page("toolkit-lock", "locked");
  assert.match(await answer("other"), HELD);
  assert.equal(pageState().targets[0].held, "locked", "the Targets card says so");
  assert.match(await call({ action: "library", service: "other" }), /not usable here: kept for locked toolkits \(locked\)/);

  saveTarget({ label: "twin" }); // the same machine and account, another name
  await registered(2);
  await toolkit("third", "twin");
  assert.match(await answer("third"), /kept for locked toolkits \(locked\)/);
  assert.doesNotMatch(await answer("locked"), /can't be used/, "the locked toolkit itself still gets through to the machine");
});

test("a locked toolkit refuses a target changed since it was locked, until the user locks it again", async () => {
  await toolkit("locked", "box");
  await page("toolkit-lock", "locked");
  assert.doesNotMatch(await answer("locked"), /can't be used/);
  assert.deepEqual(Object.keys(kitJson("locked").pins), ["box"]);

  saveTarget({ login: "root" }); // the same name, now another account
  await registered(2);
  assert.match(await answer("locked"), CHANGED);
  assert.match(await call({ action: "library", service: "locked" }), /not usable here: changed since the user locked locked/);

  await page("toolkit-unlock", "locked");
  assert.equal(kitJson("locked").pins, undefined, "unlocking drops the pins");
  await page("toolkit-lock", "locked");
  assert.doesNotMatch(await answer("locked"), /can't be used/, "locked again, it takes the target as it is");
});

test("a toolkit locked before locking pinned its targets is pinned once, when it is first opened, and a second open writes nothing", async () => {
  await toolkit("old", "box");
  const old = kitJson("old");
  fs.writeFileSync(kitFile("old"), JSON.stringify({ ...old, locked: true }, null, 2) + "\n"); // as it was saved before pins
  assert.equal(kitJson("old").pins, undefined);
  await call({ action: "library", service: "old" });
  const pinned = fs.readFileSync(kitFile("old"), "utf8");
  assert.deepEqual(Object.keys(JSON.parse(pinned).pins), ["box"]);
  const at = fs.statSync(kitFile("old")).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  await call({ action: "library", service: "old" });
  assert.equal(fs.readFileSync(kitFile("old"), "utf8"), pinned);
  assert.equal(fs.statSync(kitFile("old")).mtimeMs, at, "not written again");
  assert.doesNotMatch(await answer("old"), /can't be used/, "it takes the target as it was when pinned");
});

test("a command a function runs is never in the run record, only its length", async () => {
  await toolkit("plain", "box");
  const source = `async function main(i, kit) { try { await kit.ssh.exec({ target: "box", command: "echo hunter2-token", timeout_s: 1 }); } catch (e) {} return "done"; }`;
  await call({ action: "save", service: "plain", function: { name: "go", description: "Runs it.", source } });
  const record = runRecord(idOf(await call({ action: "run", name: "plain.go" })));
  assert.ok(record.calls.length, "the command was tried");
  assert.doesNotMatch(JSON.stringify(record), /hunter2/);
  assert.match(record.calls[0].path, /\$ \(18 characters\)/);
});
