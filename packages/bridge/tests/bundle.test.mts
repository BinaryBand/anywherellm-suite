// The built file, run as a person would run it: `node dist/anywherellm-suite.cjs serve`.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FakeAnythingLLM } from "./fakes/anythingllm.mts";
import { close, listen } from "./fakes/net.mts";
import { tempDir } from "./fakes/tmp.mts";

const bundle = fileURLToPath(new URL("../dist/anywherellm-suite.cjs", import.meta.url));
const tmp = tempDir("bundle");
// Its own home and settings file on every OS, so a run never reads or writes the real ones.
const baseEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: tmp, USERPROFILE: tmp, APPDATA: tmp, BRIDGE_ENV_FILE: path.join(tmp, "bridge.env") }; // SystemRoot: Node on Windows needs it

const freePort = async () => {
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);
  return port;
};

test("serve passes a listed route for a good key and refuses the rest", async () => {
  const fake = await new FakeAnythingLLM().start();
  const port = await freePort();
  const child = spawn(process.execPath, [bundle, "serve"], {
    env: { ...baseEnv, ANYTHINGLLM_URL: fake.url, BRIDGE_PORT: String(port), BRIDGE_ALLOW: "GET /scheduled-jobs" },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stderr.on("data", (d) => String(d).includes("the bridge on") && resolve());
      child.on("exit", (code) => reject(new Error(`exited ${code}`)));
    });
    const url = `http://127.0.0.1:${port}`;
    assert.deepEqual(await (await fetch(`${url}/health`)).json(), { ok: true, service: "anywherellm-bridge", allow: ["GET /scheduled-jobs"] });
    const key = { Authorization: "Bearer good-key" };
    assert.deepEqual(await (await fetch(`${url}/scheduled-jobs`, { headers: key })).json(), { ok: true });
    assert.equal((await fetch(`${url}/system/api-keys`, { headers: key })).status, 403);
    assert.equal((await fetch(`${url}/scheduled-jobs`)).status, 401);
  } finally {
    child.removeAllListeners("exit");
    child.kill();
    await fake.stop();
  }
});

test("serve exits 1 and says so when its port is taken", async () => {
  const taken = http.createServer();
  const port = await listen(taken);
  const done = spawnSync(process.execPath, [bundle, "serve"], { env: { ...baseEnv, BRIDGE_PORT: String(port) }, encoding: "utf8" });
  await close(taken);
  assert.equal(done.status, 1);
  assert.match(done.stderr, /EADDRINUSE/);
});

test("a command it doesn't know prints the usage and exits 2; settings prints the defaults", () => {
  const env = baseEnv;
  assert.equal(spawnSync(process.execPath, [bundle, "nope"], { env, encoding: "utf8" }).status, 2);
  const out = spawnSync(process.execPath, [bundle, "settings"], { env, encoding: "utf8" }).stdout;
  assert.match(out, /^BRIDGE_PORT=8467$/m);
  assert.match(out, /^BRIDGE_ALLOW=$/m);
});
