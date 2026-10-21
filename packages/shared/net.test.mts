import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { recentlyRefused, refusedFile } from "./fence.mts";
import * as net from "./net.mts";

type Route = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

/** A server on 127.0.0.1 answering by path. */
async function serve(routes: Record<string, Route>) {
  const seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const route = routes[(req.url || "").split("?")[0]];
      if (!route) return ((res.statusCode = 404), res.end("no"));
      return route(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, port, seen, close: () => server.close() };
}

type Resolve = NonNullable<net.Send["resolve"]>;

test("a request reaches only public addresses, unless the user lets a host through", async () => {
  const s = await serve({ "/": (req, res) => res.end("hi") });
  await assert.rejects(net.send({ url: `${s.url}/`, allow: [] }), /127\.0\.0\.1:\d+ isn't reached: 127\.0\.0\.1 isn't a public address\. The user can let http:\/\/127\.0\.0\.1:\d+ through on the Vault page, under Allowed addresses, and then ask again\. Don't reach it another way/);
  await assert.rejects(net.send({ url: "http://anythingllm:3001/", allow: [] }), /anythingllm is a name on this machine or its network/);
  await assert.rejects(net.send({ url: "file:///etc/passwd", allow: [] }), /only http and https/);
  const answer = await net.send({ url: `${s.url}/`, allow: ["127.0.0.1"] });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.toString(), "hi");
  s.close();
});

test("a refusal is noted by its origin, newest first, for the Vault page to offer", async (t) => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "net-"));
  const was = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = storage;
  t.after(() => {
    if (was === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = was;
    fs.rmSync(storage, { recursive: true, force: true });
  });
  await assert.rejects(net.send({ url: "http://Muse-VM:8463/x?token=1", allow: [] }), /http:\/\/muse-vm:8463 isn't reached/);
  const sneaky: Resolve = (host, options, callback) => callback(null, [{ address: "10.0.0.5", family: 4 }]);
  await assert.rejects(net.send({ url: "https://inside.example/", allow: [], resolve: sneaky }), /inside\.example resolves to 10\.0\.0\.5/);
  assert.deepEqual(recentlyRefused().map((r) => r.origin), ["https://inside.example", "http://muse-vm:8463"], "refused at the lookup too");
  await assert.rejects(net.send({ url: "http://muse-vm:8463/again", allow: [] }));
  assert.deepEqual(recentlyRefused().map((r) => r.origin), ["http://muse-vm:8463", "https://inside.example"], "once each, the latest first");
  for (let i = 0; i < 12; i++) await assert.rejects(net.send({ url: `http://10.0.0.${i}/`, allow: [] }));
  assert.equal(recentlyRefused().length, 10, "the last 10");
  assert.equal(recentlyRefused(Date.now() + 25 * 60 * 60 * 1000).length, 0, "for a day");
  assert.equal((fs.statSync(refusedFile(storage)).mode & 0o777).toString(8), "600");
});

