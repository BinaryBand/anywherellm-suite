import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { notify, topicUrl } from "./notify.mts";

/** What the server on 127.0.0.1 was sent, and the status it answers with. */
const seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let status = 200;
let url = "";
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.statusCode = status;
    res.end("{}");
  });
});
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mine`;
});
after(() => server.close());
beforeEach(() => {
  seen.length = 0;
  status = 200;
});

test("posts the body to the topic with its title, click address and token", async () => {
  await notify({ url, token: "tk_1" }, { title: "Library: a background run ended", body: '{"slept":2}', click: "https://llm.example.com/workspace/work" });
  assert.equal(seen.length, 1);
  const [r] = seen;
  assert.deepEqual([r.method, r.url, r.body], ["POST", "/mine", '{"slept":2}']);
  assert.deepEqual([r.headers.title, r.headers.click, r.headers.authorization], ["Library: a background run ended", "https://llm.example.com/workspace/work", "Bearer tk_1"]);
});

test("sends no click or token header when it has none", async () => {
  await notify({ url, token: "" }, { title: "t", body: "x" });
  const [r] = seen;
  assert.equal(r.headers.click, undefined);
  assert.equal(r.headers.authorization, undefined);
});

test("a topic address is taken as typed: https when it has no scheme, no trailing slash", () => {
  assert.equal(topicUrl(" ntfy.sh/mine/ "), "https://ntfy.sh/mine");
  assert.equal(topicUrl("http://10.0.0.5:8080/mine//"), "http://10.0.0.5:8080/mine");
  assert.equal(topicUrl(""), "");
  assert.equal(topicUrl("ftp://ntfy.example.com/x"), "", "not an http(s) address: unusable");
});

test("does nothing without an address, and throws when the server refuses", async () => {
  await notify({ url: "", token: "" }, { title: "t", body: "b" });
  assert.equal(seen.length, 0);
  status = 401;
  await assert.rejects(notify({ url, token: "" }, { title: "t", body: "b" }), /ntfy answered 401/);
});

test("what it says of a failure never holds the token or a password in the address", async () => {
  const fails = (ntfy: { url: string; token: string }) => assert.rejects(notify(ntfy, { title: "t", body: "b" }), (e: Error) => /^ntfy wasn't reached \(\w+\)$/.test(e.message));
  await fails({ url, token: "tk_abc\r\nX: y" });
  await fails({ url: "http://alice:hunter2@127.0.0.1:9/mine", token: "" });
});
