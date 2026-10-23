// The wake against a stand-in ntfy and a stand-in AnythingLLM on 127.0.0.1: a burst runs the job
// once, a message during a run makes one more after it, a restart catches up from the saved message,
// a dropped stream is followed again, a refused token logs in again, and no log line holds a
// message's text or a token.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { close, listen } from "#shared/test-helpers";
import { Anything } from "../src/anything.ts";
import { rulesOf, settingsIn, type Settings } from "../src/settings.ts";
import { serve, type Options } from "../src/wake.ts";

const NTFY_TOKEN = "tk_readonly_secret";
const PASSWORD = "allm-password";
const BODY = "BODY-TEXT-NEVER-LOGGED";

/** ntfy: each topic's messages, and its open streams. */
function fakeNtfy() {
  const sent: { id: string; topic: string }[] = [];
  const open = new Set<http.ServerResponse>();
  const asked: (string | null)[] = []; // the `since` of each subscription
  const line = (m: { id: string; topic: string }) => JSON.stringify({ id: m.id, time: 1, event: "message", topic: m.topic, message: BODY, title: BODY }) + "\n";
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    if (req.headers.authorization !== `Bearer ${NTFY_TOKEN}`) return res.writeHead(401).end('{"code":40101}');
    const topic = url.pathname.split("/")[1];
    const since = url.searchParams.get("since");
    asked.push(since);
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    res.write(JSON.stringify({ id: "open", event: "open", topic }) + "\n");
    if (since) {
      const at = sent.findIndex((m) => m.id === since);
      for (const m of sent.slice(at + 1)) if (m.topic === topic) res.write(line(m));
    }
    open.add(res);
    res.on("close", () => open.delete(res));
  });
  return {
    server,
    asked,
    publish(id: string, topic = "inbox") {
      const m = { id, topic };
      sent.push(m);
      for (const res of open) res.write(line(m));
    },
    /** Messages sent while no one was following (the wake was away). */
    store(id: string, topic = "inbox") {
      sent.push({ id, topic });
    },
    drop() {
      for (const res of open) res.destroy();
    },
    following: () => open.size,
  };
}

/** AnythingLLM: job 26, its runs, its triggers, and its logins. */
function fakeAnything() {
  const state = { logins: 0, token: "", triggers: 0, runs: [] as { id: number; status: string }[] };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const send = (status: number, json: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(json));
    if (req.url === "/api/request-token") {
      if (JSON.parse(body).password !== PASSWORD) return send(401, { valid: false, token: null, message: "[003] Invalid password provided" });
      state.logins++;
      state.token = `jwt-${state.logins}`;
      return send(200, { valid: true, token: state.token });
    }
    if (req.headers.authorization !== `Bearer ${state.token}`) return send(401, { error: "Unauthorized" });
    if (req.method === "GET" && req.url === "/api/scheduled-jobs/26") return send(200, { job: { id: 26, name: "ntfy channel" } });
    if (req.method === "GET" && req.url === "/api/scheduled-jobs/26/runs") return send(200, { runs: [...state.runs].reverse() });
    if (req.method === "POST" && req.url === "/api/scheduled-jobs/26/trigger") {
      state.triggers++;
      state.runs.push({ id: state.runs.length + 1, status: "running" });
      return send(200, { success: true });
    }
    send(404, { job: null, error: "Job not found" });
  });
  return { server, state, finish: () => state.runs.forEach((r) => (r.status = "completed")) };
}

const until = async (what: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const ntfy = fakeNtfy();
  const allm = fakeAnything();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-"));
  const settings: Settings = { ntfyUrl: `http://127.0.0.1:${await listen(ntfy.server)}`, ntfyToken: NTFY_TOKEN, rules: [{ topic: "inbox", job: 26 }] };
  const base = `http://127.0.0.1:${await listen(allm.server)}`;
  const opts: Options = { stateFile: path.join(dir, "state", "state.json"), burstMs: 80, gapMs: 0, reconnectMs: [20], recheckMs: 30 };
  const lines: string[] = [];
  let stop = new AbortController();
  let running: Promise<void> = Promise.resolve();
  const start = () => {
    stop = new AbortController();
    running = serve(settings, new Anything(base, () => PASSWORD), (l) => lines.push(l), stop.signal, opts);
  };
  const halt = async () => {
    stop.abort();
    await running;
  };
  const done = async () => {
    await halt();
    await close(ntfy.server);
    await close(allm.server);
    for (const l of lines) assert.ok(!l.includes(BODY) && !l.includes(NTFY_TOKEN) && !l.includes(PASSWORD) && !l.includes("jwt-"), `a log line said too much: ${l}`);
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { ntfy, allm, settings, opts, lines, start, halt, done };
}

test("a burst of messages runs the job once, and the last one is kept", async () => {
  const t = await setup();
  t.start();
  await until(() => t.ntfy.following() === 1);
  for (const id of ["m1", "m2", "m3"]) {
    t.ntfy.publish(id);
    await sleep(20);
  }
  await until(() => t.allm.state.triggers === 1);
  await sleep(200);
  assert.equal(t.allm.state.triggers, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(t.opts.stateFile, "utf8")), { inbox: "m3" });
  assert.equal((fs.statSync(t.opts.stateFile).mode & 0o777).toString(8), "600");
  await t.done();
});

