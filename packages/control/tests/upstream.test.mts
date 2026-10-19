import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import consumers from "node:stream/consumers";
import { afterEach, beforeEach, test } from "node:test";
import { Upstream } from "../src/upstream.mts";

/** AnythingLLM's login (`POST /api/request-token`: `pw` gets tok-1, tok-2, ...) in front of routes
 *  that answer 200 {"ok": true}, or what `replies` says, and 401 to a token in `expired`. */
class FakeLogin {
  expired = new Set<string>();
  /** Replies by `METHOD /path` (under /api). */
  replies = new Map<string, { status: number; json: unknown }>();
  calls: { url: string; body: unknown; token: string }[] = [];
  logins = 0;
  url = "";
  readonly #server = http.createServer(async (req, res) => {
    const raw = await consumers.text(req);
    const body = raw ? JSON.parse(raw) : null;
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const reply = (status: number, json?: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };
    if (req.url === "/api/request-token") {
      if (body?.password !== "pw") return reply(200, { valid: false, token: null, message: "[003] Invalid password" });
      return reply(200, { valid: true, token: `tok-${++this.logins}` });
    }
    if (this.expired.has(token)) return reply(401);
    const url = (req.url ?? "").replace(/^\/api/, "");
    this.calls.push({ url, body, token });
    const found = this.replies.get(`${req.method} ${url}`);
    reply(found?.status ?? 200, found ? found.json : { ok: true });
  });

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
}

let fake: FakeLogin;
beforeEach(async () => {
  fake = await new FakeLogin().start();
});
afterEach(() => fake.stop());

const WHERE = "the test's password";

test("it logs in once and sends the token", async () => {
  const api = new Upstream(fake.url + "/", "pw", WHERE);
  assert.deepEqual(await api.exchange("GET", "/scheduled-jobs"), { status: 200, json: { ok: true } });
  await api.exchange("GET", "/scheduled-jobs");
  assert.equal(fake.logins, 1);
  assert.deepEqual(fake.calls.map((c) => [c.url, c.token]), [["/scheduled-jobs", "tok-1"], ["/scheduled-jobs", "tok-1"]]);
});

test("calls made at once share one login", async () => {
  const api = new Upstream(fake.url, "pw", WHERE);
  await Promise.all([api.exchange("GET", "/a"), api.exchange("GET", "/b"), api.exchange("GET", "/c")]);
  assert.equal(fake.logins, 1);
});

test("a 401 logs in again once", async () => {
  const api = new Upstream(fake.url, "pw", WHERE);
  await api.exchange("GET", "/x");
  fake.expired.add("tok-1");
  assert.equal((await api.exchange("GET", "/x")).status, 200);
  assert.equal(fake.logins, 2);
  fake.expired.add("tok-2").add("tok-3");
  await assert.rejects(api.exchange("GET", "/x"), { message: /refused the login \(the test's password\)/ });
});

test("calls that are all refused at once share one new login", async () => {
  const api = new Upstream(fake.url, "pw", WHERE);
  await api.exchange("GET", "/x");
  fake.expired.add("tok-1");
  await Promise.all([api.exchange("GET", "/a"), api.exchange("GET", "/b"), api.exchange("GET", "/c")]);
  assert.equal(fake.logins, 2);
});

test("without a password no token is sent, and a 401 is the route's own", async () => {
  await new Upstream(fake.url, "", WHERE).exchange("GET", "/x");
  assert.deepEqual(fake.calls.map((c) => c.token), [""]);
  assert.equal(fake.logins, 0);
  fake.expired.add("");
  assert.equal((await new Upstream(fake.url, "", WHERE).exchange("GET", "/x")).status, 401);
});

test("the status and body come back whatever they are", async () => {
  fake.replies.set("POST /scheduled-jobs/new", { status: 400, json: { job: null, error: "Invalid cron expression" } });
  const reply = await new Upstream(fake.url, "", WHERE).exchange("POST", "/scheduled-jobs/new", { a: 1 });
  assert.deepEqual(reply, { status: 400, json: { job: null, error: "Invalid cron expression" } });
  assert.deepEqual(fake.calls[0].body, { a: 1 });
});

test("a wrong password is said, and the login is tried again at the next call", async () => {
  const api = new Upstream(fake.url, "nope", WHERE);
  await assert.rejects(api.exchange("GET", "/x"), { message: /refused the login with the test's password: \[003\] Invalid password/ });
  await assert.rejects(api.exchange("GET", "/x"), { message: /Invalid password/ });
  assert.equal(fake.calls.length, 0);
});

test("an AnythingLLM that isn't there is said so", async () => {
  await assert.rejects(new Upstream("http://127.0.0.1:1", "", WHERE).exchange("GET", "/x"), { message: /can't be reached/ });
});
