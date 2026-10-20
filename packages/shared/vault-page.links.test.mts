// The Vault page and the switch that keeps its link from the agent (#shared/page-links): the names
// are replaced once when the switch goes on, the links file follows the page whatever the switch.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { SUITE_DIR, pageKeyFile } from "./anythingllm.mts";
import { writeAtomic } from "./atomic.mts";
import { hiddenFile, linksFile, readLinks } from "./page-links.mts";

// vault-page.mts imports its page as text, which only the skills' build (esbuild) understands: the
// test bundles it the same way and loads that.
const built = fs.mkdtempSync(path.join(os.tmpdir(), "vault-page-build-"));
await build({
  entryPoints: [fileURLToPath(new URL("./vault-page.mts", import.meta.url))],
  outfile: path.join(built, "vault-page.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  loader: { ".html": "text" },
  logLevel: "silent",
});
const vaultPage = createRequire(import.meta.url)(path.join(built, "vault-page.cjs")) as typeof import("./vault-page.mts");
test.after(() => fs.rmSync(built, { recursive: true, force: true }));

let tmp: string;
let storage: string;
let publicDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["STORAGE_DIR", "ANYTHINGLLM_PUBLIC_DIR"]) saved[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-page-links-"));
  storage = path.join(tmp, "storage");
  publicDir = path.join(tmp, "public");
  fs.mkdirSync(storage, { recursive: true });
  fs.mkdirSync(path.join(publicDir, "vault-lean"), { recursive: true });
  process.env.STORAGE_DIR = storage;
  process.env.ANYTHINGLLM_PUBLIC_DIR = publicDir;
  writeAtomic(pageKeyFile(storage), "brx-test\n");
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const namesFile = () => path.join(storage, "vault-lean", "vault-page.json");
const names = () => JSON.parse(fs.readFileSync(namesFile(), "utf8")) as { token: string; secret: string; hidden?: true };
const inPublic = (name: string) => path.join(publicDir, "vault-lean", name);
const hide = (on: boolean) => {
  if (on) {
    fs.mkdirSync(path.dirname(hiddenFile()), { recursive: true });
    fs.writeFileSync(hiddenFile(), "2026-10-21T00:00:00Z\n");
  } else fs.rmSync(hiddenFile(), { force: true });
};

/** A Vault as the version before the switch left it: {token, secret} and its public files. */
function seedOld() {
  fs.mkdirSync(path.dirname(namesFile()), { recursive: true });
  fs.writeFileSync(namesFile(), JSON.stringify({ token: "oldtoken", secret: "oldsecret" }));
  for (const f of ["oldtoken.html", "oldtoken-keys.json", "oldtoken-logins.json"]) fs.writeFileSync(inPublic(f), `old ${f}`);
}

let posts = 0;
/** What the Vault's keys section posts, as AnythingLLM's collector writes it. */
function post(event: Record<string, unknown>) {
  const dir = path.join(storage, "documents", "custom-documents");
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const file = path.join(dir, `raw-vault-lean-keys-${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, pageContent: JSON.stringify({ vault_lean_event: 1, ...event }) }));
  const at = new Date(Date.now() + ++posts * 10);
  fs.utimesSync(file, at, at);
}

/** A section's drain that keeps the events it was given. */
const collector = () => {
  const applied: string[] = [];
  return { applied, drain: async () => void applied.push(...vaultPage.take("keys").map((e) => String(e.ev))) };
};
const show = (drain: () => Promise<void>, base: string | null = "https://allm.example") => vaultPage.show("keys", { keys: [] }, drain, base);

test("the first show after the switch goes on replaces the old form's names once, moves the sections and notes the new path", async () => {
  seedOld();
  hide(true);
  const link = await show(async () => {});
  const now = names();
  assert.notEqual(now.token, "oldtoken");
  assert.notEqual(now.secret, "oldsecret");
  assert.equal(now.hidden, true);
  assert.equal(link, `https://allm.example/vault-lean/${now.token}.html`);
  assert.equal(fs.existsSync(inPublic("oldtoken.html")), false, "the old page is gone");
  assert.equal(fs.existsSync(inPublic("oldtoken-logins.json")), false);
  assert.equal(fs.readFileSync(inPublic(`${now.token}-logins.json`), "utf8"), "old oldtoken-logins.json", "the other section's state moved under the new name");
  assert.equal(fs.readFileSync(inPublic(`${now.token}-keys.json`), "utf8"), JSON.stringify({ keys: [] }), "this section's state is written under the new name");
  assert.ok(fs.existsSync(inPublic(`${now.token}.html`)));
  assert.deepEqual(readLinks(), { vault: `/vault-lean/${now.token}.html` });
  assert.equal(fs.statSync(linksFile()).mode & 0o777, 0o600);
});

test("a second show leaves the names alone", async () => {
  seedOld();
  hide(true);
  await show(async () => {});
  const first = names();
  await show(async () => {});
  assert.deepEqual(names(), first);
});

test("two shows at once rotate once", async () => {
  seedOld();
  hide(true);
  // A rotation makes a token and a secret, newSecret's 18 random bytes each: counted, since the
  // names one rotation or two leave look the same.
  const randomBytes = crypto.randomBytes;
  let made = 0;
  (crypto as { randomBytes: unknown }).randomBytes = (...args: unknown[]) => (args[0] === 18 && made++, (randomBytes as (...a: unknown[]) => unknown)(...args));
  let a: string, b: string;
  try {
    [a, b] = await Promise.all([show(async () => {}), show(async () => {})]);
  } finally {
    (crypto as { randomBytes: unknown }).randomBytes = randomBytes;
  }
  assert.equal(made, 2, "one token and one secret: one rotation");
  assert.equal(a, b, "both answer the one new link");
  assert.equal(a, `https://allm.example/vault-lean/${names().token}.html`);
  assert.equal(fs.readFileSync(inPublic(`${names().token}-logins.json`), "utf8"), "old oldtoken-logins.json");
});

test("switch on, off, on: the links went out while it was off, so the second on rotates again", async () => {
  seedOld();
  hide(true);
  await show(async () => {});
  const first = names();
  hide(false);
  await show(async () => {});
  const off = names();
  assert.equal(off.token, first.token, "off doesn't rotate");
  assert.equal(off.hidden, undefined, "off drops the mark: the link is given out again");
  assert.deepEqual(readLinks(), { vault: `/vault-lean/${first.token}.html` });
  hide(true);
  await show(async () => {});
  const second = names();
  assert.notEqual(second.token, first.token);
  assert.equal(second.hidden, true);
  assert.deepEqual(readLinks(), { vault: `/vault-lean/${second.token}.html` });
});

test("with the switch off the old names stay, unmarked, and the link is noted", async () => {
  seedOld();
  await show(async () => {});
  assert.deepEqual(names(), { token: "oldtoken", secret: "oldsecret" });
  assert.deepEqual(readLinks(), { vault: "/vault-lean/oldtoken.html" });
  assert.ok(fs.existsSync(inPublic("oldtoken.html")));
});

test("what the page posted under the old secret is applied before the names change, and an old secret is dead after", async () => {
  seedOld();
  post({ secret: "oldsecret", ev: "key-delete" });
  hide(true);
  const { applied, drain } = collector();
  await show(drain);
  assert.deepEqual(applied, ["key-delete"], "applied in the turn before the rotation");
  post({ secret: "oldsecret", ev: "key-delete-late" });
  post({ secret: names().secret, ev: "key-delete-new" });
  assert.deepEqual(vaultPage.take("keys").map((e) => e.ev), ["key-delete-new"], "only the new secret is taken");
});

test("a Vault made while the switch is on is marked and not rotated; one made while it is off isn't marked", async () => {
  hide(true);
  await show(async () => {});
  const marked = names();
  assert.equal(marked.hidden, true);
  await show(async () => {});
  assert.deepEqual(names(), marked);
  fs.rmSync(namesFile());
  hide(false);
  await show(async () => {});
  assert.equal(names().hidden, undefined);
});

test("the page's own rotate keeps the mark of the switch and moves the link", async () => {
  hide(true);
  await show(async () => {});
  const before = names();
  await vaultPage.rotate();
  const after = names();
  assert.notEqual(after.token, before.token);
  assert.equal(after.hidden, true);
  assert.deepEqual(readLinks(), { vault: `/vault-lean/${after.token}.html` });
  assert.equal(fs.existsSync(inPublic(`${before.token}.html`)), false);
  assert.equal(fs.existsSync(inPublic(`${after.token}.html`)), true);
  hide(false);
  await vaultPage.rotate();
  assert.equal(names().hidden, undefined);
  assert.equal(SUITE_DIR, "anywherellm-suite");
});
