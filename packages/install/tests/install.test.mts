import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { desktopStorage } from "../src/paths.mts";
import { type Payload } from "../src/addons.mts";
import { health, install, uninstall, type Ctx, type Options } from "../src/install.mts";
import { FakeAnythingLLM } from "./fakes/anythingllm.mts";
import { tempDir } from "./fakes/tmp.mts";

const PAYLOAD: Payload = { skills: [{ name: "library", hubId: "library-lean", files: { "handler.js": "// library\n" }, pages: true }] };
const tmp = tempDir("install");

/** A machine with one SSH host key, for the record install makes of it. */
function standIn() {
  const sshDir = fs.mkdtempSync(path.join(tmp, "ssh-"));
  fs.writeFileSync(path.join(sshDir, "ssh_host_ed25519_key.pub"), `ssh-ed25519 ${Buffer.from("stand-in host key").toString("base64")} root@stand-in\n`);
  return { sshDir, interfaces: { eth0: [{ address: "192.0.2.10" }] as never }, hostname: "stand-in" };
}

let fake: FakeAnythingLLM;
let home: string;
let storage: string;
let printed: string[];
let ctx: Ctx;

beforeEach(async () => {
  fake = await new FakeAnythingLLM().start();
  home = fs.mkdtempSync(path.join(tmp, "home-"));
  storage = path.join(home, "storage");
  fs.mkdirSync(path.join(storage, "plugins"), { recursive: true });
  printed = [];
  ctx = {
    home,
    env: { ANYTHINGLLM_URL: fake.url },
    print: (l) => printed.push(l),
    payload: PAYLOAD,
    platform: "linux", // paths as on Linux, whatever runs the tests
    host: standIn(), // not this machine's own keys and addresses
  };
});
afterEach(() => fake.stop());

const opts = (more: Partial<Options> = {}): Options => ({ storage, ...more });

test("install puts the skills into the storage and asks nothing of AnythingLLM", async () => {
  await install(ctx, opts());
  assert.ok(fs.existsSync(path.join(storage, "plugins", "agent-skills", "library-lean", "handler.js")));
  assert.equal(fake.requests, 0);
  assert.match(printed.join("\n"), /switch on the skills you want/);
});

test("with no --storage each command takes AnythingLLM Desktop's", async () => {
  const desktop = desktopStorage(ctx);
  fs.mkdirSync(path.join(desktop, "plugins"), { recursive: true });
  await install(ctx, opts({ storage: undefined, pageKey: "brx-good" }));
  assert.ok(fs.existsSync(path.join(desktop, "plugins", "agent-skills", "library-lean", "handler.js")));
  assert.equal(await health(ctx), true, printed.join("\n"));
  uninstall(ctx);
  assert.ok(!fs.existsSync(path.join(desktop, "plugins", "agent-skills", "library-lean")));
});