test("a name is looked up once, every address it has is checked, and the one checked is the one connected to", async () => {
  const s = await serve({ "/": (req, res) => res.end(req.headers.host) });
  const lookups: string[] = [];
  // A public-looking name that resolves inside: refused at the lookup, before any connection.
  const sneaky: Resolve = (host, options, callback) => (lookups.push(host), callback(null, [{ address: "93.184.215.14", family: 4 }, { address: "127.0.0.1", family: 4 }]));
  await assert.rejects(net.send({ url: `http://sneaky.example:${s.port}/`, allow: [], resolve: sneaky }), /sneaky\.example resolves to 127\.0\.0\.1, which isn't a public address/);
  assert.equal(s.seen.length, 0, "nothing was sent");
  // A name the user lets through goes to the address its one lookup gave.
  const pinned: Resolve = (host, options, callback) => (lookups.push(host), callback(null, [{ address: "127.0.0.1", family: 4 }]));
  const answer = await net.send({ url: `http://app.example:${s.port}/`, allow: ["app.example"], resolve: pinned });
  assert.equal(answer.body.toString(), `app.example:${s.port}`, "it reached the checked address, with its own name");
  assert.deepEqual(lookups, ["sneaky.example", "app.example"]);
  s.close();
});

test("a GET follows a redirect, fenced again, with the headers its caller chooses for the next hop", async () => {
  const s = await serve({
    "/from": (req, res) => (res.writeHead(302, { Location: "/to" }), res.end()),
    "/to": (req, res) => res.end(`to ${req.headers["x-key"] || "nothing"}`),
    "/away": (req, res) => (res.writeHead(301, { Location: "http://10.0.0.1/" }), res.end()),
    "/post": (req, res) => (res.writeHead(303, { Location: "/to" }), res.end()),
  });
  const allow = ["127.0.0.1"];
  let followed = await net.send({ url: `${s.url}/from`, headers: { "x-key": "k" }, allow });
  assert.equal(followed.body.toString(), "to k");
  assert.equal(followed.url, `${s.url}/to`);
  followed = await net.send({ url: `${s.url}/from`, headers: { "x-key": "k" }, allow, next: () => ({}) });
  assert.equal(followed.body.toString(), "to nothing", "the caller dropped the header for the next hop");
  const stopped = await net.send({ url: `${s.url}/from`, allow, next: () => null });
  assert.deepEqual([stopped.status, stopped.headers.location], [302, "/to"], "or didn't follow it");
  await assert.rejects(net.send({ url: `${s.url}/away`, allow }), /10\.0\.0\.1 isn't a public address/, "each hop is fenced");
  const posted = await net.send({ method: "POST", url: `${s.url}/post`, body: "{}", allow });
  assert.equal(posted.status, 303, "a POST's redirect isn't followed");
  s.close();
});

test("an answer is decoded, cut at its size limit, and a slow one times out", async () => {
  const s = await serve({
    "/gz": (req, res) => (res.writeHead(200, { "Content-Encoding": "gzip" }), res.end(zlib.gzipSync("unzipped"))),
    "/br": (req, res) => (res.writeHead(200, { "Content-Encoding": "br" }), res.end(zlib.brotliCompressSync("unbrotlied"))),
    "/big": (req, res) => res.end("x".repeat(5000)),
    "/slow": () => {},
    "/echo": (req, res, body) => res.end(`${req.method} ${req.headers["content-length"]} ${body}`),
  });
  const allow = ["127.0.0.1"];
  assert.equal((await net.send({ url: `${s.url}/gz`, allow })).body.toString(), "unzipped");
  assert.equal((await net.send({ url: `${s.url}/br`, allow })).body.toString(), "unbrotlied");
  const big = await net.send({ url: `${s.url}/big`, allow, maxBytes: 1000 });
  assert.deepEqual([big.body.length, big.cut], [1000, true]);
  await assert.rejects(net.send({ url: `${s.url}/slow`, allow, timeout: 200 }), /didn't answer: no answer in 0 s/);
  assert.equal((await net.send({ method: "PUT", url: `${s.url}/echo`, body: "héllo", allow })).body.toString(), "PUT 6 héllo", "the body goes with its length in bytes");
  s.close();
});

test("a request a stopped run was waiting on ends at once, and one it hadn't sent isn't sent", async () => {
  const s = await serve({ "/slow": () => {} });
  const allow = ["127.0.0.1"];
  const stop = new AbortController();
  const waiting = net.send({ url: `${s.url}/slow`, allow, signal: stop.signal });
  setTimeout(() => stop.abort(), 50);
  const started = Date.now();
  await assert.rejects(waiting, /didn't answer: the run stopped/);
  assert.ok(Date.now() - started < 1000, "it didn't wait for the 30 s timeout");
  await assert.rejects(net.send({ url: `${s.url}/slow`, allow, signal: stop.signal }), /wasn't asked: the run stopped/);
  assert.equal(s.seen.length, 1, "only the first request reached the server");
  s.close();
});

test("requests to the same host reuse a kept connection, opened through the fence", async () => {
  const s = await serve({ "/": (req, res) => res.end(String(req.socket.remotePort)) });
  const allow = ["127.0.0.1"];
  const first = (await net.send({ url: `${s.url}/`, allow })).body.toString();
  const second = (await net.send({ url: `${s.url}/`, allow })).body.toString();
  assert.equal(second, first, "the second request came from the same connection");
  const other = (await net.send({ url: `${s.url}/`, allow: ["127.0.0.1", "nas.lan"] })).body.toString();
  assert.notEqual(other, first, "another allow-list has connections of its own");
  s.close();
});

test("a request never reaches the skills' pages or AnythingLLM's upload for them, even to a host let through, nor by a redirect", async () => {
  const s = await serve({ "/": (req, res) => res.end("hi"), "/go": (req, res) => ((res.statusCode = 302), res.setHeader("location", "/Library-Lean/t.html"), res.end()) });
  for (const p of ["/library-lean/t.html", "/API/browser-extension/upload-content", "//vault-lean/t.html"]) {
    const e = await net.send({ url: `${s.url}${p}`, allow: ["127.0.0.1"] }).catch((err) => err);
    assert.match(e.message, /isn't reached: that's one of the skills' own pages/, p);
    assert.doesNotMatch(e.message, /Allowed addresses/, "nothing to let through");
  }
  await assert.rejects(net.send({ url: `${s.url}/go`, allow: ["127.0.0.1"] }), /one of the skills' own pages/);
  assert.equal((await net.send({ url: `${s.url}/`, allow: ["127.0.0.1"] })).body.toString(), "hi");
  assert.deepEqual(s.seen.map((r) => r.url), ["/go", "/"], "nothing was sent to a page");
  s.close();
});

test("a TCP connection for another protocol is fenced as a request is: refused inside, checked at its lookup, stoppable", async () => {
  const server = (await import("node:net")).createServer((sock) => sock.end("hello\n"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await assert.rejects(net.connect({ host: "127.0.0.1", port, allow: [] }), /127\.0\.0\.1:\d+ isn't reached: 127\.0\.0\.1 isn't a public address\. Don't reach it another way/);
  await assert.rejects(net.connect({ host: "pi", port, allow: [] }), /pi is a name on this machine or its network/);
  const inside: Resolve = (host, options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]);
  await assert.rejects(net.connect({ host: "box.example", port, allow: [], resolve: inside }), /box\.example resolves to 127\.0\.0\.1/);
  const sock = await net.connect({ host: "box.example", port, allow: ["box.example"], resolve: inside });
  const said = await new Promise<string>((resolve) => sock.once("data", (d) => resolve(String(d))));
  assert.equal(said, "hello\n", "a name let through goes to the address its lookup gave");
  sock.destroy();
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(net.connect({ host: "127.0.0.1", port, allow: ["127.0.0.1"], signal: stop.signal }), /the run stopped/);
  await assert.rejects(net.connect({ host: "127.0.0.1", port: 1, allow: ["127.0.0.1"] }), (e: Error) => e.name === "Unreachable");
  server.close();
});

test("a connection can be refused by address whatever its host is let through for, at connect time", async () => {
  const server = (await import("node:net")).createServer((sock) => sock.end("hello\n"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const itself = (ip: string) => (ip === "127.0.0.1" ? "that's the machine itself" : null);
  const answers: Resolve = (host, options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]);
  await assert.rejects(net.connect({ host: "127.0.0.1", port, allow: ["127.0.0.1"], refuse: itself }), /127\.0\.0\.1:\d+ isn't reached: that's the machine itself/);
  await assert.rejects(net.connect({ host: "box.example", port, allow: ["box.example"], resolve: answers, refuse: itself }), /box\.example:\d+ isn't reached: that's the machine itself/);
  const sock = await net.connect({ host: "box.example", port, allow: ["box.example"], resolve: answers });
  assert.equal(await new Promise<string>((resolve) => sock.once("data", (d) => resolve(String(d)))), "hello\n", "without the refusal it connects");
  sock.destroy();
  server.close();
});
