// kit.crypto (known answers), kit.secret (a function signs with a key it never sees, only in the
// key's namespace, in a job only when the user lets it, at most 60 times a minute, every use
// recorded), signing keys on the Vault, the keys the temporary sshsig skill saved, and the
// sshsig-channel snippet end to end, against OpenSSH's own ssh-keygen -Y.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { call, idOf, library, pageState, post, postVault, reset, runRecord, seal, skillDir, storage, vaultState } from "./harness.mts";
import * as vault from "#shared/vault";

const hasKeygen = spawnSync("ssh-keygen", ["-?"]).error === undefined;
const tmp = path.join(storage, "..", "signing");
fs.mkdirSync(tmp, { recursive: true });

/** Saves `source` as the function signer.<name> in a toolkit with no API, and runs it with `inputs`
 *  (as a scheduled job's run when `job`): its record. */
async function ran(name: string, source: string, inputs: Record<string, unknown> = {}, job = false): Promise<Record<string, any>> {
  const fields = Object.fromEntries(Object.keys(inputs).map((k) => [k, { type: typeof inputs[k] === "object" ? "object" : typeof inputs[k] }]));
  assert.match(await call({ action: "save", service: "signer", toolkit: { title: "Signing" }, function: { name, description: "A test.", inputs: fields, source } }), new RegExp(`Saved signer\\.${name}`));
  return runRecord(idOf(await call({ action: "run", name: `signer.${name}`, inputs }, job ? null : "work")));
}

/** Makes the signing key `label` for `namespace` on the Vault, as the user does: its public line. */
async function makeKey(label: string, namespace: string): Promise<string> {
  await call({ action: "library" }); // writes the Vault
  postVault({ ev: "signing-new", label, namespace });
  await call({ action: "library" });
  return vaultState().signing.find((k: { label: string }) => k.label === label).public;
}

const seedOf = (label: string): string => String(vault.entries().find((e) => e.kind === "signing" && e.user === label)!.seed);
const everything = (): string => [...fs.readdirSync(path.join(library, "runs"), { recursive: true, withFileTypes: true })].filter((d) => d.isFile()).map((d) => fs.readFileSync(path.join(d.parentPath, d.name), "utf8")).join("\n");

const s = (b: Buffer | string) => {
  const n = Buffer.alloc(4);
  n.writeUInt32BE(Buffer.byteLength(b));
  return Buffer.concat([n, Buffer.from(b)]);
};
const pubOf = (seed: Buffer) => crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" }).subarray(-32);
const lineOf = (seed: Buffer) => `ssh-ed25519 ${Buffer.concat([s("ssh-ed25519"), s(pubOf(seed))]).toString("base64")}`;

/** ssh-keygen's armored signature of `body` with `seed` in `namespace` (an unencrypted OpenSSH key
 *  file written for it). */
function keygenSign(seed: Buffer, namespace: string, body: string): string {
  const pub = pubOf(seed);
  const check = crypto.randomBytes(4);
  let priv = Buffer.concat([check, check, s("ssh-ed25519"), s(pub), s(Buffer.concat([seed, pub])), s("test")]);
  for (let i = 1; priv.length % 8; i++) priv = Buffer.concat([priv, Buffer.from([i])]);
  const one = Buffer.alloc(4);
  one.writeUInt32BE(1);
  const blob = Buffer.concat([Buffer.from("openssh-key-v1\0"), s("none"), s("none"), s(""), one, s(Buffer.concat([s("ssh-ed25519"), s(pub)])), s(priv)]);
  const key = path.join(tmp, `key-${crypto.randomBytes(4).toString("hex")}`);
  fs.writeFileSync(key, `-----BEGIN OPENSSH PRIVATE KEY-----\n${blob.toString("base64").match(/.{1,70}/g)!.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`, { mode: 0o600 });
  const file = `${key}.body`;
  fs.writeFileSync(file, body);
  execFileSync("ssh-keygen", ["-q", "-Y", "sign", "-f", key, "-n", namespace, file], { stdio: "pipe" });
  return fs.readFileSync(`${file}.sig`, "utf8");
}

