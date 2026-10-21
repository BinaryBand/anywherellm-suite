import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { NetError, allowedFile, allowedFor, allowedHosts, alwaysAllowed, checkUrl, makeFence, onSite, originOf, pathRefused, privateAddress, privateName, secureFor, siteOf } from "./fence.mts";

test("addresses outside the public internet are private", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.10", "169.254.169.254", "100.64.0.1", "100.101.102.103", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fd7a:115c:a1e0::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:192.168.0.1", "ff02::1"]) {
    assert.ok(privateAddress(ip), ip);
  }
  for (const ip of ["93.184.215.14", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.ok(!privateAddress(ip), ip);
  }
  assert.ok(privateAddress("not an ip"));
});

test("names of this machine or its network are private by name", () => {
  for (const name of ["localhost", "anythingllm", "host.containers.internal", "printer.local", "nas.lan", "box.home.arpa", "me.tail1234.ts.net", "api.localhost"]) {
    assert.ok(privateName(name), name);
  }
  for (const name of ["example.com", "news.ycombinator.com", "localhost.example.com"]) {
    assert.ok(!privateName(name), name);
  }
});

test("an address is http(s), with https:// put before a bare host", () => {
  assert.equal(checkUrl("example.com"), "https://example.com/");
  assert.equal(checkUrl(" http://example.com/a?b=1 "), "http://example.com/a?b=1");
  assert.throws(() => checkUrl(""), NetError);
  assert.throws(() => checkUrl("file:///etc/passwd"), /only http and https/);
  assert.throws(() => checkUrl("javascript://alert(1)"), /only http and https/);
});

test("the fence refuses a host that resolves to a private address, and keeps lookups a minute", async () => {
  let lookups = 0;
  let clock = 0;
  const table: Record<string, string[]> = { "public.example": ["93.184.215.14"], "sneaky.example": ["93.184.215.14", "192.168.1.1"] };
  const refused = makeFence({ lookup: async (host) => (lookups++, (table[host] || []).map((address) => ({ address }))), now: () => clock });
  assert.equal(await refused("https://public.example/a"), null);
  assert.match((await refused("https://sneaky.example/"))!, /resolves to 192\.168\.1\.1/);
  assert.match((await refused("http://127.0.0.1:3001/api"))!, /isn't a public address/);
  assert.match((await refused("http://[::1]/"))!, /isn't a public address/);
  assert.match((await refused("http://anythingllm:3001/"))!, /on this machine or its network/);
  assert.equal(await refused("data:text/html,hi"), null);
  assert.match((await refused("file:///etc/passwd"))!, /file: addresses/);
  assert.match((await refused("ws://example.com/"))!, /ws: addresses/);
  await refused("https://public.example/b");
  assert.equal(lookups, 2, "public.example was looked up once");
  clock += 61 * 1000;
  await refused("https://public.example/c");
  assert.equal(lookups, 3, "and again after a minute");
});

test("a name that doesn't resolve is left to the request's own lookup, which fails it", async () => {
  const refused = makeFence({ lookup: async () => Promise.reject(new Error("ENOTFOUND")) });
  assert.equal(await refused("https://nowhere.example/"), null);
});

test("hosts the user lets through in FENCE_ALLOW pass the fence", async () => {
  assert.deepEqual(allowedHosts({ FENCE_ALLOW: " NAS.lan, 127.0.0.1 ,," }), ["nas.lan", "127.0.0.1"]);
  assert.deepEqual(allowedHosts({}), []);
  const refused = makeFence({ allow: () => new Set(["nas.lan", "127.0.0.1"]), lookup: async () => [{ address: "192.168.1.5" }] });
  assert.equal(await refused("http://NAS.lan:5000/"), null);
  assert.equal(await refused("http://127.0.0.1:8080/"), null);
  assert.match((await refused("http://127.0.0.2/"))!, /isn't a public address/);
});

test("origins the user let through on the Vault page pass too, on their own port only, read again when they change", async (t) => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "fence-"));
  const was = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = storage;
  t.after(() => ((process.env.STORAGE_DIR = was), fs.rmSync(storage, { recursive: true, force: true })));
  const file = allowedFile(storage);
  const write = (hosts: unknown, at: number) => (fs.mkdirSync(path.dirname(file), { recursive: true }), fs.writeFileSync(file, JSON.stringify(hosts)), fs.utimesSync(file, at, at));
  assert.deepEqual(alwaysAllowed(), [], "no file: nothing more");
  write({ origins: [{ origin: "http://Muse-VM:8463", added: "2026-10-20T00:00:00Z" }, { origin: "not an origin" }] }, 1000);
  assert.deepEqual(alwaysAllowed(), ["http://muse-vm:8463"]);
  assert.deepEqual(allowedHosts({}), [], "FENCE_ALLOW's hosts are its own");
  const refused = makeFence({ lookup: async () => [{ address: "100.101.102.103" }] });
  assert.equal(await refused("http://muse-vm:8463/v1/health"), null, "the browser's fence reads it for each request");
  assert.match((await refused("http://muse-vm:3001/"))!, /on this machine or its network/, "another port on the same host is still refused");
  assert.match((await refused("https://muse-vm:8463/"))!, /on this machine or its network/, "another scheme is still refused");
  assert.deepEqual([...allowedFor("http://muse-vm:8463")], ["muse-vm"]);
  assert.deepEqual([...allowedFor("http://muse-vm:3001")], []);
  assert.ok(secureFor(new URL("http://muse-vm:8463/publish")), "a key may go over plain http to an origin let through");
  assert.ok(!secureFor(new URL("http://muse-vm:3001/")), "not to another port of it");
  write({ origins: [] }, 3000);
  assert.match((await refused("http://muse-vm:8463/"))!, /on this machine or its network/);
  write("not a list", 4000);
  assert.deepEqual(alwaysAllowed(), [], "a file that can't be read lets nothing more through");
});

