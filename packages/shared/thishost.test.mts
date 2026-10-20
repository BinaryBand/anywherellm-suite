import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { THISHOST_EXCEPT, thisHostRefusal } from "./thishost.mts";

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
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  g[THISHOST_EXCEPT] = new Set(["127.0.0.1"]);
  try {
    assert.equal(thisHostRefusal("127.0.0.1"), null);
    assert.ok(thisHostRefusal("127.0.0.2"));
  } finally {
    delete g[THISHOST_EXCEPT];
  }
});
