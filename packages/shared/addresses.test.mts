// The Vault's Allowed addresses section: what it lets through and refuses, allowed.json as the fence
// reads it, and the page against what the section applies and writes.
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { alwaysAllowed, allowedFile } from "./fence.mts";
import { THISHOST_RECORD } from "./thishost.mts";
import { bundled } from "./test-helpers.mts";

// addresses.mts reaches the Vault page, which imports its page as text, which only the skills' build
// (esbuild) understands: the test bundles it the same way and loads that.
const addresses = await bundled<typeof import("./addresses.mts")>(new URL("./addresses.mts", import.meta.url));

const g = globalThis as unknown as Record<symbol, unknown>;
let storage: string;
let was: string | undefined;
beforeEach(() => {
  was = process.env.STORAGE_DIR;
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "addresses-"));
  process.env.STORAGE_DIR = storage;
  g[THISHOST_RECORD] = { fingerprints: [], addresses: ["192.168.1.10", "100.90.1.2"], hostname: "gir" };
});
afterEach(() => {
  if (was === undefined) delete process.env.STORAGE_DIR;
  else process.env.STORAGE_DIR = was;
  delete g[THISHOST_RECORD];
  fs.rmSync(storage, { recursive: true, force: true });
});

/** A lookup that knows a few names, and passes an address as it is. */
const NAMES: Record<string, string[]> = { localhost: ["127.0.0.1", "::1"], "muse-vm": ["100.101.102.103"], "gir": ["100.90.1.2"], "nas.example": ["192.168.1.5"], "llm.example": ["93.184.216.34"], "public.example": ["93.184.216.34"] };
const lookup = async (host: string) => (/^[\d.]+$|:/.test(host) ? [host] : (NAMES[host] ?? null));
const why = (origin: string, base: string | null = null) => addresses.refusalOf(origin, base, lookup);

test("an origin on this machine's network is let through, a public one isn't", async () => {
  for (const ok of ["http://muse-vm:8463", "http://192.168.1.5", "https://nas.example:5001", "http://[fd00::5]:8080", "http://192.168.1.20:8463"]) assert.equal(await why(ok), null, ok);
  assert.match((await why("http://93.184.216.34"))!, /on the public web/);
  assert.match((await why("https://public.example"))!, /on the public web/, "by what the name resolves to");
  assert.match((await why("http://nowhere.lan:80"))!, /nowhere\.lan can't be looked up from AnythingLLM/, "what can't be told is refused");
});

test("no loopback address, on any port: AnythingLLM's own machine or container", async () => {
  for (const origin of ["http://localhost:8888", "http://127.0.0.2:80", "http://[::1]:5000", "http://[::ffff:127.0.0.1]:8080", "http://127.0.0.1:3001", "http://loop.example:9000"]) assert.match((await addresses.refusalOf(origin, null, async (h) => (h === "loop.example" ? ["10.0.0.9", "127.0.0.1"] : lookup(h))))!, /that's a loopback address, AnythingLLM's own machine or container/, origin);
});

test("none of the suite's own services: this machine's addresses on 3001, 443 and 8467, and AnythingLLM's own address", async () => {
  for (const origin of ["http://192.168.1.10:3001", "https://gir", "http://100.90.1.2:8467", "http://[::ffff:100.90.1.2]:8467"]) assert.match((await why(origin))!, /of this machine, where AnythingLLM, its bridge or a proxy/, origin);
  assert.equal(await why("http://192.168.1.10:9000"), null, "another port of this machine is the user's");
  assert.match((await why("http://192.168.1.10:9000", "http://192.168.1.10:9000"))!, /that's AnythingLLM itself/);
  assert.match((await why("http://gir:8080", "https://llm.example:8080"))!, /of this machine/, "AnythingLLM's own port, at this machine's addresses");
  assert.equal(await why("http://192.168.7.8:8080", "http://192.168.7.7:8080"), null, "another machine on AnythingLLM's port");
});

test("without the installer's record, AnythingLLM's address and the interfaces decide; without either, nothing is let through", async () => {
  delete g[THISHOST_RECORD];
  assert.match((await why("http://muse-vm:8463"))!, /this machine isn't recorded and AnythingLLM's address isn't set/);
  assert.equal(await why("http://muse-vm:8463", "http://192.168.1.10:3001"), null);
  assert.match((await why("http://192.168.1.10:443", "http://192.168.1.10:3001"))!, /of this machine/, "AnythingLLM's host");
  assert.match((await why("http://muse-vm:8463", "https://unknown.example"))!, /can't be looked up and this machine isn't recorded/);
});

test("allow and remove change allowed.json in its shape, once each, as the fence reads it", async () => {
  assert.equal(await addresses.allow("HTTP://Muse-VM:8463/some/path", lookup), "http://muse-vm:8463");
  await addresses.allow("http://muse-vm:8463", lookup);
  const held = JSON.parse(fs.readFileSync(allowedFile(storage), "utf8"));
  assert.deepEqual(held.origins.map((o: { origin: string }) => o.origin), ["http://muse-vm:8463"]);
  assert.ok(!Number.isNaN(Date.parse(held.origins[0].added)));
  assert.equal((fs.statSync(allowedFile(storage)).mode & 0o777).toString(8), "600");
  assert.deepEqual(alwaysAllowed(), ["http://muse-vm:8463"]);
  await assert.rejects(addresses.allow("muse-vm:8463", lookup), /isn't an address: write its scheme, host and port/);
  await assert.rejects(addresses.allow("http://93.184.216.34", lookup), /http:\/\/93\.184\.216\.34 isn't let through: it's on the public web/);
  await addresses.remove("http://muse-vm:8463/");
  assert.deepEqual(alwaysAllowed(), []);
  fs.writeFileSync(allowedFile(storage), "not json");
  await assert.rejects(addresses.allow("http://muse-vm:8463", lookup), "a file that can't be read isn't written over");
  assert.equal(fs.readFileSync(allowedFile(storage), "utf8"), "not json");
});

test("the page posts only what the section applies, and reads only what it writes", () => {
  const vault = fs.readFileSync(fileURLToPath(new URL("./vault.html", import.meta.url)), "utf8");
  const source = fs.readFileSync(fileURLToPath(new URL("./addresses.mts", import.meta.url)), "utf8");
  const posted = [...vault.matchAll(/post\("addresses", "([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(posted)].sort(), ["address-allow", "address-remove"]);
  for (const ev of [...posted, "rotate"]) assert.ok(source.includes(`e.ev === "${ev}"`), ev);
  fs.mkdirSync(path.dirname(allowedFile(storage)), { recursive: true });
  fs.writeFileSync(allowedFile(storage), JSON.stringify({ origins: [{ origin: "http://muse-vm:8463", added: new Date().toISOString() }] }));
  fs.writeFileSync(path.join(storage, "fence-lean", "refused.json"), JSON.stringify({ refused: [{ origin: "http://nas.lan", at: new Date().toISOString() }, { origin: "http://muse-vm:8463", at: new Date().toISOString() }] }));
  const state = addresses.state();
  assert.deepEqual(state.refused.map((r) => r.origin), ["http://nas.lan"], "an origin let through since isn't offered");
  const items = { as: state, a: state.origins[0], r: state.refused[0] };
  const script = vault.slice(vault.lastIndexOf("<script")); // the page's code; its styles have selectors like a.hu-tile
  for (const [name, item] of Object.entries(items)) for (const [, field] of script.matchAll(new RegExp(`\\b${name}\\.([a-z_]+)`, "g"))) assert.ok(field in item, `${name}.${field}`);
});
