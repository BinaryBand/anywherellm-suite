import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { notify } from "./notify.mts";

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
  await notify({ url, token: "tk_1" }, { title: "clock.slow: ok", body: '{"slept":2}', click: "https://llm.example.com/workspace/work" });
  assert.equal(seen.length, 1);
  const [r] = seen;
  assert.deepEqual([r.method, r.url, r.body], ["POST", "/mine", '{"slept":2}']);
  assert.deepEqual([r.headers.title, r.headers.click, r.headers.authorization], ["clock.slow: ok", "https://llm.example.com/workspace/work", "Bearer tk_1"]);
});

test("sends no click or token header when it has none, and encodes a title that isn't ASCII", async () => {
  await notify({ url, token: "" }, { title: "café.fait: ok", body: "x" });
  const [r] = seen;
  assert.equal(r.headers.click, undefined);
  assert.equal(r.headers.authorization, undefined);
  assert.equal(r.headers.title, `=?UTF-8?B?${Buffer.from("café.fait: ok").toString("base64")}?=`);
});

test("does nothing without an http(s) address, and throws when the server refuses", async () => {
  await notify({ url: "", token: "" }, { title: "t", body: "b" });
  await notify({ url: "ntfy.example.com/x", token: "" }, { title: "t", body: "b" });
  assert.equal(seen.length, 0);
  status = 401;
  await assert.rejects(notify({ url, token: "" }, { title: "t", body: "b" }), /ntfy answered 401/);
});