/** Whether ssh-keygen takes `sig` as `line`'s signature of `body` in `namespace`. */
function keygenVerifies(line: string, namespace: string, body: string, sig: string): boolean {
  const signers = path.join(tmp, "allowed");
  const sigFile = path.join(tmp, "body.sig");
  fs.writeFileSync(signers, `me namespaces="${namespace}" ${line}\n`);
  fs.writeFileSync(sigFile, sig);
  return spawnSync("ssh-keygen", ["-Y", "verify", "-f", signers, "-I", "me", "-n", namespace, "-s", sigFile], { input: body }).status === 0;
}

test.beforeEach(() => reset());

test("kit.crypto answers the known answers: SHA-2, HMAC (RFC 4231), Ed25519 (RFC 8032)", async () => {
  const source = `async function main(i, kit) {
    const c = kit.crypto;
    return {
      sha256: await c.sha256("abc"),
      sha512: await c.sha512("abc", { as: "base64" }),
      hmac: await c.hmac({ key: { base64: i.hmac_key }, data: "Hi There" }),
      sig: await c.ed25519.sign({ private: i.seed, data: "" }),
      ok: await c.ed25519.verify({ public: i.pub, data: "", signature: await c.ed25519.sign({ private: i.seed, data: "" }) }),
      changed: await c.ed25519.verify({ public: i.pub, data: "x", signature: await c.ed25519.sign({ private: i.seed, data: "" }) }),
      random: await c.random(16),
      uuid: await c.uuid(),
      pair: await c.ed25519.keypair(),
    };
  }`;
  const seed = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
  const inputs = { hmac_key: Buffer.alloc(20, 0x0b).toString("base64"), seed: seed.toString("base64"), pub: Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex").toString("base64") };
  const r = (await ran("known", source, inputs)).result;
  assert.equal(r.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(r.sha512, crypto.createHash("sha512").update("abc").digest("base64"));
  assert.equal(r.hmac, "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
  assert.equal(Buffer.from(r.sig, "base64").toString("hex"), "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(Buffer.from(r.random, "base64").length, 16);
  assert.match(r.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(r.pair.line, lineOf(Buffer.from(r.pair.private, "base64")));
});

test("kit.crypto refuses what it can't take, as the script sees it", async () => {
  const source = `async function main(i, kit) {
    const said = [];
    for (const f of [() => kit.crypto.sha256(i.big), () => kit.crypto.random(5000), () => kit.crypto.hmac({ alg: "md5", key: "k", data: "d" }), () => kit.crypto.sha256(42), () => kit.crypto.ed25519.sign({ private: "short", data: "" })]) {
      try { await f(); said.push("no refusal"); } catch (e) { said.push(e.message); }
    }
    return said;
  }`;
  const r = (await ran("refusals", source, { big: "x".repeat(1024 * 1024 + 1) })).result;
  assert.deepEqual(r, ["data is at most 1024 KB", "random takes a number of bytes, 1 to 1024", "hmac's alg is sha256, sha512, sha1", "data is text, or { base64 }", "private is 32 bytes as base64"]);
});

test("kit.secret signs with a key the function never sees, in the key's namespace, and each use is recorded", { skip: !hasKeygen && "no ssh-keygen" }, async () => {
  const line = await makeKey("muse", "test-ns");
  const run = await ran("sign", `async function main(i, kit) {
    const out = await kit.secret.sign({ key: "muse", data: i.body });
    let unknown;
    try { await kit.secret.sign({ key: "nope", data: "x" }); } catch (e) { unknown = e.message; }
    return { ...out, pk: await kit.secret.publicKey({ key: "muse" }), kit: JSON.stringify(kit.secret), unknown };
  }`, { body: "Hello\n" });
  const r = run.result;
  assert.equal(r.public, line);
  assert.equal(r.namespace, "test-ns");
  assert.equal(r.pk.public, line);
  assert.match(r.pk.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.ok(keygenVerifies(line, "test-ns", "Hello\n", r.signature), "ssh-keygen takes it");
  assert.ok(!keygenVerifies(line, "other-ns", "Hello\n", r.signature), "in its own namespace only");
  assert.match(r.unknown, /^no signing key named "nope" is saved: the user makes or imports one on the Vault/);
  assert.deepEqual(run.signed, [{ key: "muse", namespace: "test-ns", fn: "signer.sign", bytes: 6 }]);
  assert.match(await call({ action: "run", run_id: run.id }), /\nSigned:\n- 6 bytes with the key "muse" in test-ns, by signer\.sign/);
  const seed = seedOf("muse");
  assert.ok(!everything().includes(seed), "the seed is in no run's record");
  assert.ok(!JSON.stringify(vaultState()).includes(seed), "nor on the Vault");
  assert.match(await call({ action: "library" }), new RegExp(`Signing keys \\(kit\\.secret\\.sign[^\\n]*\\n- muse: signs in test-ns, public key ${line.replace(/[+/]/g, "\\$&")} \\(SHA256:`));
});

test("a key signs in a scheduled job only when the user lets it", async () => {
  await makeKey("muse", "test-ns");
  const source = `async function main(i, kit) { return (await kit.secret.sign({ key: "muse", data: "x" })).namespace; }`;
  const refused = await ran("job", source, {}, true);
  assert.equal(refused.status, "error");
  assert.match(refused.error.message, /the signing key "muse" doesn't sign in a scheduled job: the user allows it on the Vault/);
  postVault({ ev: "signing-unattended", label: "muse", on: true });
  await call({ action: "library" });
  assert.equal(vaultState().signing[0].unattended, true);
  assert.equal((await ran("job", source, {}, true)).result, "test-ns");
  assert.equal((await ran("job", source, {}, false)).result, "test-ns", "and in a chat, as always");
});

test("a key signs at most 60 times a minute", async () => {
  await makeKey("muse", "test-ns");
  const run = await ran("many", `async function main(i, kit) {
    let n = 0;
    try { for (; n < 61; n++) await kit.secret.sign({ key: "muse", data: "x" }); } catch (e) { return { n, said: e.message }; }
    return { n };
  }`);
  assert.equal(run.result.n, 60);
  assert.match(run.result.said, /signed 60 times in the last minute/);
  assert.equal(run.signed.length, 60);
});

test("a key the temporary sshsig skill saved signs as it is", { skip: !hasKeygen && "no ssh-keygen" }, async () => {
  const seed = crypto.randomBytes(32);
  // As anythingllm-temp-skills' skills/sshsig/import-seed.mts writes it.
  await vault.update((v) => void v.entries.push({ id: vault.newId(), kind: "signing", site: "muse-coordination", user: "muse", algorithm: "ed25519", seed: seed.toString("base64") }));
  const r = (await ran("old", `async function main(i, kit) { return kit.secret.sign({ key: "muse", data: "Hi\\n" }); }`)).result;
  assert.equal(r.public, lineOf(seed));
  assert.ok(keygenVerifies(lineOf(seed), "muse-coordination", "Hi\n", r.signature));
});

test("on the Vault, the user makes, imports, lets into jobs and deletes signing keys; a name is one secret", async () => {
  await makeKey("muse", "test-ns");
  const seed = crypto.randomBytes(32);
  postVault({ ev: "signing-import", label: "other", namespace: "other-ns", sealed: seal(seed.toString("base64")) });
  postVault({ ev: "signing-new", label: "muse", namespace: "test-ns" }); // taken: refused, the first kept
  postVault({ ev: "signing-import", label: "bad", namespace: "test-ns", sealed: seal("not a seed") });
  postVault({ ev: "signing-new", label: "spaces in ns", namespace: "no good" });
  await call({ action: "library" });
  const shown = vaultState().signing;
  assert.deepEqual(shown.map((k: { label: string; namespace: string; unattended: boolean }) => [k.label, k.namespace, k.unattended]), [["muse", "test-ns", false], ["other", "other-ns", false]]);
  assert.equal(shown[1].public, lineOf(seed));
  assert.ok(!JSON.stringify(vaultState()).includes(seed.toString("base64")));

  assert.match(await call({ action: "secret", site: "api.example.com", label: "muse" }), /"muse" is a signing key already/);
  postVault({ ev: "key-save", label: "k", site: "api.example.com", sealed: seal("v") });
  postVault({ ev: "signing-new", label: "k", namespace: "test-ns" }); // a key's name: refused
  postVault({ ev: "signing-delete", label: "other" });
  await call({ action: "library" });
  assert.deepEqual(vaultState().signing.map((k: { label: string }) => k.label), ["muse"]);
  assert.deepEqual(vaultState().secrets.map((k: { label: string }) => k.label), ["k"]);
});

test("the sshsig-channel snippet signs to a peer and checks a peer's messages, as ssh-keygen does", { skip: !hasKeygen && "no ssh-keygen" }, async () => {
  const mine = await makeKey("muse", "test-ns");
  const peer = crypto.randomBytes(32);
  const stranger = crypto.randomBytes(32);
  const channel = { key: "muse", namespace: "test-ns", me: "me", public: mine, max_age_days: 3, peers: { peer: { key: lineOf(peer), confirmed: true }, shaky: { key: lineOf(stranger), confirmed: false } } };
  const snippet = fs.readFileSync(path.join(skillDir, "static", "snippets", "sshsig-channel.js"), "utf8");
  const source = snippet.replace(/const CHANNEL = \{[\s\S]*?\n\};/, `const CHANNEL = ${JSON.stringify(channel)};`);
  assert.notEqual(source, snippet);
  const inputs = { op: { type: "string", required: true }, to: { type: "string" }, text: { type: "string", required: true } };
  assert.match(await call({ action: "save", service: "chan", toolkit: { title: "A channel" }, function: { name: "channel", description: "Signs and checks.", inputs, source } }), /Saved chan\.channel/);
  await call({ action: "library" });
  post({ ev: "toolkit-lock", service: "chan" }); // as the snippet asks: the user reads it and locks it
  await call({ action: "library" });
  assert.equal(pageState().toolkits[0].locked, true);
  const result = async (input: Record<string, string>) => {
    const record = runRecord(idOf(await call({ action: "run", name: "chan.channel", inputs: input })));
    return record.status === "ok" ? record.result : `${record.error.name}: ${record.error.message}`;
  };

  const sent: string = await result({ op: "sign", to: "peer", text: "Reply text  \r\n" });
  assert.match(sent, /^Reply text\n\nSigned: me to peer at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n\n-----BEGIN SSH SIGNATURE-----\n/);
  const at = sent.indexOf("-----BEGIN SSH SIGNATURE-----");
  assert.ok(keygenVerifies(mine, "test-ns", sent.slice(0, at - 1), sent.slice(at)), "the peer's ssh-keygen takes it");
  assert.match(await result({ op: "sign", to: "[peer]", text: "Hi" }), /BAD-TAG/);

  const now = new Date().toISOString().slice(0, 19);
  const body = `From the peer.\n\nSigned: peer to me at ${now}Z\n`;
  const msg = `${body}\n${keygenSign(peer, "test-ns", body)}`;
  assert.equal(await result({ op: "verify", text: msg }), "result=VALID signer=peer key-confirmed=yes stamp=ok");
  assert.equal(await result({ op: "verify", text: `\n${msg.replace(/\n/g, " \r\n")}\r\n` }), "result=VALID signer=peer key-confirmed=yes stamp=ok", "as mail leaves it");
  assert.equal(await result({ op: "verify", text: msg.replace("From the peer.", "From someone.") }), "result=INVALID reason=bad-signature");
  assert.equal(await result({ op: "verify", text: "Just text." }), "result=UNSIGNED");
  assert.equal(await result({ op: "verify", text: msg.replace("-----END SSH SIGNATURE-----", "") }), "result=INVALID reason=bad-block");
  const shaky = `Hi\n\nSigned: shaky to me at ${now}Z\n`;
  assert.equal(await result({ op: "verify", text: `${shaky}\n${keygenSign(stranger, "test-ns", shaky)}` }), "result=VALID signer=shaky key-confirmed=no stamp=ok");
  assert.equal(await result({ op: "verify", text: `${body}\n${keygenSign(crypto.randomBytes(32), "test-ns", body)}` }), "result=INVALID reason=unknown-key");
  assert.equal(await result({ op: "verify", text: `${body}\n${keygenSign(peer, "other-ns", body)}` }), "result=INVALID reason=namespace-or-hash");
  const old = "Old.\n\nSigned: peer to me at 2020-01-01T00:00:00Z\n";
  assert.equal(await result({ op: "verify", text: `${old}\n${keygenSign(peer, "test-ns", old)}` }), "result=VALID signer=peer key-confirmed=yes stamp=bad");
  const bare = "No stamp here.\n";
  assert.equal(await result({ op: "verify", text: `${bare}\n${keygenSign(peer, "test-ns", bare)}` }), "result=VALID signer=peer key-confirmed=yes stamp=none");

  postVault({ ev: "signing-delete", label: "muse" });
  await call({ action: "library" });
  assert.match(await result({ op: "sign", to: "peer", text: "Hi" }), /KEY-MISSING: reply unsigned/);
});
