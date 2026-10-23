// The skill as AnythingLLM loads it: the built handler.js (build/wake-lean), required afresh for each
// agent run, with its settings in the plugin.json beside it. Loading it starts the process's one
// listener; loading it again with the same code and settings keeps that one; other settings replace
// it; a scheduled job's process never listens. `npm run skills:test` builds the bundle first.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { close, listen } from "#shared/test-helpers";

const require = createRequire(import.meta.url);
const built = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "build", "wake-lean");
const storage = fs.mkdtempSync(path.join(os.tmpdir(), "wake-lean-"));
process.env.STORAGE_DIR = storage;
const installed = path.join(storage, "plugins", "agent-skills", "wake-lean");
fs.cpSync(built, installed, { recursive: true });

/** ntfy: the topics followed now, and every subscription made. */
const open = new Map<http.ServerResponse, string>();
const subscribed: string[] = [];
const ntfy = http.createServer((req, res) => {
  const topic = new URL(req.url!, "http://x").pathname.split("/")[1];
  if (req.headers.authorization !== "Bearer tk") return res.writeHead(401).end();
  subscribed.push(topic);
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  res.write(JSON.stringify({ id: "o", event: "open", topic }) + "\n");
  open.set(res, topic);
  res.on("close", () => open.delete(res));
});
const following = () => [...open.values()].sort();

function settle(wake: string, url?: string): void {
  const file = path.join(installed, "plugin.json");
  const plugin = JSON.parse(fs.readFileSync(file, "utf8"));
  plugin.setup_args.NTFY_URL.value = url;
  plugin.setup_args.NTFY_TOKEN.value = "tk";
  plugin.setup_args.WAKE.value = wake;
  fs.writeFileSync(file, JSON.stringify(plugin));
}

/** Loads the skill as AnythingLLM does for an agent run, and asks its status. */
function run(dir = installed): Promise<string> {
  const handler = path.join(dir, "handler.js");
  delete require.cache[handler];
  return require(handler).runtime.handler.call({}, { action: "status" });
}

const until = async (what: () => boolean) => {
  for (let i = 0; !what(); i++) {
    if (i > 500) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test.after(async () => {
  settle(""); // the listener stops at the next load
  await run();
  await close(ntfy);
  fs.rmSync(storage, { recursive: true, force: true });
});

test("not set up, it says what's missing and listens to nothing", async () => {
  assert.match(await run(), /^The wake isn't listening: it isn't set up: missing NTFY_URL.*NTFY_TOKEN.*WAKE.*Settings > Agent Skills > Wake\.$/s);
  assert.match(await run(), /action is status, not|isn't listening/);
});

test("set up, a load starts one listener, a load with the same settings keeps it, other settings replace it", async () => {
  const url = `http://127.0.0.1:${await listen(ntfy)}`;
  settle("inbox=26", url);
  assert.match(await run(), /^The wake is listening\. .*\n.*Z following inbox for job 26\n/s);
  await until(() => following().join() === "inbox");
  await run();
  await run();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(subscribed, ["inbox"], "one subscription for the same code and settings");
  settle("alerts=31,inbox=26", url);
  await run();
  await until(() => following().join() === "alerts,inbox");
  assert.equal(subscribed.length, 3, "the old stream closed, two new ones");
});

test("an unknown action is said; a scheduled job's own process doesn't listen", async () => {
  const handler = path.join(installed, "handler.js");
  assert.equal(await require(handler).runtime.handler.call({}, { action: "read" }), 'The wake\'s action is status, not "read".');
  const before = subscribed.length;
  const send = process.send;
  process.send = (() => true) as typeof process.send; // as in the process AnythingLLM forks for a job
  try {
    settle("other=5", `http://127.0.0.1:${(ntfy.address() as { port: number }).port}`);
    assert.equal(await run(), "The wake listens in AnythingLLM's own process, not in a scheduled job's.");
  } finally {
    process.send = send;
  }
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(subscribed.length, before);
});