test("with no storage to be found each command says how to name one", async () => {
  const refusal = { message: /--storage DIR.*mounted at \/app\/server\/storage.*bind mount.*Desktop's would be/ };
  await assert.rejects(install(ctx, opts({ storage: undefined })), refusal);
  await assert.rejects(health(ctx), refusal);
  assert.throws(() => uninstall(ctx), refusal);
  await assert.rejects(install(ctx, opts({ storage: home })), { message: /doesn't look like AnythingLLM's storage/ });
  fs.mkdirSync(path.join(home, "s2", "plugins"), { recursive: true });
  await install(ctx, opts({ storage: "~/s2" }));
  assert.ok(fs.existsSync(path.join(home, "s2", "plugins", "agent-skills", "library-lean", "handler.js")));
});

test("an unknown skill is refused before anything is written", async () => {
  await assert.rejects(install(ctx, opts({ skills: ["nope"] })), /no such skill: nope/);
  assert.ok(!fs.existsSync(path.join(storage, "plugins", "agent-skills")));
});

test("--skills none puts in nothing", async () => {
  await install(ctx, opts({ skills: ["none"] }));
  assert.ok(!fs.existsSync(path.join(storage, "plugins", "agent-skills")));
});

test("uninstall takes the skills out; their data stays", async () => {
  await install(ctx, opts());
  fs.mkdirSync(path.join(storage, "library-lean"));
  uninstall(ctx, opts());
  assert.ok(!fs.existsSync(path.join(storage, "plugins", "agent-skills", "library-lean")));
  assert.ok(fs.existsSync(path.join(storage, "library-lean")));
});

test("health checks what install put in", async () => {
  await install(ctx, opts({ pageKey: "brx-good" }));
  printed.length = 0;
  assert.equal(await health(ctx, opts()), true, printed.join("\n"));
  fs.writeFileSync(path.join(storage, "plugins", "agent-skills", "library-lean", "handler.js"), "old");
  printed.length = 0;
  assert.equal(await health(ctx, opts()), false);
  assert.match(printed.join("\n"), /FAIL the library skill: handler\.js not this version's/);
});

test("the pages' key is kept for its owner alone, until another is given; health asks AnythingLLM about it", async () => {
  await assert.rejects(install(ctx, opts({ pageKey: "good" })), /--page-key is a browser-extension key \(brx-\.\.\.\)/);
  await install(ctx, opts());
  assert.match(printed.join("\n"), /- The skills' pages need a key to post with: make one in AnythingLLM's Settings > Browser Extension/);
  printed.length = 0;
  assert.equal(await health(ctx, opts()), false);
  assert.match(printed.join("\n"), /FAIL the pages' key: none: make one/);

  const file = path.join(storage, "anywherellm-suite", "page-key");
  await install(ctx, opts({ pageKey: "brx-good" }));
  assert.equal(fs.readFileSync(file, "utf8"), "brx-good\n");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600); // Windows has no modes
  printed.length = 0;
  await install(ctx, opts());
  assert.equal(fs.readFileSync(file, "utf8"), "brx-good\n", "kept when install isn't given one");
  assert.ok(!printed.some((l) => l.includes("need a key")), printed.join("\n"));

  fake.extensionKeys.delete("brx-good"); // revoked in AnythingLLM's settings
  printed.length = 0;
  assert.equal(await health(ctx, opts()), false);
  assert.match(printed.join("\n"), /FAIL the pages' key: AnythingLLM refuses it \(403\)/);

  printed.length = 0;
  uninstall(ctx, opts());
  assert.match(printed.join("\n"), /the pages' key goes with it: revoke it in AnythingLLM's Settings > Browser Extension/);
  assert.ok(!fs.existsSync(file));
});

test("with no skill that has pages, no key is asked for or checked", async () => {
  const quiet: Ctx = { ...ctx, payload: { ...PAYLOAD, skills: [{ ...PAYLOAD.skills[0], pages: false }] } };
  await install(quiet, opts());
  assert.ok(!printed.some((l) => l.includes("need a key")), printed.join("\n"));
  printed.length = 0;
  assert.equal(await health(quiet, opts()), true, printed.join("\n"));
  assert.ok(!printed.some((l) => l.includes("the pages' key")), printed.join("\n"));
});


// The record of this machine, which the library reads to refuse a target that is this machine.
import crypto from "node:crypto";
import { thisHostFile } from "#shared/thishost";
import { fingerprintOf, recordOf } from "../src/thishost.mts";

const KEY_BLOB = Buffer.from("test host key").toString("base64");
const KEY_PRINT = `SHA256:${crypto.createHash("sha256").update(Buffer.from(KEY_BLOB, "base64")).digest("base64").replace(/=+$/, "")}`;

function host(keys: Record<string, string> = { "ssh_host_ed25519_key.pub": `ssh-ed25519 ${KEY_BLOB} root@gir\n` }, addresses = ["127.0.0.1", "192.168.0.29", "100.89.16.22", "fe80::1%wlp3s0"]) {
  const sshDir = fs.mkdtempSync(path.join(tmp, "ssh-"));
  for (const [name, text] of Object.entries(keys)) fs.writeFileSync(path.join(sshDir, name), text);
  return { sshDir, interfaces: { eth0: addresses.map((address) => ({ address }) as never) }, hostname: "gir" };
}

test("a fingerprint is ssh-keygen's: SHA256 of the key, base64 without padding", () => {
  assert.equal(fingerprintOf(`ssh-ed25519 ${KEY_BLOB} comment`), KEY_PRINT);
  assert.equal(fingerprintOf("not a key line"), null);
  assert.equal(fingerprintOf(""), null);
});

test("install records the host's keys and addresses, again on every run, and says when nothing changed", async () => {
  ctx.host = host();
  await install(ctx, opts());
  const file = thisHostFile(storage);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { fingerprints: [KEY_PRINT], addresses: ["100.89.16.22", "127.0.0.1", "192.168.0.29", "fe80::1"], hostname: "gir" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  assert.match(printed.join("\n"), /recorded this machine \(1 SSH host key, 4 addresses\)/);
  printed.length = 0;
  await install(ctx, opts());
  assert.match(printed.join("\n"), /unchanged: this machine/);
  ctx.host = host({ "ssh_host_ed25519_key.pub": `ssh-ed25519 ${KEY_BLOB} root@gir\n`, "ssh_host_rsa_key.pub": `ssh-rsa ${Buffer.from("another").toString("base64")} root@gir\n` });
  await install(ctx, opts());
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).fingerprints.length, 2, "install writes it again when the host has changed");
});

test("a host with no readable keys is recorded with none, and install still succeeds", async () => {
  ctx.host = host({ "ssh_host_ed25519_key.pub": "garbage\n", "unrelated.pub": `ssh-ed25519 ${KEY_BLOB}\n` });
  await install(ctx, opts());
  assert.deepEqual(recordOf(ctx.host).fingerprints, []);
  assert.match(printed.join("\n"), /no SSH host key in/);
  ctx.host = { ...ctx.host, sshDir: path.join(tmp, "no-such-dir") };
  await install(ctx, opts());
  assert.deepEqual(JSON.parse(fs.readFileSync(thisHostFile(storage), "utf8")).fingerprints, []);
});

test("health reports the record missing, drifted, empty, and ok once install has written it", async () => {
  ctx.host = host();
  await install(ctx, opts({ pageKey: "brx-good" }));
  printed.length = 0;
  assert.equal(await health(ctx, opts()), true, printed.join("\n"));
  fs.rmSync(thisHostFile(storage));
  printed.length = 0;
  assert.equal(await health(ctx, opts()), false);
  assert.match(printed.join("\n"), /FAIL the record of this machine.*missing.*Run install on this machine: it writes it again/);
  await install(ctx, opts({ pageKey: "brx-good" }));
  // The tailnet address changed.
  ctx.host = host(undefined, ["127.0.0.1", "192.168.0.29", "100.64.0.9"]);
  printed.length = 0;
  assert.equal(await health(ctx, opts()), false);
  assert.match(printed.join("\n"), /FAIL the record of this machine.*differs from what this machine has now: its addresses.*writes the record again/);
  await install(ctx, opts({ pageKey: "brx-good" }));
  printed.length = 0;
  assert.equal(await health(ctx, opts()), true);
  // A host key replaced.
  ctx.host = host({ "ssh_host_ed25519_key.pub": `ssh-ed25519 ${Buffer.from("new key").toString("base64")}\n` }, ["127.0.0.1", "192.168.0.29", "100.64.0.9"]);
  printed.length = 0;
  assert.equal(await health(ctx, opts()), false);
  assert.match(printed.join("\n"), /its SSH host keys/);
  // A machine with no key at all.
  ctx.host = host({}, ["127.0.0.1"]);
  await install(ctx, opts({ pageKey: "brx-good" }));
  printed.length = 0;
  assert.equal(await health(ctx, opts()), false);
  assert.match(printed.join("\n"), /no SSH host key/);
});

test("a link at the record's path is refused, not written through, and install carries on", async () => {
  ctx.host = host();
  const file = thisHostFile(storage);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const elsewhere = path.join(tmp, "elsewhere.json");
  fs.writeFileSync(elsewhere, "keep me");
  fs.symlinkSync(elsewhere, file);
  await install(ctx, opts());
  assert.equal(fs.readFileSync(elsewhere, "utf8"), "keep me");
  assert.match(printed.join("\n"), /didn't record this machine.*link/);
  assert.ok(fs.lstatSync(file).isSymbolicLink());
  fs.rmSync(file);
  fs.linkSync(elsewhere, file);
  printed.length = 0;
  await install(ctx, opts());
  assert.equal(fs.readFileSync(elsewhere, "utf8"), "keep me");
  assert.match(printed.join("\n"), /didn't record this machine.*link/);
  fs.rmSync(file);
  // A folder that is a link.
  const real = fs.mkdtempSync(path.join(tmp, "real-"));
  fs.rmSync(path.dirname(file), { recursive: true });
  fs.symlinkSync(real, path.dirname(file));
  printed.length = 0;
  await install(ctx, opts());
  assert.deepEqual(fs.readdirSync(real), []);
  assert.match(printed.join("\n"), /didn't record this machine.*link/);
});
