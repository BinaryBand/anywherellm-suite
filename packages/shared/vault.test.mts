import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { seal } from "./test-helpers.mts";
import { VaultError, load, newId, openSealed, publicKey, readSealed, update, writeSealed } from "./vault.mts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let dir = "";
let n = 0;
beforeEach(() => {
  dir = path.join(tmp, `v${n++}`);
  delete process.env.VAULT_KEY_FILE;
});

const entry = (user: string) => ({ id: newId(), kind: "key", site: "api.example.com", user, value: `secret-${user}` });

test("an entry kept is there to load, and the file holds it encrypted", async () => {
  assert.deepEqual(load(dir), { pub: null, priv: null, entries: [] }, "no file is an empty vault");
  const id = await update((v) => {
    const e = entry("work");
    v.entries.push(e);
    return e.id;
  }, dir);
  assert.equal(load(dir).entries[0].id, id);
  assert.equal(load(dir).entries[0].value, "secret-work");
  const text = fs.readFileSync(path.join(dir, "vault.json"), "utf8");
  assert.ok(!text.includes("secret-work"), "the value isn't in the file in clear");
  assert.equal(JSON.parse(text).v, 1);
  if (process.platform !== "win32") assert.equal((fs.statSync(path.join(dir, "vault.json")).mode & 0o777).toString(8), "600"); // Windows has no modes
});

test("what's changed in a loaded copy isn't kept, and a change that throws writes nothing", async () => {
  await update((v) => void v.entries.push(entry("a")), dir);
  load(dir).entries.push(entry("b"));
  assert.equal(load(dir).entries.length, 1);
  await assert.rejects(
    update((v) => {
      v.entries.push(entry("c"));
      throw new Error("changed my mind");
    }, dir),
    /changed my mind/,
  );
  assert.equal(load(dir).entries.length, 1);
  await update((v) => void v.entries.push(entry("d")), dir);
  assert.equal(load(dir).entries.length, 2, "a failed change doesn't stop the next");
});

