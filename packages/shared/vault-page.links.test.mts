// The Vault page and the switch that keeps its link from the agent (#shared/page-links): the names
// are replaced once when the switch goes on, the links file follows the page whatever the switch.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
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
  assert.equal(readLinks().vault, `/vault-lean/${now.token}.html`);
  assert.match(readLinks().rotated?.vault ?? "", /^\d{4}-\d\d-\d\dT[\d:.]+Z$/, "the rotation is stamped beside the link");
  assert.equal(readLinks().rotated?.library, undefined, "and only for the page that was replaced");
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
  assert.equal(readLinks().vault, `/vault-lean/${first.token}.html`);
  const stamped = readLinks().rotated?.vault;
  assert.ok(stamped, "the first rotation is stamped, and an off show doesn't change the stamp");
  hide(true);
  await new Promise((r) => setTimeout(r, 5));
  await show(async () => {});
  const second = names();
  assert.notEqual(second.token, first.token);
  assert.equal(second.hidden, true);
  assert.equal(readLinks().vault, `/vault-lean/${second.token}.html`);
  assert.notEqual(readLinks().rotated?.vault, stamped, "the second rotation is stamped again");
});

test("with the switch off the old names stay, unmarked, and the link is noted", async () => {
  seedOld();
  await show(async () => {});
  assert.deepEqual(names(), { token: "oldtoken", secret: "oldsecret" });
  assert.deepEqual(readLinks(), { vault: "/vault-lean/oldtoken.html" });
  assert.ok(fs.existsSync(inPublic("oldtoken.html")));
});

test("a links file that can't be written is logged, and the page and its link are still given, switch off or on", async () => {
  const logged: string[] = [];
  const was = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.join(" "));
  try {
    for (const on of [false, true]) {
      fs.rmSync(linksFile(), { recursive: true, force: true });
      fs.mkdirSync(linksFile(), { recursive: true }); // a directory where the file goes: every write fails
      hide(on);
      const link = await show(async () => {});
      assert.match(link, /^https:\/\/allm\.example\/vault-lean\/[\w-]+\.html$/, `the link is given, switch ${on ? "on" : "off"}`);
      assert.ok(fs.existsSync(inPublic(`${names().token}.html`)), "the page is written");
    }
  } finally {
    console.error = was;
  }
  assert.ok(logged.some((l) => /vault-lean couldn't keep the page's link/.test(l)), logged.join("\n"));
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
  assert.equal(readLinks().vault, `/vault-lean/${after.token}.html`);
  assert.ok(readLinks().rotated?.vault, "the page's own rotate is stamped too");
  assert.equal(fs.existsSync(inPublic(`${before.token}.html`)), false);
  assert.equal(fs.existsSync(inPublic(`${after.token}.html`)), true);
  hide(false);
  await vaultPage.rotate();
  assert.equal(names().hidden, undefined);
  assert.equal(SUITE_DIR, "anywherellm-suite");
});

test("settleVault replaces the names without a page shown: the page is written under the new ones and the link stamped", async () => {
  seedOld();
  hide(true);
  await vaultPage.settleVault("logins", async () => {});
  const now = names();
  assert.notEqual(now.token, "oldtoken");
  assert.equal(now.hidden, true);
  assert.equal(fs.existsSync(inPublic("oldtoken.html")), false);
  assert.equal(fs.existsSync(inPublic("oldtoken-logins.json")), false);
  assert.ok(fs.existsSync(inPublic(`${now.token}.html`)), "the page is there for the link the user is given");
  assert.equal(readLinks().vault, `/vault-lean/${now.token}.html`);
  assert.ok(readLinks().rotated?.vault);
  await vaultPage.settleVault("logins", async () => {});
  assert.equal(names().token, now.token, "once");
});

test("settleVault with no Vault does nothing, and makes none", async () => {
  hide(true);
  await vaultPage.settleVault("logins", async () => {});
  assert.equal(fs.existsSync(namesFile()), false);
  assert.equal(fs.existsSync(linksFile()), false);
});

