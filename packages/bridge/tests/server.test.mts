import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import consumers from "node:stream/consumers";
import { parseRules } from "../src/allow.mts";
import { createServer } from "../src/server.mts";
import { passwordIn, Upstream } from "#shared/upstream";
import { FakeAnythingLLM } from "./fakes/anythingllm.mts";
import { close, listen } from "./fakes/net.mts";
import { tempDir } from "./fakes/tmp.mts";
import { until } from "./fakes/until.mts";

let fake: FakeAnythingLLM;
let bridge: ReturnType<typeof createServer>;
let url: string;
let logged: string[];

const tmp = tempDir("server");

async function start(allow: string, envFile: string | null = null): Promise<void> {
  logged = [];
  bridge = createServer({ rules: parseRules(allow), upstream: new Upstream(fake.url, envFile ? passwordIn(envFile) : null), log: (l) => logged.push(l) });
  url = `http://127.0.0.1:${await listen(bridge)}`;
}

beforeEach(async () => {
  fake = await new FakeAnythingLLM().start();
  await start("GET /scheduled-jobs, POST /scheduled-jobs/new, /workspaces");
});
afterEach(async () => {
  await close(bridge);
  await fake.stop();
});

const KEY = { Authorization: "Bearer good-key" };
const call = async (method: string, path: string, init: { headers?: Record<string, string>; body?: string } = {}) => {
  const res = await fetch(url + path, { method, headers: { ...KEY, ...init.headers }, body: init.body });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined, headers: res.headers };
};

/** A request with the path exactly as written: fetch would resolve a `%2e%2e` segment before sending it. */
const raw = (path: string) =>
  new Promise<{ status: number; json: { error: string } }>((resolve, reject) => {
    http
      .get(url + "/__", { path, headers: KEY }, async (res) => resolve({ status: res.statusCode ?? 0, json: JSON.parse(await consumers.text(res)) }))
      .on("error", reject);
  });