test("an origin is an http(s) address's scheme, host and port", () => {
  assert.equal(originOf("HTTPS://Example.com:443/path?q=1"), "https://example.com");
  assert.equal(originOf("http://[::1]:8080/"), "http://[::1]:8080");
  assert.equal(originOf("ftp://example.com/"), null);
  assert.equal(originOf("muse-vm:8463"), null);
});

test("a site as a person writes it is a host, and its subdomains are on it", () => {
  assert.equal(siteOf("https://GitHub.com/login"), "github.com");
  assert.equal(siteOf("api.example.com:8443"), "api.example.com");
  assert.ok(onSite("api.github.com", "github.com"));
  assert.ok(onSite("github.com", "https://github.com/"));
  assert.ok(!onSite("evilgithub.com", "github.com"));
  assert.ok(!onSite("", "github.com"));
});

test("the skills' own pages and AnythingLLM's upload for them are never reached, on any host, however written", async () => {
  const never = ["/vault-lean/abc.html", "/library-lean/abc.json", "/browser-lean/x", "/apps-lean/t.html", "/api/browser-extension/upload-content", "/API/Browser-Extension/upload-content", "//vault-lean//abc.html", "/%76ault-lean/abc.html", "/library-lean%2Fabc.html", "/vault-lean"];
  for (const p of never) assert.match(pathRefused(new URL(`https://ai.example.com${p}`)) ?? "", /never reaches: the user acts on them/, p);
  for (const p of ["/", "/api/v1/workspaces", "/vault-leaner/x", "/docs/library-lean/x", "/api/browser-extensions"]) assert.equal(pathRefused(new URL(`https://ai.example.com${p}`)), null, p);
  const refused = makeFence({ allow: () => new Set(["127.0.0.1"]), lookup: async () => [{ address: "93.184.216.34" }] });
  assert.match((await refused("http://127.0.0.1:3001/library-lean/t.html"))!, /never reaches/, "even let through");
  assert.match((await refused("https://ai.example.com/api/browser-extension/upload-content"))!, /never reaches/, "even public");
  assert.equal(await refused("https://ai.example.com/"), null);
});
