// Runs that outlive the chat's wait, and scheduled jobs' runs: a run goes on in the background and
// its end is shown once (at the top of the next library or run answer, and by a push); a run whose
// process ended first reads as interrupted; a scheduled job's run never goes to the background, and
// gets only the time the job has left. The chat waits LIBRARY_WAIT_MS, short here.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { call as called, library, reset, skillDir, storage, until } from "./harness.mts";

process.env.LIBRARY_WAIT_MS = "300";

const call = (args: Record<string, unknown>, slug: string | null = "work") => called(args, { slug });
const pushes: { to: unknown; payload: { title: string; body: string; data: { onClickUrl: string } } }[] = ((globalThis as Record<string, unknown>).__libraryLeanPushes ||= []) as never;

const SLOW = "async function main(i, kit) { for (let n = 0; n < (i.n || 1); n++) await kit.sleep(i.ms || 400); if (i.fail) throw new Error('it failed'); return { slept: i.n || 1 }; }";
const inputs = { n: { type: "number" }, ms: { type: "number" }, fail: { type: "boolean" } };

const idOf = (text: string) => text.match(/\((r-[\w-]+)\)/)![1];
const runsDir = () => path.join(library, "runs");
const recordOf = (id: string) => JSON.parse(fs.readFileSync(path.join(runsDir(), fs.readdirSync(runsDir()).find((f) => f.startsWith(id))!), "utf8"));

test.beforeEach(async () => {
  reset();
  pushes.length = 0;
  assert.match(await call({ action: "save", service: "clock", toolkit: { base_urls: ["https://example.com"] }, function: { name: "slow", description: "Sleeps.", inputs, source: SLOW } }), /Saved clock\.slow/);
});

test("a run the chat stops waiting for goes on, is pushed, and is shown once at the top of the next library answer", async () => {
  const said = await call({ action: "run", name: "clock.slow", inputs: { n: 2 } });
  assert.match(said, /^Still running clock\.slow in the background \(r-[\w-]+\): carry on\./);
  const id = idOf(said);
  assert.equal(recordOf(id).status, "running");
  assert.equal(recordOf(id).pid, process.pid);
  const meanwhile = await call({ action: "library" });
  assert.match(meanwhile, new RegExp(`- clock\\.slow: running, .*\\[${id}\\]`));
  assert.doesNotMatch(meanwhile, /Finished since/, "not until it ends");

  await until(() => pushes.length === 1);
  assert.deepEqual(pushes[0], { to: "primary", payload: { title: "clock.slow: ok", body: '{"slept":2}', data: { onClickUrl: "/workspace/work" } } });
  const next = await call({ action: "library" });
  assert.match(next, new RegExp(`^Finished since last shown [^\\n]*\\n- clock\\.slow: ok, [^\\n]*\\[${id}\\]: \\{"slept":2\\}\\n`));
  assert.doesNotMatch(await call({ action: "library" }), /Finished since/, "shown once");
  assert.equal(recordOf(id).pid, undefined, "an ended run keeps no process");
});

test("a background run's end is in the installed skill's description, which the model reads every turn, until an answer shows it", async (t) => {
  const installed = path.join(storage, "plugins", "agent-skills", "library-lean");
  fs.mkdirSync(installed, { recursive: true });
  t.after(() => fs.rmSync(path.join(storage, "plugins"), { recursive: true, force: true }));
  const file = path.join(installed, "plugin.json");
  fs.copyFileSync(path.join(skillDir, "plugin.json"), file);
  const description = () => JSON.parse(fs.readFileSync(file, "utf8")).description as string;
  const id = idOf(await call({ action: "run", name: "clock.slow", inputs: { n: 2 } }));
  assert.doesNotMatch(description(), /Ended, not shown/, "not while it runs");
  await until(() => description().includes("Ended, not shown"));
  assert.match(description(), new RegExp(`\\. Ended, not shown to the user yet: clock\\.slow \\(ok, ${id}\\): call library, which shows them\\.$`));
  assert.match(await call({ action: "library" }), /^Finished since last shown/);
  assert.doesNotMatch(description(), /Ended, not shown/, "shown now");
});