/** Makes fs.renameSync fail as a full disk does, naming the paths, for the length of `fn`. */
async function renamesFail(fn: () => Promise<void>) {
  const was = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    throw Object.assign(new Error(`ENOSPC: no space left on device, rename '${from}' -> '${to}'`), { code: "ENOSPC" });
  }) as typeof fs.renameSync;
  try {
    await fn();
  } finally {
    fs.renameSync = was;
  }
}

test("with the switch on a failed write says nothing of a token; with it off the error is as it was", async () => {
  const logged: string[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.join(" "));
  try {
    seedOld();
    hide(true);
    let failure: Error | null = null;
    await renamesFail(() => vaultPage.settleVault("logins", async () => {}).catch((e) => void (failure = e)));
    const now = names(); // the names were replaced before the move failed
    assert.ok(failure, "the failure is told");
    assert.equal((failure as unknown as Error).message, "the Vault page couldn't be written");
    assert.ok(!(failure as unknown as Error).message.includes(now.token));
    assert.ok(logged.length > 0 && logged.every((l) => !l.includes(now.token) && !l.includes(now.secret)), `logged detail is masked: ${logged.join(" | ")}`);
    // the next show repairs what the failed move left: the old page is swept
    await show(async () => {});
    assert.ok(!fs.existsSync(inPublic("oldtoken.html")), "the old page is removed by the next show");
    // switch off: the error is the Node one, as before
    hide(false);
    fs.writeFileSync(path.join(publicDir, "vault-lean", `${names().token}-keys.json`), "{}");
    let plain: Error | null = null;
    await renamesFail(() => vaultPage.rotate().catch((e) => void (plain = e)));
    assert.match((plain as unknown as Error)?.message ?? "", /ENOSPC/);
  } finally {
    console.error = log;
  }
});

test("a show removes every page file that isn't under the current token, and keeps what isn't a page file", async () => {
  hide(true);
  await show(async () => {});
  const token = names().token;
  // what a rotation that died between its steps, or a writer that read the names too early, left
  for (const f of ["stalestalestale.html", "stalestalestale-keys.json", "stalestalestale-logins.json"]) fs.writeFileSync(inPublic(f), "stale");
  for (const f of ["notes.txt", "index.html", "short-keys.json"]) fs.writeFileSync(inPublic(f), "not a page of the Vault's");
  await show(async () => {});
  for (const f of ["stalestalestale.html", "stalestalestale-keys.json", "stalestalestale-logins.json"]) assert.equal(fs.existsSync(inPublic(f)), false, f);
  for (const f of ["notes.txt", "index.html", "short-keys.json"]) assert.equal(fs.existsSync(inPublic(f)), true, f);
  assert.ok(fs.existsSync(inPublic(`${token}.html`)) && fs.existsSync(inPublic(`${token}-keys.json`)));
  // and a call that shows no page (settleVault) clears them too
  fs.writeFileSync(inPublic("leftoverleftover.html"), "stale");
  await vaultPage.settleVault("logins", async () => {});
  assert.equal(fs.existsSync(inPublic("leftoverleftover.html")), false);
});

test("a show and the page's own rotate at once leave only the current token's files and its link", async () => {
  for (let i = 0; i < 5; i++) {
    hide(true);
    await Promise.all([show(async () => {}), vaultPage.rotate(), show(async () => {}), vaultPage.rotate()]);
    const token = names().token;
    const pages = fs.readdirSync(path.join(publicDir, "vault-lean")).filter((f) => /^[\w-]{8,}\.html$/.test(f));
    assert.deepEqual(pages, [`${token}.html`], `round ${i}`);
    assert.equal(readLinks().vault, `/vault-lean/${token}.html`, `round ${i}`);
  }
});

test("take reads the events before it reads the names", () => {
  const order: string[] = [];
  const f = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
  const stat = f.statSync;
  const read = f.readFileSync;
  f.statSync = (p, ...rest) => (String(p).endsWith(path.join("documents", "custom-documents")) && order.push("events"), stat(p, ...rest));
  f.readFileSync = (p, ...rest) => (String(p).endsWith("vault-page.json") && order.push("names"), read(p, ...rest));
  try {
    fs.mkdirSync(path.join(storage, "documents", "custom-documents"), { recursive: true });
    vaultPage.take("keys");
  } finally {
    f.statSync = stat;
    f.readFileSync = read;
  }
  assert.ok(order.indexOf("events") >= 0, order.join(","));
  assert.ok(order.indexOf("names") < 0 || order.indexOf("events") < order.indexOf("names"), order.join(","));
});

