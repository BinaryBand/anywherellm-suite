import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { perProcess } from "./anythingllm.mts";
import { type Ask, type Asking, askToReach, asksDir, foreground, grantsOf, letThrough, quietly, runAs, withAsk } from "./ask.mts";
import { updateJson } from "./atomic.mts";
import { Fenced, NetError, allowedNow, currentRun } from "./fence.mts";

const storage = fs.mkdtempSync(path.join(os.tmpdir(), "ask-"));
after(() => fs.rmSync(storage, { recursive: true, force: true }));
process.env.STORAGE_DIR = storage;
beforeEach(() => fs.rmSync(path.join(storage, "fence-lean"), { recursive: true, force: true }));

/** A chat through AnythingLLM's developer API in `slug`, its lines kept in `said`. */
function chat(slug = "work"): Asking & { said: string[] } {
  const said: string[] = [];
  return { said, super: { handlerProps: { invocation: { workspace: { slug } } } }, introspect: (m) => said.push(m) };
}

/** The ask a chat's line names, once it's written. */
async function askOf(self: { said: string[] }): Promise<{ id: string; file: string; ask: Ask }> {
  for (let i = 0; i < 100 && !self.said.length; i++) await new Promise((r) => setTimeout(r, 10));
  const id = self.said[0].match(/\[ask:([0-9a-f]{32})\]$/)![1];
  const file = path.join(asksDir(), `${id}.json`);
  return { id, file, ask: JSON.parse(fs.readFileSync(file, "utf8")) };
}

/** Answers the ask as the bridge does: its decision, under its lock. */
const decide = (file: string, decision: string) => updateJson<Record<string, unknown>, void>(file, () => ({}), (a) => Object.assign(a, { decision, decided: new Date().toISOString() }));

const QUICK = { pollMs: 10 };
const what = { skill: "Library", host: "Muse-VM", origin: "http://muse-vm:8463", why: "Send a request to http://muse-vm:8463" };

test("only a chat through the developer API, in AnythingLLM's own process, asks", () => {
  assert.ok(foreground(chat(), false));
  assert.ok(!foreground(chat(), true), "a scheduled job's or Telegram's process");
  assert.ok(!foreground({ super: { handlerProps: { invocation: {} } }, introspect: () => {} }, false), "no workspace: a scheduled job");
  assert.ok(!foreground({ super: { handlerProps: { invocation: { workspace: { slug: "w" }, uuid: "u-1" } } }, introspect: () => {} }, false), "AnythingLLM's web UI");
  assert.ok(!foreground({ super: { handlerProps: { invocation: { workspace: { slug: "w" }, thread_id: 3 } } }, introspect: () => {} }, false), "a thread: the web UI's");
  assert.ok(!foreground({ super: { handlerProps: { invocation: { workspace: { slug: "w" } } } } }, false), "no line to say it in");
});

test("an ask is written for the bridge, named in the chat, and a yes lets the host through for the run", async () => {
  const self = chat();
  const asked = askToReach(self, what, QUICK);
  const { id, file, ask } = await askOf(self);
  assert.equal(self.said[0], `Waiting for your approval in AnywhereLLM to reach muse-vm [ask:${id}]`);
  assert.deepEqual(Object.keys(ask).sort(), ["asked", "decided", "decision", "expires", "host", "id", "origin", "skill", "why", "workspace"]);
  assert.equal(ask.host, "muse-vm");
  assert.equal(ask.workspace, "work");
  assert.equal(ask.decision, null);
  assert.equal(Date.parse(ask.expires) - Date.parse(ask.asked), 120 * 1000);
  await decide(file, "once");
  assert.equal(await asked, "once");
  assert.ok(grantsOf(self).has("muse-vm"));
  assert.ok(!grantsOf(chat()).has("muse-vm"), "another run isn't let through");
  assert.ok(!fs.existsSync(file), "the ask is taken away once answered");
});

test("a no, an ask nobody answers and one taken away are refusals", async () => {
  const self = chat();
  const denied = askToReach(self, what, QUICK);
  await decide((await askOf(self)).file, "deny");
  assert.equal(await denied, "deny");
  assert.equal(await askToReach(chat(), what, { pollMs: 10, waitMs: 100 }), "expired");
  const gone = chat();
  const removed = askToReach(gone, what, QUICK);
  fs.rmSync((await askOf(gone)).file);
  assert.equal(await removed, "deny");
  assert.ok(!grantsOf(self).has("muse-vm") && !grantsOf(gone).has("muse-vm"));
  assert.deepEqual(fs.readdirSync(asksDir()).filter((f) => f.endsWith(".json")), []);
});

test("letThrough tells the agent why a host stays refused, and that it's final", async () => {
  const self = chat();
  const refused = letThrough(self, "Library", { host: "muse-vm", origin: "http://muse-vm:8463" }, "Send a request to http://muse-vm:8463");
  await decide((await askOf(self)).file, "deny");
  await assert.rejects(refused, (e) => e instanceof NetError && /^http:\/\/muse-vm:8463 isn't reached: the user declined it in AnywhereLLM\. That's final/.test(e.message));
  const always = chat();
  const let_ = letThrough(always, "Library", { host: "muse-vm", origin: "http://muse-vm:8463" }, "x");
  await decide((await askOf(always)).file, "always");
  await let_;
  assert.ok(grantsOf(always).has("muse-vm"));
});

test("asks left behind by a process that ended are swept an hour after they ran out, once an hour", async () => {
  const dir = asksDir();
  fs.mkdirSync(dir, { recursive: true });
  const write = (name: string, agoMs: number) => {
    const file = path.join(dir, `${name.repeat(32)}.json`);
    fs.writeFileSync(file, "{}");
    const at = (Date.now() - agoMs) / 1000;
    fs.utimesSync(file, at, at);
  };
  write("a", 2 * 3600 * 1000);
  write("b", 60 * 1000);
  // The sweep the earlier tests' asks made this hour: as if it was an hour ago.
  perProcess("fence.swept", () => ({ at: 0 })).at = 0;
  await askToReach(chat(), what, { pollMs: 10, waitMs: 20 });
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${"b".repeat(32)}.json`]);
  write("c", 2 * 3600 * 1000);
  await askToReach(chat(), what, { pollMs: 10, waitMs: 20 });
  assert.equal(fs.readdirSync(dir).length, 2, "not again within the hour");
});

test("a run asks for what the fence refuses and tries again; its background work keeps the grants and never asks", async () => {
  const self = chat();
  let tries = 0;
  const refuseUntilLet = async () => {
    tries++;
    if (!allowedNow().has("muse-vm")) throw new Fenced("refused", "muse-vm", "http://muse-vm:8463");
    return "sent";
  };
  const sent = runAs(self, "Library", (o) => `Send a request to ${o}`, () => withAsk(refuseUntilLet));
  await decide((await askOf(self)).file, "once");
  assert.equal(await sent, "sent");
  assert.equal(tries, 2);
  assert.match(self.said[0], /reach muse-vm \[ask:/);
  assert.deepEqual(fs.readdirSync(asksDir()), [], "the ask is gone once answered");
  const later = runAs(self, "Library", (o) => o, () => quietly(() => (assert.equal(currentRun()?.ask, undefined), withAsk(refuseUntilLet))));
  assert.equal(await later, "sent", "the run's grant holds in its background work");
  await assert.rejects(runAs(chat(), "Library", undefined, () => withAsk(refuseUntilLet)), Fenced, "no why: no asking");
  await assert.rejects(withAsk(refuseUntilLet), Fenced, "outside a run: refused as before");
});