test("/health needs no key and lists the routes", async () => {
  const res = await fetch(url + "/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: "anywherellm-bridge", allow: ["GET /scheduled-jobs", "POST /scheduled-jobs/new", "/workspaces"] });
});

test("a preflight needs no key, and every answer lets any origin in", async () => {
  const pre = await fetch(url + "/scheduled-jobs", { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  assert.match(pre.headers.get("access-control-allow-methods") ?? "", /DELETE, OPTIONS/);
  assert.equal((await call("GET", "/scheduled-jobs")).headers.get("access-control-allow-origin"), "*");
  assert.equal((await fetch(url + "/scheduled-jobs")).headers.get("access-control-allow-origin"), "*");
});

test("a request without a key AnythingLLM accepts is a 401", async () => {
  const wrong: Record<string, string>[] = [{}, { Authorization: "Bearer nope" }, { Authorization: "Basic good-key" }, { Authorization: "Bearer " }];
  for (const headers of wrong) {
    const res = await fetch(url + "/scheduled-jobs", { headers });
    assert.equal(res.status, 401, JSON.stringify(headers));
    assert.match(((await res.json()) as { error: string }).error, /developer API key/);
  }
  assert.deepEqual(fake.calls, []);
});

test("a route that is listed passes with its query and body, and the status and JSON come back as they are", async () => {
  fake.replies.set("POST /scheduled-jobs/new?x=1&y=%20", { status: 400, json: { job: null, error: "Invalid cron expression" } });
  const res = await call("POST", "/scheduled-jobs/new?x=1&y=%20", { headers: { "Content-Type": "application/json" }, body: '{"k":1}' });
  assert.deepEqual([res.status, res.json], [400, { job: null, error: "Invalid cron expression" }]);
  assert.deepEqual(fake.calls.map((c) => [c.method, c.url, c.body]), [["POST", "/scheduled-jobs/new?x=1&y=%20", { k: 1 }]]);
  fake.replies.set("GET /workspaces/a%3Fb/memories", { json: { memories: [] } });
  assert.deepEqual((await call("GET", "/workspaces/a%3Fb/memories")).json, { memories: [] });
});

test("a route that is not listed is a 403 and AnythingLLM is not asked", async () => {
  for (const [method, path] of [["GET", "/system/api-keys"], ["POST", "/scheduled-jobs"], ["GET", "/workspaces-old"]]) {
    const res = await call(method, path);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.match(res.json.error, /doesn't pass/);
  }
  assert.deepEqual(fake.calls, []);
});

test("a path that climbs out of its prefix is a 400", async () => {
  for (const path of ["/workspaces/%2e%2e/system/api-keys", "/workspaces/%2E%2E/x", "/workspaces//x", "/workspaces/a%5Cb", "/workspaces/%zz"]) {
    const res = await raw(path);
    assert.equal(res.status, 400, path);
    assert.match(res.json.error, /bad path/);
  }
  assert.deepEqual(fake.calls, []);
});

test("a body that is not JSON is a 400, and a method the bridge doesn't pass a 405", async () => {
  const res = await call("POST", "/scheduled-jobs/new", { body: "{nope" });
  assert.deepEqual([res.status, res.json], [400, { error: "send JSON" }]);
  assert.equal((await call("PATCH", "/workspaces")).status, 405);
  assert.deepEqual(fake.calls, []);
});

test("a reply that isn't JSON passes as null", async () => {
  fake.replies.set("GET /scheduled-jobs", { status: 200, json: undefined });
  assert.equal((await call("GET", "/scheduled-jobs")).json, null);
});

test("AnythingLLM being down is a 502", async () => {
  await fake.stop();
  const res = await call("GET", "/scheduled-jobs").catch(() => null);
  // The key is asked about first; with AnythingLLM gone it can't be, which is the bridge's 502.
  assert.equal(res?.status, 502);
  fake = await new FakeAnythingLLM().start(); // for afterEach
});

test("the bridge logs in with AnythingLLM's password, and again when its token is refused", async () => {
  const envFile = path.join(tmp, ".env");
  fs.writeFileSync(envFile, "AUTH_TOKEN=pw\n");
  await close(bridge);
  await start("GET /scheduled-jobs", envFile);
  assert.equal((await call("GET", "/scheduled-jobs")).status, 200);
  fake.expired.add("tok-1");
  assert.equal((await call("GET", "/scheduled-jobs")).status, 200);
  assert.deepEqual([fake.logins, fake.calls.map((c) => c.token)], [2, ["tok-1", "tok-2"]]);
  fake.password = "changed"; // a refused login is a 502, not a pass
  fake.expired.add("tok-2");
  assert.equal((await call("GET", "/scheduled-jobs")).status, 502);
});

test("a request body over the limit is a 413 before it is read", async () => {
  const res = await call("POST", "/scheduled-jobs/new", { body: "x".repeat(9 * 1024 * 1024) });
  assert.equal(res.status, 413);
  assert.deepEqual(fake.calls, []);
});

test("a client that leaves ends the upstream call, and the bridge goes on serving", async () => {
  fake.hold.add("GET /scheduled-jobs");
  const gone = new AbortController();
  const waiting = fetch(url + "/scheduled-jobs", { headers: KEY, signal: gone.signal }).catch((e: Error) => e);
  await until(() => fake.calls.length);
  gone.abort();
  assert.equal(((await waiting) as Error).name, "AbortError");
  await until(() => fake.dropped.length);
  assert.deepEqual(fake.dropped, ["GET /scheduled-jobs"]);
  await until(() => logged.some((l) => l.includes("client closed")));
  assert.ok(logged.includes("GET /scheduled-jobs client closed"));
  assert.equal((await call("GET", "/workspaces")).status, 200);
});

test("with no routes listed nothing passes", async () => {
  await close(bridge);
  await start("");
  assert.equal((await call("GET", "/scheduled-jobs")).status, 403);
  assert.deepEqual(((await (await fetch(url + "/health")).json()) as { allow: string[] }).allow, []);
});

test("each request is logged by method, path and status, never the query or the key", async () => {
  await call("GET", "/scheduled-jobs?secret=1");
  await call("GET", "/system/api-keys?secret=1");
  assert.deepEqual(logged, ["GET /scheduled-jobs 200", "GET /system/api-keys 403"]);
});