const GAP = Symbol.for("anywherellm-suite.vaultpage.gap");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a call that comes while a rotation holds the names lock waits for it: the moved sections and the new page are all there after", async () => {
  seedOld();
  hide(true);
  const g = globalThis as unknown as Record<symbol, (() => Promise<void>) | undefined>;
  let second: Promise<unknown> | undefined;
  g[GAP] = async () => {
    g[GAP] = undefined; // once
    // a settle and a show from "another process", started in the old gap between the new names and the moved files
    second = Promise.all([vaultPage.settleVault("logins", async () => {}), show(async () => {})]);
    await sleep(200);
  };
  try {
    await show(async () => {});
    await second;
  } finally {
    g[GAP] = undefined;
  }
  const { token } = names();
  assert.notEqual(token, "oldtoken");
  assert.equal(fs.readFileSync(inPublic(`${token}-logins.json`), "utf8"), "old oldtoken-logins.json", "the logins section was moved, not swept before its move");
  assert.ok(fs.existsSync(inPublic(`${token}.html`)), "the new page is written");
  assert.deepEqual(fs.readdirSync(path.join(publicDir, "vault-lean")).filter((f) => f.startsWith("oldtoken")), [], "no file of the old token");
  assert.equal(readLinks().vault, `/vault-lean/${token}.html`);
});

test("with the switch off and no mark, a settle removes nothing and doesn't touch the names lock", async () => {
  seedOld();
  for (const f of ["stalestalestale.html", "stalestalestale-keys.json"]) fs.writeFileSync(inPublic(f), "stray");
  const lock = `${namesFile()}.lock`;
  fs.mkdirSync(lock); // held by "someone else": a settle that took it would wait and fail as busy
  try {
    const done = await Promise.race([vaultPage.settleVault("keys", async () => {}).then(() => "done"), sleep(1500).then(() => "waited")]);
    assert.equal(done, "done", "returned without taking the lock");
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
  assert.deepEqual(names(), { token: "oldtoken", secret: "oldsecret" });
  for (const f of ["stalestalestale.html", "stalestalestale-keys.json", "oldtoken.html", "oldtoken-keys.json", "oldtoken-logins.json"]) assert.ok(fs.existsSync(inPublic(f)), f);
  await show(async () => {}); // a show with the switch off writes the page and sweeps nothing either
  for (const f of ["stalestalestale.html", "stalestalestale-keys.json"]) assert.ok(fs.existsSync(inPublic(f)), `${f} after a show`);
});

test("calls from several processes at the switch-on all end with one rotation and every file where it belongs", async () => {
  const child = `const vp = require(process.argv[1]); vp.show(process.argv[2], { ok: 1 }, async () => {}, null).then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });`;
  const run = (section: string) =>
    new Promise<number>((resolve) => {
      const p = spawn(process.execPath, ["-e", child, path.join(built, "vault-page.cjs"), section], { env: process.env, stdio: ["ignore", "ignore", "inherit"] });
      p.on("exit", (code) => resolve(code ?? 1));
    });
  for (let round = 0; round < 3; round++) {
    seedOld();
    hide(true);
    const codes = await Promise.all([run("keys"), run("logins"), run("keys"), run("logins")]);
    assert.deepEqual(codes, [0, 0, 0, 0], `round ${round}`);
    const { token } = names();
    assert.notEqual(token, "oldtoken", `round ${round}`);
    assert.equal(fs.readFileSync(inPublic(`${token}-logins.json`), "utf8").length > 0, true, `round ${round}`);
    const files = fs.readdirSync(path.join(publicDir, "vault-lean")).sort();
    assert.deepEqual(files, [`${token}-keys.json`, `${token}-logins.json`, `${token}.html`].sort(), `round ${round}`);
    assert.equal(readLinks().vault, `/vault-lean/${token}.html`, `round ${round}`);
    for (const f of files) fs.rmSync(inPublic(f)); // the next round starts from the old form
    fs.rmSync(namesFile(), { force: true });
    fs.rmSync(linksFile(), { force: true });
  }
});
