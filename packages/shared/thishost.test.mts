import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { SUITE_DIR } from "./anythingllm.mts";
import {
  canonicalHost,
  THISHOST_EXCEPT,
  THISHOST_RECORD,
  thisHostFile,
  thisHostFingerprints,
  thisHostKeyRefusal,
  thisHostRecorded,
  thisHostRefusal,
  thisHostUsable,
  type ThisHost,
} from "./thishost.mts";

const g = globalThis as unknown as Record<symbol, unknown>;
let storage: string;
let was: string | undefined;

beforeEach(() => {
  was = process.env.STORAGE_DIR;
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "thishost-"));
  process.env.STORAGE_DIR = storage;
});
afterEach(() => {
  if (was === undefined) delete process.env.STORAGE_DIR;
  else process.env.STORAGE_DIR = was;
  delete g[THISHOST_RECORD];
  delete g[THISHOST_EXCEPT];
  fs.rmSync(storage, { recursive: true, force: true });
});

const record = (more: Partial<ThisHost> = {}): ThisHost => ({ fingerprints: ["SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], addresses: ["100.90.1.2", "fd7a:115c:a1e0::1:2"], hostname: "gir", ...more });
const write = (text: string) => {
  fs.mkdirSync(path.dirname(thisHostFile()), { recursive: true });
  fs.writeFileSync(thisHostFile(), text);
};

test("this machine's own addresses are refused: loopback, link-local, unspecified and every interface's", () => {
  for (const ip of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1", "0.0.0.0", "::", "169.254.169.254", "fe80::1", "fe80::1%eth0"]) assert.match(thisHostRefusal(ip) ?? "", /address of this machine itself/, ip);
  const own = Object.values(os.networkInterfaces()).flatMap((list) => (list ?? []).map((a) => a.address));
  assert.ok(own.length > 0);
  for (const ip of own) assert.match(thisHostRefusal(ip) ?? "", /address of this machine itself/, ip);
  // The same address mapped into IPv6.
  for (const a of Object.values(os.networkInterfaces()).flatMap((list) => list ?? [])) if (a.family === "IPv4") assert.ok(thisHostRefusal(`::ffff:${a.address}`), a.address);
});

test("other machines' addresses are not, nor is what isn't an address", () => {
  const own = new Set(Object.values(os.networkInterfaces()).flatMap((list) => (list ?? []).map((a) => a.address)));
  for (const ip of ["8.8.8.8", "192.0.2.5", "198.51.100.7", "2001:db8::1", "box.example", ""]) if (!own.has(ip)) assert.equal(thisHostRefusal(ip), null, ip);
});

test("the test seam lets named addresses through, and only those", () => {
  g[THISHOST_EXCEPT] = new Set(["127.0.0.1"]);
  assert.equal(thisHostRefusal("127.0.0.1"), null);
  assert.ok(thisHostRefusal("127.0.0.2"));
});

test("an address the installer recorded from the host is refused though no interface here has it", () => {
  assert.equal(thisHostRefusal("100.90.1.2"), null, "not recorded, not on an interface here");
  write(JSON.stringify(record()));
  assert.match(thisHostRefusal("100.90.1.2") ?? "", /address of this machine itself/);
  assert.match(thisHostRefusal("fd7a:115c:a1e0:0:0:0:1:2") ?? "", /address of this machine itself/, "an IPv6 address in another spelling");
  assert.match(thisHostRefusal("::ffff:100.90.1.2") ?? "", /address of this machine itself/, "mapped into IPv6");
  assert.equal(thisHostRefusal("100.90.1.3"), null);
});

test("an IPv6 address that carries a refused IPv4 one is refused: NAT64, 6to4, IPv4-compatible", () => {
  for (const ip of ["64:ff9b::7f00:1", "64:ff9b::127.0.0.1", "2002:7f00:1::", "2002:7f00:0001:1:2:3:4:5", "::127.0.0.1", "::7f00:1", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::1"]) assert.match(thisHostRefusal(ip) ?? "", /address of this machine itself/, ip);
  write(JSON.stringify(record()));
  for (const ip of ["64:ff9b::645a:102", "2002:645a:102::1", "::100.90.1.2"]) assert.match(thisHostRefusal(ip) ?? "", /address of this machine itself/, `${ip}: the host's recorded address inside`);
  for (const ip of ["64:ff9b::808:808", "2002:808:808::1", "::8.8.8.8", "2001:db8::1"]) assert.equal(thisHostRefusal(ip), null, ip);
});

test("the host key is the host's whatever address it shows at", () => {
  assert.equal(thisHostKeyRefusal("SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), null, "nothing recorded");
  write(JSON.stringify(record()));
  assert.match(thisHostKeyRefusal("SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") ?? "", /this machine's own SSH host key/);
  assert.equal(thisHostKeyRefusal("SHA256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), null);
  assert.deepEqual([...thisHostFingerprints()], ["SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
});

test("the record fails closed: missing, empty, garbage or not a record is not usable, a good one is", () => {
  const bad = (why: RegExp) => {
    const u = thisHostUsable();
    assert.equal(u.ok, false);
    assert.match(u.ok ? "" : u.reason, why);
    assert.match(u.ok ? "" : u.reason, /run the installer on the host/);
  };
  assert.equal(thisHostRecorded(), false);
  bad(/isn't there/);
  write(JSON.stringify(record({ fingerprints: [] })));
  assert.equal(thisHostRecorded(), true);
  bad(/no SSH host key/);
  write("not json {");
  assert.equal(thisHostRecorded(), false);
  bad(/isn't JSON/);
  write(JSON.stringify({ fingerprints: "SHA256:x", addresses: [], hostname: "gir" }));
  bad(/isn't a record/);
  write(JSON.stringify(record()));
  assert.deepEqual(thisHostUsable(), { ok: true });
  assert.equal(thisHostRecorded(), true);
  // An unreadable one (a folder where the file is) is not usable either.
  fs.rmSync(thisHostFile());
  fs.mkdirSync(thisHostFile());
  bad(/can't be read/);
});

test("with no storage folder known nothing is usable, and nothing throws", () => {
  delete process.env.STORAGE_DIR;
  assert.equal(thisHostUsable().ok, false);
  assert.equal(thisHostRecorded(), false);
});

test("the test seam can stand in for the record", () => {
  g[THISHOST_RECORD] = record();
  assert.deepEqual(thisHostUsable(), { ok: true });
  assert.ok(thisHostKeyRefusal("SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
});

test("a host is compared in one form: case, a trailing dot, an IPv6 spelling, an IPv4 mapped into IPv6", () => {
  assert.equal(canonicalHost("Box.Example."), "box.example");
  assert.equal(canonicalHost("::ffff:192.0.2.5"), "192.0.2.5");
  assert.equal(canonicalHost("::ffff:c000:205"), "192.0.2.5");
  assert.equal(canonicalHost("2001:DB8:0:0:0:0:0:1"), "2001:db8::1");
  assert.equal(canonicalHost("[2001:db8::1]"), "2001:db8::1");
  assert.equal(canonicalHost("fe80::1%eth0"), "fe80::1");
  assert.equal(canonicalHost("192.0.2.5"), "192.0.2.5");
  assert.equal(SUITE_DIR, "anywherellm-suite");
});