test("a message while a run goes makes one more run after it ends", async () => {
  const t = await setup();
  t.start();
  await until(() => t.ntfy.following() === 1);
  t.ntfy.publish("m1");
  await until(() => t.allm.state.triggers === 1);
  t.ntfy.publish("m2");
  t.ntfy.publish("m3");
  await sleep(300);
  assert.equal(t.allm.state.triggers, 1, "no second run while the first goes");
  t.allm.finish();
  await until(() => t.allm.state.triggers === 2);
  await sleep(200);
  assert.equal(t.allm.state.triggers, 2);
  await t.done();
});

test("a restart follows from the saved message and runs once for what came meanwhile", async () => {
  const t = await setup();
  t.start();
  await until(() => t.ntfy.following() === 1);
  t.ntfy.publish("m1");
  await until(() => t.lines.length === 1); // the run's message kept
  t.allm.finish();
  await t.halt();
  t.ntfy.store("m2");
  t.ntfy.store("m3");
  t.start();
  await until(() => t.allm.state.triggers === 2);
  assert.equal(t.ntfy.asked.at(-1), "m1");
  await sleep(200);
  assert.equal(t.allm.state.triggers, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(t.opts.stateFile, "utf8")), { inbox: "m3" });
  await t.done();
});

test("a restart with nothing new runs nothing", async () => {
  const t = await setup();
  t.start();
  await until(() => t.ntfy.following() === 1);
  t.ntfy.publish("m1");
  await until(() => t.lines.length === 1); // the run's message kept
  t.allm.finish();
  await t.halt();
  t.start();
  await until(() => t.ntfy.following() === 1);
  await sleep(200);
  assert.equal(t.allm.state.triggers, 1);
  await t.done();
});

test("a dropped stream is followed again, from the last message", async () => {
  const t = await setup();
  t.start();
  await until(() => t.ntfy.following() === 1);
  t.ntfy.publish("m1");
  await until(() => t.allm.state.triggers === 1);
  t.allm.finish();
  t.ntfy.drop();
  await until(() => t.ntfy.asked.length === 2 && t.ntfy.following() === 1);
  assert.equal(t.ntfy.asked[1], "m1");
  t.ntfy.publish("m2");
  await until(() => t.allm.state.triggers === 2);
  assert.ok(t.lines.some((l) => l.includes("following again")));
  await t.done();
});

test("a token AnythingLLM no longer takes means a new login", async () => {
  const t = await setup();
  t.start();
  await until(() => t.ntfy.following() === 1);
  t.ntfy.publish("m1");
  await until(() => t.allm.state.triggers === 1);
  t.allm.finish();
  t.allm.state.token = "rotated";
  t.ntfy.publish("m2");
  await until(() => t.allm.state.triggers === 2);
  assert.equal(t.allm.state.logins, 2);
  await t.done();
});

test("runs are kept GAP_MS apart", async () => {
  const t = await setup();
  t.opts.gapMs = 600;
  t.start();
  await until(() => t.ntfy.following() === 1);
  t.ntfy.publish("m1");
  await until(() => t.allm.state.triggers === 1);
  const first = Date.now();
  t.allm.finish();
  t.ntfy.publish("m2");
  await until(() => t.allm.state.triggers === 2);
  assert.ok(Date.now() - first >= 550, "the second run waited out the gap");
  await t.done();
});

test("a refused ntfy token is said, and tried again", async () => {
  const t = await setup();
  t.settings.ntfyToken = "wrong";
  t.start();
  await until(() => t.lines.filter((l) => l.includes("401")).length >= 2);
  assert.match(t.lines[0], /inbox: ntfy answered 401: the token wasn't taken/);
  await t.done();
});

test("settings: the skill's own, from its plugin.json, and WAKE's pairs", () => {
  assert.deepEqual(rulesOf(" anythingllm=26, alerts = 31 ,"), [
    { topic: "anythingllm", job: 26 },
    { topic: "alerts", job: 31 },
  ]);
  for (const bad of ["anythingllm", "anythingllm=x", "a/b=2", "a=0", "a=1=2"]) assert.throws(() => rulesOf(bad), /WAKE/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-settings-"));
  const file = path.join(dir, "plugin.json");
  fs.writeFileSync(file, JSON.stringify({ setup_args: { NTFY_URL: { value: "https://ntfy.example/" }, NTFY_TOKEN: { value: " tk " }, WAKE: { value: "inbox=26" } } }));
  assert.deepEqual(settingsIn(file), { ntfyUrl: "https://ntfy.example", ntfyToken: "tk", rules: [{ topic: "inbox", job: 26 }] });
  fs.rmSync(dir, { recursive: true, force: true });
});