test("run with run_id waits for a background run again and shows it; stop: true stops one", async () => {
  const id = idOf(await call({ action: "run", name: "clock.slow", inputs: { n: 1, ms: 450 } }));
  assert.match(await call({ action: "run", run_id: id }), new RegExp(`^Ran clock\\.slow \\(${id}\\): ok, `));
  assert.doesNotMatch(await call({ action: "library" }), /Finished since/, "shown by its id already");

  const long = idOf(await call({ action: "run", name: "clock.slow", inputs: { n: 50 } }));
  assert.match(await call({ action: "run", run_id: long }), /is still running .*stop it with stop: true/);
  assert.match(await call({ action: "run", run_id: long, stop: true }), new RegExp(`^Ran clock\\.slow \\(${long}\\): stopped, `));
  assert.equal(recordOf(long).status, "stopped");
  await until(() => pushes.length === 2);
});

test("a run whose process ended first reads as interrupted; a scheduled job's is shown", async () => {
  const gone = spawnSync(process.execPath, ["-e", ""]).pid!;
  const started = new Date(Date.now() - 5000).toISOString();
  const running = (id: string, pid: number, trigger: string) => fs.writeFileSync(path.join(runsDir(), `${id}.clock.slow.json`), JSON.stringify({ id, fn: "clock.slow", trigger, workspace: trigger === "job" ? null : "work", pid, until: new Date(Date.now() + 60000).toISOString(), started, ended: started, ms: 0, status: "running", logs: [], calls: [] }));
  fs.mkdirSync(runsDir(), { recursive: true });
  running("r-000000001-aaaaaa", gone, "job");
  fs.mkdirSync(path.join(library, "unseen"), { recursive: true });
  fs.writeFileSync(path.join(library, "unseen", "r-000000001-aaaaaa"), ""); // as the run began
  running("r-000000002-bbbbbb", process.pid, "chat");

  const listing = await call({ action: "library" });
  assert.match(listing, /^Finished since last shown [^\n]*\n- clock\.slow: interrupted \(Interrupted: its process ended before it did[^\n]*from a scheduled job \[r-000000001-aaaaaa\]\n\n/);
  assert.match(listing, /- clock\.slow: interrupted .*\[r-000000002-bbbbbb\]/, "this process, but no longer going");
  assert.equal(recordOf("r-000000002-bbbbbb").status, "interrupted", "kept so");
});

test("a scheduled job's run goes to its end; one that fails is shown in the next chat, one that ends well isn't", async () => {
  assert.match(await call({ action: "run", name: "clock.slow", inputs: { n: 2 } }, null), /^Ran clock\.slow \(r-[\w-]+\): ok, /);
  assert.doesNotMatch(await call({ action: "library" }), /Finished since/, "AnythingLLM shows the job's own answer");
  const failed = idOf(await call({ action: "run", name: "clock.slow", inputs: { fail: true, ms: 10 } }, null));
  assert.match(await call({ action: "library" }), new RegExp(`^Finished since last shown [^\\n]*\\n- clock\\.slow: error \\(Error: it failed\\).*from a scheduled job \\[${failed}\\]`));
  assert.equal(pushes.length, 0, "a job pushes its own end");
});

test("in a scheduled job's process, a run gets only the time the job has left", async (t) => {
  const send = process.send;
  process.send = (() => true) as never;
  t.after(() => {
    process.send = send;
    delete process.env.SCHEDULED_JOB_TIMEOUT_MS;
  });
  const leaving = (ms: number) => (process.env.SCHEDULED_JOB_TIMEOUT_MS = String(Math.round(process.uptime() * 1000) + 30000 + ms));

  leaving(5000);
  assert.match(await call({ action: "run", name: "clock.slow" }, null), /too little of the scheduled job's time is left/);

  leaving(20000);
  const ran = call({ action: "run", name: "clock.slow" }, null);
  await until(() => fs.existsSync(runsDir()) && fs.readdirSync(runsDir()).length > 0);
  const record = JSON.parse(fs.readFileSync(path.join(runsDir(), fs.readdirSync(runsDir())[0]), "utf8"));
  const given = Date.parse(record.until) - Date.parse(record.started);
  assert.ok(given > 15000 && given <= 20000, `the run was given ${given} ms`);
  assert.match(await ran, /: ok, /);
});
