import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { notify } from "./notify.mts";

/** A server on 127.0.0.1 answering `status` to every request, and what it was sent. */
async function serve(status = 200) {
  const seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.statusCode = status;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mine`, seen, close: () => server.close() };
}

test("posts the body to the topic with its title, click address and token", async () => {
  const s = await serve();
  try {
    await notify({ NTFY_URL: ` ${s.url} `, NTFY_TOKEN: "tk_1" }, { title: "clock.slow: ok", body: '{"slept":2}', click: "https://llm.example.com/workspace/work" });
    assert.equal(s.seen.length, 1);
    const [r] = s.seen;
    assert.deepEqual([r.method, r.url, r.body], ["POST", "/mine", '{"slept":2}']);
    assert.deepEqual([r.headers.title, r.headers.click, r.headers.authorization], ["clock.slow: ok", "https://llm.example.com/workspace/work", "Bearer tk_1"]);
  } finally {
    s.close();
  }
});

test("sends no click or token header when it has none, and encodes a title that isn't ASCII", async () => {
  const s = await serve();
  try {
    await notify({ NTFY_URL: s.url }, { title: "café.fait: ok", body: "x" });
    const [r] = s.seen;
    assert.equal(r.headers.click, undefined);
    assert.equal(r.headers.authorization, undefined);
    assert.equal(r.headers.title, `=?UTF-8?B?${Buffer.from("café.fait: ok").toString("base64")}?=`);
  } finally {
    s.close();
  }
});

test("does nothing without an http(s) NTFY_URL, and throws when the server refuses", async () => {
  const s = await serve(401);
  try {
    await notify(undefined, { title: "t", body: "b" });
    await notify({ NTFY_URL: "" }, { title: "t", body: "b" });
    await notify({ NTFY_URL: "ntfy.example.com/x" }, { title: "t", body: "b" });
    assert.equal(s.seen.length, 0);
    await assert.rejects(notify({ NTFY_URL: s.url }, { title: "t", body: "b" }), /ntfy answered 401/);
  } finally {
    s.close();
  }
});