test("the key is made beside the vault the first time, for its owner alone", async () => {
  await update((v) => void v.entries.push(entry("a")), dir);
  const file = path.join(dir, "vault.key");
  assert.equal(Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64").length, 32);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("a vault whose key is gone can't be opened, and a new one starts empty once it's removed", async () => {
  await update((v) => void v.entries.push(entry("a")), dir);
  fs.rmSync(path.join(dir, "vault.key"));
  await assert.rejects(update(() => undefined, dir), /can't be opened with the key in .*vault\.key.*put the key back/);
  assert.ok(!fs.existsSync(path.join(dir, "vault.key")), "a vault that exists is given no new key");
  fs.rmSync(path.join(dir, "vault.json"));
  assert.deepEqual(load(dir), { pub: null, priv: null, entries: [] }, "a new vault starts empty");
});

/** A key file outside the vault's folder, as VAULT_KEY_FILE names it. */
function keyFileWith(text = crypto.randomBytes(32).toString("base64") + "\n"): string {
  const file = path.join(tmp, `key-${n++}`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

test("moving vault.key out of the storage and naming it in VAULT_KEY_FILE keeps the vault and its sealed files open", async () => {
  await update((v) => void v.entries.push(entry("a")), dir);
  writeSealed("session-home", [{ name: "sid", value: "s-1" }], dir);
  const outside = path.join(tmp, `moved-${n++}`);
  fs.renameSync(path.join(dir, "vault.key"), outside);
  process.env.VAULT_KEY_FILE = outside;
  assert.equal(load(dir).entries[0].value, "secret-a");
  assert.deepEqual(readSealed("session-home", dir), [{ name: "sid", value: "s-1" }]);
  assert.ok(!fs.existsSync(path.join(dir, "vault.key")), "no key is made beside it");
});

test("a new vault with VAULT_KEY_FILE is sealed under its key alone", async () => {
  process.env.VAULT_KEY_FILE = keyFileWith();
  await update((v) => void v.entries.push(entry("a")), dir);
  assert.ok(!fs.existsSync(path.join(dir, "vault.key")), "no key is kept beside it");
  delete process.env.VAULT_KEY_FILE;
  assert.throws(() => load(dir), /can't be opened with the key in .*vault\.key/, "without it the vault stays closed");
});

test("a VAULT_KEY_FILE that holds no key, or another one, is refused", async () => {
  process.env.VAULT_KEY_FILE = keyFileWith();
  await update((v) => void v.entries.push(entry("a")), dir);
  process.env.VAULT_KEY_FILE = keyFileWith("not a key\n");
  assert.throws(() => load(dir), /holds no key: .*openssl rand -base64 32/);
  process.env.VAULT_KEY_FILE = keyFileWith();
  assert.throws(() => load(dir), /can't be opened with the key in VAULT_KEY_FILE/);
});

test("a sealed file whose key is gone is given no new key either", () => {
  writeSealed("session-home", [{ name: "sid", value: "s-1" }], dir);
  fs.rmSync(path.join(dir, "vault.key"));
  assert.throws(() => writeSealed("session-work", [], dir), /can't be opened with the key in .*vault\.key/);
  assert.ok(!fs.existsSync(path.join(dir, "vault.key")), "no new key was made");
});

test("a sealed file beside the vault keeps a value apart from it", () => {
  assert.equal(readSealed("session-home", dir), null, "none yet");
  writeSealed("session-home", [{ name: "sid", value: "s-1" }], dir);
  const file = path.join(dir, "sealed", "session-home.json");
  assert.ok(!fs.readFileSync(file, "utf8").includes("s-1"), "not in clear");
  assert.ok(!fs.existsSync(path.join(dir, "vault.json")), "the vault isn't written");
  assert.deepEqual(readSealed("session-home", dir), [{ name: "sid", value: "s-1" }]);
  writeSealed("session-home", null, dir);
  assert.ok(!fs.existsSync(file), "null removes it");
  assert.throws(() => writeSealed("../escape", 1, dir), VaultError);
});

test("changes from one process all land, in turn", async () => {
  await Promise.all(Array.from({ length: 20 }, (_, i) => update((v) => void v.entries.push(entry(`p${i}`)), dir)));
  assert.equal(load(dir).entries.length, 20);
});

test("changes from two processes at once all land: the lock folder takes them in turn", async () => {
  const module = pathToFileURL(fileURLToPath(new URL("./vault.mts", import.meta.url))).href;
  const child = `
    const v = await import(${JSON.stringify(module)});
    const dir = process.argv[1], who = process.argv[2];
    await Promise.all(Array.from({ length: 25 }, (_, i) => v.update((x) => { x.entries.push({ id: v.newId(), kind: "key", site: "s.example", user: who + i }); }, dir)));
  `;
  const run = (who: string) => promisify(execFile)(process.execPath, ["--input-type=module", "-e", child, dir, who]);
  await Promise.all([run("a"), run("b")]);
  const users = load(dir).entries.map((e) => e.user);
  assert.equal(users.length, 50, "no change was lost");
  assert.equal(new Set(users).size, 50);
  assert.ok(!fs.existsSync(path.join(dir, "vault.lock")), "the lock was released");
});

test("a lock a dead process left behind is broken once it's old", async () => {
  fs.mkdirSync(path.join(dir, "vault.lock"), { recursive: true });
  const old = new Date(Date.now() - 120 * 1000);
  fs.utimesSync(path.join(dir, "vault.lock"), old, old);
  await update((v) => void v.entries.push(entry("a")), dir);
  assert.equal(load(dir).entries.length, 1);
});

test("what a page seals with the public key opens here, short (RSA) or long (h1.)", async () => {
  const pub = await publicKey(dir);
  assert.equal(await publicKey(dir), pub, "the pair is made once");
  const short = seal("hunter2", pub);
  assert.doesNotMatch(short, /^h1\./);
  assert.equal(openSealed(short, dir), "hunter2");
  const long = "x".repeat(2000);
  const sealed = seal(long, pub);
  assert.match(sealed, /^h1\./);
  assert.equal(openSealed(sealed, dir), long);
  assert.throws(() => openSealed("not sealed", dir), /couldn't be opened/);
});
