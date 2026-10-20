import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { OPEN_PAGES, hiddenFile, linksFile, linksHidden, noteLink, readLinks } from "./page-links.mts";

let storage: string;
let was: string | undefined;

beforeEach(() => {
  was = process.env.STORAGE_DIR;
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "page-links-"));
  process.env.STORAGE_DIR = storage;
});
afterEach(() => {
  if (was === undefined) delete process.env.STORAGE_DIR;
  else process.env.STORAGE_DIR = was;
  fs.rmSync(storage, { recursive: true, force: true });
});

test("the switch is a file: off without it, on with it, read each time", () => {
  assert.equal(linksHidden(), false);
  fs.mkdirSync(path.dirname(hiddenFile()), { recursive: true });
  fs.writeFileSync(hiddenFile(), "2026-10-21T00:00:00Z\n");
  assert.equal(linksHidden(), true);
  fs.rmSync(hiddenFile());
  assert.equal(linksHidden(), false);
  assert.match(OPEN_PAGES, /anywherellm-suite pages/);
});

test("each page keeps its own link, and the file is 0600", async () => {
  assert.deepEqual(readLinks(), {});
  await noteLink("library", "/library-lean/aaa.html");
  await noteLink("vault", "/vault-lean/bbb.html");
  assert.deepEqual(readLinks(), { library: "/library-lean/aaa.html", vault: "/vault-lean/bbb.html" });
  assert.equal(fs.statSync(linksFile()).mode & 0o777, 0o600);
  await noteLink("library", "/library-lean/ccc.html");
  assert.deepEqual(readLinks(), { library: "/library-lean/ccc.html", vault: "/vault-lean/bbb.html" });
});

test("two writers at once lose neither key", async () => {
  await Promise.all([noteLink("library", "/library-lean/one.html"), noteLink("vault", "/vault-lean/two.html")]);
  assert.deepEqual(readLinks(), { library: "/library-lean/one.html", vault: "/vault-lean/two.html" });
});

test("nothing is written when the link is the one kept already", async () => {
  await noteLink("vault", "/vault-lean/bbb.html");
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(linksFile(), past, past);
  await noteLink("vault", "/vault-lean/bbb.html");
  assert.equal(Math.round(fs.statSync(linksFile()).mtimeMs / 1000), Math.round(past.getTime() / 1000));
});

test("a damaged file is replaced, and what it held is not trusted", async () => {
  fs.mkdirSync(path.dirname(linksFile()), { recursive: true });
  fs.writeFileSync(linksFile(), "{not json");
  assert.deepEqual(readLinks(), {});
  await noteLink("library", "/library-lean/aaa.html");
  assert.deepEqual(readLinks(), { library: "/library-lean/aaa.html" });
  fs.writeFileSync(linksFile(), JSON.stringify({ library: 7, vault: "/vault-lean/x.html", extra: "/other" }));
  assert.deepEqual(readLinks(), { vault: "/vault-lean/x.html" }, "only the two paths, only strings");
});

test("a rotation is stamped beside the link, for that page only, and a plain note never stamps", async () => {
  await noteLink("vault", "/vault-lean/aaa.html");
  assert.equal(readLinks().rotated, undefined);
  await noteLink("vault", "/vault-lean/aaa.html", { rotated: true });
  const first = readLinks().rotated?.vault;
  assert.match(first ?? "", /^\d{4}-\d\d-\d\dT[\d:.]+Z$/, "stamped even when the link is the same: the token was replaced and is the same by chance only");
  assert.equal(readLinks().rotated?.library, undefined);
  await noteLink("library", "/library-lean/bbb.html", { rotated: true });
  assert.deepEqual(Object.keys(readLinks().rotated ?? {}).sort(), ["library", "vault"]);
  await noteLink("vault", "/vault-lean/ccc.html");
  assert.equal(readLinks().rotated?.vault, first, "a plain note keeps the stamp as it was");
  assert.equal(readLinks().vault, "/vault-lean/ccc.html");
});

test("only strings are read back, stamps included", () => {
  fs.mkdirSync(path.dirname(linksFile()), { recursive: true });
  fs.writeFileSync(linksFile(), JSON.stringify({ library: "/library-lean/x.html", vault: 5, rotated: { library: "2026-10-21T00:00:00Z", vault: 3, other: "x" }, extra: 1 }));
  assert.deepEqual(readLinks(), { library: "/library-lean/x.html", rotated: { library: "2026-10-21T00:00:00Z" } });
  fs.writeFileSync(linksFile(), JSON.stringify({ rotated: "yes", vault: "/vault-lean/y.html" }));
  assert.deepEqual(readLinks(), { vault: "/vault-lean/y.html" });
});
