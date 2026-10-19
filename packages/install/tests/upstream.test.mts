import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { readEnv } from "../src/envfile.mts";
import { Upstream, type Password } from "#shared/upstream";
import { FakeAnythingLLM } from "./fakes/anythingllm.mts";
import { tempDir } from "./fakes/tmp.mts";

const tmp = tempDir("upstream");

let fake: FakeAnythingLLM;
beforeEach(async () => {
  fake = await new FakeAnythingLLM().start();
});
afterEach(() => fake.stop());

/** The password in an .env file, as AUTH_TOKEN. */
const passwordIn = (envFile: string): Password => ({ read: () => readEnv(envFile).AUTH_TOKEN || "", where: `the password in ${envFile}` });

/** An AnythingLLM .env holding `password` (none when empty). */
let envs = 0;
function envWith(password: string): string {
  const file = path.join(tmp, `env-${++envs}`);
  fs.writeFileSync(file, password ? `AUTH_TOKEN='${password}'\nJWT_SECRET=x\n` : "JWT_SECRET=x\n");
  return file;
}

const refuses = (promise: Promise<unknown>, status: number, message: RegExp) => assert.rejects(promise, { status, message });

test("it logs in once and sends the token", async () => {
  const api = new Upstream(fake.url + "/", passwordIn(envWith("pw")));
  assert.deepEqual(await api.exchange("GET", "/scheduled-jobs"), { status: 200, json: { ok: true } });
  await api.exchange("GET", "/scheduled-jobs");
  assert.equal(fake.logins, 1);
  assert.deepEqual(fake.calls.map((c) => [c.url, c.token]), [["/scheduled-jobs", "tok-1"], ["/scheduled-jobs", "tok-1"]]);
});

test("calls made at once share one login", async () => {
  const api = new Upstream(fake.url, passwordIn(envWith("pw")));
  await Promise.all([api.exchange("GET", "/a"), api.exchange("GET", "/b"), api.exchange("GET", "/c")]);
  assert.equal(fake.logins, 1);
});

test("a 401 logs in again once", async () => {
  const api = new Upstream(fake.url, passwordIn(envWith("pw")));
  await api.exchange("GET", "/x");
  fake.expired.add("tok-1");
  assert.equal((await api.exchange("GET", "/x")).status, 200);
  assert.equal(fake.logins, 2);
  fake.expired.add("tok-2").add("tok-3");
  await refuses(api.exchange("GET", "/x"), 502, /refused the login \(the password in /);
});

test("calls that are all refused at once share one new login", async () => {
  const api = new Upstream(fake.url, passwordIn(envWith("pw")));
  await api.exchange("GET", "/x");
  fake.expired.add("tok-1");
  await Promise.all([api.exchange("GET", "/a"), api.exchange("GET", "/b"), api.exchange("GET", "/c")]);
  assert.equal(fake.logins, 2);
});

test("without a password no token is sent, and a 401 is the route's own", async () => {
  await new Upstream(fake.url, passwordIn(envWith(""))).exchange("GET", "/x");
  await new Upstream(fake.url, null).exchange("GET", "/x");
  assert.deepEqual(fake.calls.map((c) => c.token), ["", ""]);
  assert.equal(fake.logins, 0);
  fake.expired.add("");
  assert.equal((await new Upstream(fake.url, null).exchange("GET", "/x")).status, 401);
});

test("the status and body come back whatever they are", async () => {
  fake.replies.set("POST /scheduled-jobs/new", { status: 400, json: { job: null, error: "Invalid cron expression" } });
  const reply = await new Upstream(fake.url, null).exchange("POST", "/scheduled-jobs/new", { a: 1 });
  assert.deepEqual(reply, { status: 400, json: { job: null, error: "Invalid cron expression" } });
  assert.deepEqual(fake.calls[0].body, { a: 1 });
});

test("a wrong password is said, and a changed one is read at the next login", async () => {
  const file = envWith("nope");
  const api = new Upstream(fake.url, passwordIn(file));
  await refuses(api.exchange("GET", "/x"), 502, /Invalid password/);
  fs.writeFileSync(file, "AUTH_TOKEN=pw\n");
  assert.equal((await api.exchange("GET", "/x")).status, 200); // a failed login is tried again
});

test("an AnythingLLM that isn't there is a 502", async () => {
  const api = new Upstream("http://127.0.0.1:1", null);
  await refuses(api.exchange("GET", "/x"), 502, /can't be reached/);
});
