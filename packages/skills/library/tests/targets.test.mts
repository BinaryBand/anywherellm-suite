// Targets: machines the library's functions run commands on over SSH (src/targets.ts), against a
// stand-in machine, ssh2's own Server on 127.0.0.1, run here in the test. It accepts the one key it's
// told to, runs a few named commands, serves files over SFTP from memory (`files`), and can
// misbehave: show another host key, open channels toward the client, never end, stall a write. The built handler.js does the client's side, as AnythingLLM loads it.
// ssh2's server ignores a signal once the client has ended stdin, which OpenSSH's doesn't, so that
// TERM reaches a command is checked against a real sshd (tests/e2e), not here.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ssh2 from "ssh2";
import { THIS_HOST_FINGERPRINT, call as called, library, pageConfig, pageState, post, publicDir, reset, storage, until } from "./harness.mts";

const { Server, utils } = ssh2;

/** The stand-in machines are on 127.0.0.1 and 127.0.0.2, which the library refuses as this machine's
 *  own: the seam names them as not this machine (shared/thishost.mts). The tests of that refusal take
 *  it away for their length. */
const THISHOST_EXCEPT = Symbol.for("anywherellm-suite.thishost.except");
const THISHOST_RECORD = Symbol.for("anywherellm-suite.thishost.record");
const standIns = new Set(["127.0.0.1", "127.0.0.2"]);
(globalThis as unknown as Record<symbol, Set<string>>)[THISHOST_EXCEPT] = standIns;
const asThisMachine = async (fn: () => Promise<void>) => {
  const g = globalThis as unknown as Record<symbol, Set<string>>;
  g[THISHOST_EXCEPT] = new Set();
  try {
    await fn();
  } finally {
    g[THISHOST_EXCEPT] = standIns;
  }
};
const call = (args: Record<string, unknown>, slug: string | null = "work") => called(args, { slug });

/** The longest a target's sign-in may take (src/targets.ts LIMITS.connectMs to connect, and as long to sign in, plus a margin), and the
 *  longest looking at what it reaches may (LIMITS.checkMs): what the page and these tests wait for, on a machine as busy as it gets. */
const SIGN_IN_MS = 25_000;
const LOOK_MS = 30_000;

/** `text` sealed as the page seals it, with the vault's public key: RSA-OAEP up to 190 bytes, and
 *  above that with a new AES-GCM key, itself sealed with RSA ("h1.<sealed key>.<iv>.<sealed>"). */
function seal(text: string): string {
  const key = crypto.createPublicKey({ key: Buffer.from(pageConfig().pub, "base64"), format: "der", type: "spki" });
  const rsa = (bytes: Buffer) => crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, bytes).toString("base64");
  if (Buffer.byteLength(text) <= 190) return rsa(Buffer.from(text));
  const aes = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const gcm = crypto.createCipheriv("aes-256-gcm", aes, iv);
  const sealed = Buffer.concat([gcm.update(text), gcm.final(), gcm.getAuthTag()]);
  return ["h1", rsa(aes), iv.toString("base64"), sealed.toString("base64")].join(".");
}

const hostKey = utils.generateKeyPairSync("ed25519");
const otherHostKey = utils.generateKeyPairSync("ed25519");
const fingerprint = (pub: string) => `SHA256:${crypto.createHash("sha256").update(Buffer.from(pub.split(" ")[1], "base64")).digest("base64").replace(/=+$/, "")}`;

/** Misbehaviour of the stand-in's SFTP, by the path it concerns: removing it fails, and a rename to it
 *  is answered that many times before the next ones never are. */
const failRemove = new Set<string>();
const stallRenames = new Map<string, number>();

/** The stand-in's files, by path, as its SFTP keeps them. */
const files = new Map<string, { data: Buffer; mode: number }>();
/** Symbolic links among them: a path, and the file it leads to. */
const links = new Map<string, string>();

/** The SFTP requests a put and a get make, answered from `files`; a write to "stall.bin" is never
 *  answered. ssh2's server offers no posix-rename, so a put's move takes its fallback here. */
function serveFiles(sftp: ssh2.SFTPWrapper): void {
  const { STATUS_CODE: S, flagsToString } = utils.sftp;
  const open = new Map<string, { path: string; append: boolean }>();
  let n = 0;
  const of = (handle: Buffer) => open.get(handle.toString("hex"));
  const attrs = (f: { data: Buffer; mode: number }) => ({ size: f.data.length, mode: f.mode, uid: 0, gid: 0, atime: 0, mtime: 0 });
  sftp.on("OPEN", (id, path, flags) => {
    const how = flagsToString(flags) ?? "r";
    if (how.startsWith("r") && !files.has(path)) return sftp.status(id, S.NO_SUCH_FILE, "No such file");
    if (how.startsWith("w") || !files.has(path)) files.set(path, { data: Buffer.alloc(0), mode: 0o100644 });
    const handle = Buffer.from(String(++n));
    open.set(handle.toString("hex"), { path, append: how.startsWith("a") });
    sftp.handle(id, handle);
  });
  sftp.on("WRITE", (id, handle, offset, data) => {
    const h = of(handle)!;
    if (h.path.startsWith("stall.bin")) return; // never answered
    const f = files.get(h.path)!;
    const at = h.append ? f.data.length : offset;
    const grown = Buffer.alloc(Math.max(f.data.length, at + data.length));
    f.data.copy(grown);
    data.copy(grown, at);
    f.data = grown;
    sftp.status(id, S.OK);
  });
  sftp.on("READ", (id, handle, offset, length) => {
    const f = files.get(of(handle)!.path)!;
    if (offset >= f.data.length) return sftp.status(id, S.EOF);
    sftp.data(id, f.data.subarray(offset, offset + length));
  });
  sftp.on("CLOSE", (id, handle) => (open.delete(handle.toString("hex")), sftp.status(id, S.OK)));
  sftp.on("FSTAT", (id, handle) => sftp.attrs(id, attrs(files.get(of(handle)!.path)!)));
  sftp.on("STAT", (id, path) => {
    if (machine.sees && path.includes(".reach-marker-")) return sftp.attrs(id, attrs({ data: Buffer.from("x"), mode: 0o100600 }));
    const f = files.get(links.get(path) ?? path); // STAT follows a link
    return f ? sftp.attrs(id, attrs(f)) : sftp.status(id, S.NO_SUCH_FILE);
  });
  const setMode = (path: string, mode: number | undefined) => mode !== undefined && files.has(path) && (files.get(path)!.mode = mode);
  sftp.on("SETSTAT", (id, path, a) => (setMode(path, a.mode), sftp.status(id, S.OK)));
  sftp.on("FSETSTAT", (id, handle, a) => (setMode(of(handle)!.path, a.mode), sftp.status(id, S.OK)));
  sftp.on("REALPATH", (id, path) => {
    const real = links.get(path) ?? path;
    sftp.name(id, [{ filename: real, longname: real, attrs: {} as ssh2.Attributes }]);
  });
  sftp.on("REMOVE", (id, path) => sftp.status(id, failRemove.has(path) ? S.FAILURE : files.delete(path) ? S.OK : S.NO_SUCH_FILE));
  sftp.on("RENAME", (id, from, to) => {
    const left = stallRenames.get(to);
    if (left !== undefined) {
      if (left <= 0) return; // never answered
      stallRenames.set(to, left - 1);
    }
    if (!files.has(from) || files.has(to)) return sftp.status(id, S.FAILURE);
    files.set(to, files.get(from)!);
    files.delete(from);
    sftp.status(id, S.OK);
  });
}

/** What the stand-in is like to the reach check (src/targets.ts looked): whether it has curl or wget
 *  (tools), what a page it is asked to fetch answers, by address (serve: the body, or null when the
 *  address isn't reachable); its hostname and user; and whether it can see the marker file in the
 *  vault's folder. Its exec runs the library's fixed command in a real sh, with a curl that answers
 *  from `serve`, so the command itself (quoting, the token compared, the addresses tried together) is tested. */
const machine = { tools: true, serve: (_u: URL): string | null => null, hostname: "vm-1", uid: "1001", sees: false };
/** What AnythingLLM itself serves at an address: the file the library put in its public folder. */
const pageOf = (u: URL): string | null => (fs.existsSync(path.join(publicDir, u.pathname)) ? fs.readFileSync(path.join(publicDir, u.pathname), "utf8") : null);

const shims = fs.mkdtempSync(path.join(os.tmpdir(), "targets-shims-"));
fs.mkdirSync(path.join(shims, "bin"));
fs.mkdirSync(path.join(shims, "empty"));
fs.symlinkSync("/bin/sh", path.join(shims, "empty", "sh")); // the fixed command starts another sh, and nothing else is found
fs.writeFileSync(path.join(shims, "bin", "curl"), '#!/bin/sh\nfor a; do u="$a"; done\nf="$ANSWERS/$(printf %s "$u" | sed \'s#[^A-Za-z0-9]#_#g\')"\n[ -f "$f" ] && cat "$f" || exit 7\n', { mode: 0o755 });
test.after(() => fs.rmSync(shims, { recursive: true, force: true }));
/** Runs a fixed reach command as the machine's shell would, its curl answering from `machine.serve`. */
function runReach(command: string, urls: string[]): Promise<{ out: string; code: number }> {
  const answers = fs.mkdtempSync(path.join(shims, "answers-"));
  for (const u of urls) {
    const body = machine.serve(new URL(u));
    if (body !== null) fs.writeFileSync(path.join(answers, u.replace(/[^A-Za-z0-9]/g, "_")), body);
  }
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { env: { PATH: machine.tools ? `${path.join(shims, "bin")}:/usr/bin:/bin` : path.join(shims, "empty"), ANSWERS: answers } });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.on("close", (code) => resolve({ out, code: code ?? -1 }));
  });
}

/** What the stand-in saw, for the tests to check: sign-ins tried, naps going at once, channels
 *  refused, hung commands started, and their connections closed. */
const seen = { auths: 0, open: 0, most: 0, refused: [] as string[], hung: 0, closed: 0, execs: 0, unanswered: 0, authDelay: 0, fetched: [] as string[] };
let allowed: ssh2.ParsedKey | null = null;

const standIn = (key: string) =>
  new Server({ hostKeys: [key] }, (client) => {
    client.on("error", () => {}); // a client that hangs up mid-handshake, as one refusing the host key does
    client.on("authentication", (ctx) => {
      seen.auths++;
      if (ctx.method !== "publickey" || !allowed || ctx.key.algo !== allowed.type || !ctx.key.data.equals(allowed.getPublicSSH())) return ctx.reject(["publickey"]);
      if (ctx.signature && !allowed.verify(ctx.blob!, ctx.signature, ctx.hashAlgo)) return ctx.reject(["publickey"]);
      if (ctx.signature && seen.authDelay) return void setTimeout(() => ctx.accept(), seen.authDelay);
      ctx.accept();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("sftp", (acceptSftp) => {
          serveFiles(acceptSftp());
          client.on("close", () => seen.closed++);
        });
        session.on("exec", (acceptExec, _reject, info) => {
          const command = info.command;
          seen.execs++;
          if (command === "unanswered") return void seen.unanswered++; // neither accepted nor refused
          const s = acceptExec();
          const done = (code: number) => (s.exit(code), s.end());
          if (command.startsWith("sh -c ") && command.includes("library-lean/reach-")) {
            // The fixed command that asks the machine to fetch a page of AnythingLLM from each address it may be at.
            const urls = [...command.matchAll(/https?:\/\/[^'\s\\]+/g)].map((m) => m[0]);
            seen.fetched.push(...urls);
            return void runReach(command, urls).then(({ out, code }) => (s.write(out), done(code)));
          }
          if (command === "hostname; id -u") return s.write(`${machine.hostname}\n${machine.uid}\n`), done(0);
          if (command === "echo hi") return s.write("hi\n"), done(0);
          if (command === "fail") return s.stderr.write("no such thing\n"), done(3);
          if (command === "cat") {
            let got = "";
            s.on("data", (d: Buffer) => (got += d));
            return s.on("end", () => (s.write(got.toUpperCase()), done(0)));
          }
          if (command === "big") return s.write("x".repeat(300 * 1024)), s.stderr.write("y".repeat(10)), done(0);
          if (command === "huge") return s.write("x".repeat(1536 * 1024)), done(0);
          if (command === "nap") return void (seen.open++, (seen.most = Math.max(seen.most, seen.open)), setTimeout(() => (seen.open--, done(0)), 300));
          if (command === "open channels") {
            const tries: [string, (cb: (err: Error | undefined) => void) => void][] = [
              ["forwarded-tcpip", (cb) => client.forwardOut("127.0.0.1", 3001, "127.0.0.1", 50000, (err) => cb(err))],
              ["x11", (cb) => client.x11("127.0.0.1", 6000, (err) => cb(err))],
            ];
            let left = tries.length;
            for (const [name, open] of tries) open((err) => (err && seen.refused.push(name), --left || (s.write("tried\n"), done(0))));
            return;
          }
          if (command === "hang") return void (seen.hung++, client.on("close", () => seen.closed++)); // never ends
        });
      });
    });
  });

const server = standIn(hostKey.private);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const PORT = (server.address() as AddressInfo).port;
const imposter = standIn(otherHostKey.private);
await new Promise<void>((resolve) => imposter.listen(0, "127.0.0.1", resolve));
test.after(() => (server.close(), imposter.close()));

const boxState = () => pageState().targets.find((t: { label: string }) => t.label === "box");

/** Registers the target "box" on the page as the user does, with a key made there unless one is
 *  pasted, and lets the stand-in accept that key, as adding its line to authorized_keys does; waits
 *  for the sign-in the page tries after a save. */
async function register(fields: Record<string, unknown> = {}, pasted?: { private: string; public: string }, base?: string) {
  await call({ action: "secret", kind: "ssh", label: "box" });
  if (pasted) allowed = utils.parseKey(pasted.public) as ssh2.ParsedKey;
  post({ secret: pageConfig().secret, ev: "target-save", label: "box", host: "127.0.0.1", port: PORT, login: "sandbox", fingerprint: fingerprint(hostKey.public), private: true, sealed: pasted ? seal(pasted.private) : "", ...fields });
  await called({ action: "library" }, { slug: "work", base });
  await until(() => boxState().status !== "not tried yet", SIGN_IN_MS);
  const saved = boxState();
  if (saved.public) allowed = utils.parseKey(saved.public) as ssh2.ParsedKey;
  return saved;
}

/** A toolkit "ops" on the target "box", with a function that sends kit.ssh.exec what it's given. */
async function ops() {
  const source = "async function main(input, kit) { return await kit.ssh.exec(Object.assign({ target: 'box' }, input.req)); }";
  const said = await call({ action: "save", service: "ops", toolkit: { title: "Ops", targets: ["box"] }, function: { name: "run", description: "Runs a command.", inputs: { req: { type: "object", required: true } }, source } });
  assert.match(said, /Saved the toolkit ops: target box; keys: none\.\nSaved ops\.run, version 1/);
}

const result = (said: string) => JSON.parse(said.match(/Result \(JSON\):\n([\s\S]*?)\n\n/)![1]);

test.beforeEach(() => {
  reset();
  Object.assign(seen, { auths: 0, open: 0, most: 0, refused: [], hung: 0, closed: 0, execs: 0, unanswered: 0, authDelay: 0, fetched: [] });
  Object.assign(machine, { tools: true, serve: () => null, hostname: "vm-1", uid: "1001", sees: false });
  (globalThis as unknown as Record<symbol, unknown>)[THISHOST_RECORD] = { fingerprints: [THIS_HOST_FINGERPRINT], addresses: [] };
  failRemove.clear();
  stallRenames.clear();
  files.clear();
  links.clear();
  allowed = null;
  delete process.env.LIBRARY_WAIT_MS;
  delete process.env.LIBRARY_RUN_MS;
});

test("a target is asked for and registered on the page, with a key made there whose private half nobody is shown", async () => {
  const asked = await call({ action: "secret", kind: "ssh", label: "box" });
  assert.match(asked, /^The user registers the target "box" on the Library page, under Targets: \/library-lean\/[\w-]+\.html\n/);
  assert.deepEqual(pageState().needs, [{ label: "box", site: "" }]);
  const box = await register();
  assert.match(box.public, /^ssh-ed25519 AAAA\S+ library-lean box$/);
  assert.equal(box.status, "the target \"box\" refused its key: the public line goes in ~sandbox/.ssh/authorized_keys on the machine (the Library page shows it)", "tried at once, before its line was added");
  assert.deepEqual(pageState().needs, [], "the need is met");
  post({ secret: pageConfig().secret, ev: "target-check", label: "box" });
  await call({ action: "library" });
  await until(() => boxState().status === "signed in", SIGN_IN_MS);
  const vaultText = fs.readFileSync(path.join(storage, "vault-lean", "vault.json"), "utf8");
  assert.ok(!vaultText.includes("PRIVATE KEY") && !vaultText.includes("sandbox"), "the vault holds it encrypted");
  assert.ok(!JSON.stringify(pageState()).includes("PRIVATE KEY"), "the page never shows the private half");
  await ops();
  const listed = await call({ action: "library", service: "ops" });
  assert.match(listed, /Targets: box \(sandbox@127\.0\.0\.1:\d+, signed in\)/);
  assert.ok(!listed.includes("PRIVATE KEY"));
});

test("a pasted key signs in; a key that isn't one, a missing fingerprint or an unticked private address isn't saved", async () => {
  const mine = utils.generateKeyPairSync("ed25519");
  const box = await register({}, mine);
  assert.equal(box.public, null, "a pasted key's public half is the user's own");
  assert.equal(box.status, "signed in");
  // Not a key; no fingerprint; a private address not ticked "on my network", though FENCE_ALLOW names it.
  for (const fields of [{ sealed: seal("not a key") }, { fingerprint: "" }, { private: false }]) post({ secret: pageConfig().secret, ev: "target-save", label: "bad", host: "127.0.0.1", port: PORT, login: "sandbox", fingerprint: fingerprint(hostKey.public), private: true, ...fields });
  await call({ action: "library" });
  assert.deepEqual(pageState().targets.map((t: { label: string }) => t.label), ["box"], "none of them was saved");
});

test("a function runs a command on its toolkit's target: its exit, output and error, and its stdin", async () => {
  await register();
  await ops();
  const hi = await call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } });
  assert.match(hi, /^Ran ops\.run \(r-[\w-]+\): ok, [\d.]+ s, 1 request\./);
  assert.match(hi, /- SSH box \$ \(7 characters\): 0 \(\d+ ms\)/);
  assert.deepEqual({ ...result(hi), ms: 0 }, { exit: 0, signal: null, stdout: "hi\n", stderr: "", truncated: false, killed: null, remote_may_run: false, ms: 0 });
  const failed = result(await call({ action: "run", name: "ops.run", inputs: { req: { command: "fail" } } }));
  assert.deepEqual([failed.exit, failed.stderr], [3, "no such thing\n"]);
  await call({ action: "save", service: "ops", function: { name: "shout", description: "Upper-cases its input on the machine.", source: "async function main(input, kit) { return (await kit.ssh.exec({ target: 'box', command: 'cat', stdin: 'quiet' })).stdout; }" } });
  assert.match(await call({ action: "run", name: "ops.shout", inputs: {} }), /Result \(JSON\):\n"QUIET"/);
});

test("a function names a target and nothing else of it: a host, a key or a target its toolkit lacks is refused", async () => {
  await register();
  await ops();
  seen.auths = 0;
  for (const field of ["host", "port", "user", "privateKey", "password", "fingerprint"]) {
    const said = await call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi", [field]: "x" } } });
    assert.match(said, new RegExp(`kit\\.ssh\\.exec takes target, command, stdin, timeout_s, max_bytes, not ${field}: a target's host, port, login, key and fingerprint are the user's`), field);
  }
  assert.equal(seen.auths, 0, "nothing reached the machine");
  await call({ action: "save", service: "ops", function: { name: "elsewhere", description: "Another target.", source: "async function main(i, kit) { return kit.ssh.exec({ target: 'prod', command: 'echo hi' }); }" } });
  assert.match(await call({ action: "run", name: "ops.elsewhere", inputs: {} }), /"prod" isn't one of the ops toolkit's targets \(box\)/);
  await call({ action: "save", service: "ops", toolkit: { targets: ["box", "prod"] } });
  assert.match(await call({ action: "run", name: "ops.elsewhere", inputs: {} }), /no target "prod" is saved: ask the user for it with secret, kind "ssh"/);
});

test("a host key other than the one pinned is refused before signing in, and nothing is sent", async () => {
  await register({ port: (imposter.address() as AddressInfo).port });
  await ops();
  seen.auths = 0;
  const said = await call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } });
  assert.match(said, new RegExp(`showed a host key that isn't the one saved for it \\(saved ${fingerprint(hostKey.public).replace(/[+/]/g, "\\$&")}, shown ${fingerprint(otherHostKey.public).replace(/[+/]/g, "\\$&")}\\): nothing was sent`));
  assert.equal(seen.auths, 0, "no sign-in was tried");
});

test("output past its cap is cut, and a command past its time is stopped and said to be maybe still going", async () => {
  await register();
  await ops();
  const big = result(await call({ action: "run", name: "ops.run", inputs: { req: { command: "big", max_bytes: 1000 } } }));
  assert.deepEqual([big.stdout.length, big.stderr, big.truncated], [1000, "yyyyyyyyyy", true]);
  const hung = result(await call({ action: "run", name: "ops.run", inputs: { req: { command: "hang", timeout_s: 1 } } }));
  assert.deepEqual([hung.killed, hung.exit, hung.remote_may_run], ["timeout", null, true], "TERM, then its channel closed 2 s later, with no exit status from the machine");
  assert.ok(hung.ms >= 3000 && hung.ms < 4500, `${hung.ms} ms`);
  await until(() => seen.closed === 1);
});

test("a stopped run stops the command it's waiting on", async () => {
  await register();
  await ops();
  process.env.LIBRARY_WAIT_MS = "300";
  const started = await call({ action: "run", name: "ops.run", inputs: { req: { command: "hang", timeout_s: 60 } } });
  const id = started.match(/\((r-[\w-]+)\)/)![1];
  await until(() => seen.hung > 0);
  assert.match(await call({ action: "run", run_id: id, stop: true }), /ops\.run.*stopped/);
  await until(() => seen.closed === 1);
});

test("channels the machine opens toward the library (a remote forward, X11) are refused", async () => {
  await register();
  await ops();
  assert.match(await call({ action: "run", name: "ops.run", inputs: { req: { command: "open channels" } } }), /"stdout": "tried\\n"/);
  assert.deepEqual(seen.refused.sort(), ["forwarded-tcpip", "x11"]);
});

test("scheduled jobs use a target only when the user ticked it, and a target takes 4 commands at once", async () => {
  await register();
  await ops();
  assert.match(await call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } }, null), /scheduled jobs don't use the target "box": the user ticks "May run unattended"/);
  await register({ unattended: true });
  assert.match(await call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } }, null), /"stdout": "hi\\n"/);
  const naps = await Promise.all(Array.from({ length: 6 }, () => call({ action: "run", name: "ops.run", inputs: { req: { command: "nap" } } })));
  for (const n of naps) assert.match(n, /"exit": 0/);
  assert.equal(seen.most, 4, `${seen.most} at once: 4 is the limit, and 6 asked`);
});

test("the ssh2 internals term() sends TERM through are where it reaches for them, on an ended channel", async () => {
  const client = new ssh2.Client();
  allowed = utils.parseKey(hostKey.public) as ssh2.ParsedKey; // any key the stand-in knows: here, its own
  await new Promise<void>((resolve, reject) => client.once("ready", resolve).once("error", reject).connect({ host: "127.0.0.1", port: PORT, username: "x", privateKey: hostKey.private, hostVerifier: () => true }));
  const stream = await new Promise<ssh2.ClientChannel>((resolve, reject) => client.exec("hang", (err, s) => (err ? reject(err) : resolve(s))));
  stream.end();
  const channel = stream as unknown as { outgoing: { id: number; state: string }; _client: { _protocol: { signal: unknown } } };
  assert.equal(channel.outgoing.state, "eof");
  assert.equal(typeof channel.outgoing.id, "number");
  assert.equal(typeof channel._client._protocol.signal, "function");
  client.end();
});

/** A function "file" that makes one kit.ssh call (input.call: "put" or "get") and answers what it got,
 *  a long content as its length. */
async function fileFn() {
  const source = "async function main(input, kit) { const out = await kit.ssh[input.call](Object.assign({ target: 'box' }, input.req)); return out.content && out.content.length > 2000 ? Object.assign({}, out, { content: out.content.length + ' characters' }) : out; }";
  await call({ action: "save", service: "ops", function: { name: "file", description: "Moves a file.", inputs: { call: { type: "string", required: true }, req: { type: "object", required: true } }, source } });
}
const file = async (callName: string, req: Record<string, unknown>) => result(await call({ action: "run", name: "ops.file", inputs: { call: callName, req } }));
const hex = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

test("a file is put on the target and got back, as text or, for bytes, as base64, with its sha256", async () => {
  await register();
  await ops();
  await fileFn();
  const text = "name,score\nada,3\n";
  assert.deepEqual(await file("put", { path: "~/scores.csv", content: text, mode: "600" }), { path: "scores.csv", size: text.length, sha256: hex(Buffer.from(text)) });
  assert.equal(files.get("scores.csv")!.mode & 0o777, 0o600);
  assert.deepEqual([...files.keys()], ["scores.csv"], "the part file it was written to was moved over the path");
  assert.deepEqual(await file("get", { path: "scores.csv" }), { content: text, encoding: "utf8", size: text.length, sha256: hex(Buffer.from(text)), eof: true });
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  assert.equal((await file("put", { path: "all.bin", content: bytes.toString("base64"), encoding: "base64" })).sha256, hex(bytes));
  assert.deepEqual(files.get("all.bin")!.data, bytes);
  const got = await file("get", { path: "all.bin" });
  assert.deepEqual([got.encoding, got.content, got.sha256], ["base64", bytes.toString("base64"), hex(bytes)], "not UTF-8, so base64");
  assert.match(await call({ action: "run", name: "ops.file", inputs: { call: "get", req: { path: "scores.csv" } } }), /- SSH box get scores\.csv: 0 \(\d+ ms\)/);
});

test("a file bigger than a call goes in parts: put whole then appended, read back by offset to eof", async () => {
  await register();
  await ops();
  const source = `async function main(input, kit) {
    const box = { target: "box", path: "big.txt" };
    await kit.ssh.put(Object.assign({ content: "a".repeat(1024 * 1024) }, box));
    const end = await kit.ssh.put(Object.assign({ content: "b".repeat(512 * 1024), append: true }, box));
    const one = await kit.ssh.get(box);
    const two = await kit.ssh.get(Object.assign({ offset: one.content.length }, box));
    return { size: end.size, one: [one.content.length, one.eof], two: [two.content.length, two.eof, two.content[0]] };
  }`;
  await call({ action: "save", service: "ops", function: { name: "big", description: "A big file.", source } });
  assert.deepEqual(result(await call({ action: "run", name: "ops.big", inputs: {} })), { size: 1.5 * 1024 * 1024, one: [1024 * 1024, false], two: [512 * 1024, true, "b"] });
});

test("a file put over another keeps its mode unless one is given, and a symbolic link stays one", async () => {
  await register();
  await ops();
  await fileFn();
  await file("put", { path: "run.sh", content: "#!/bin/sh\n", mode: "755" });
  await file("put", { path: "run.sh", content: "#!/bin/sh\necho 2\n" });
  assert.equal(files.get("run.sh")!.mode & 0o7777, 0o755, "kept");
  await file("put", { path: "run.sh", content: "#!/bin/sh\necho 3\n", mode: "600" });
  assert.equal(files.get("run.sh")!.mode & 0o7777, 0o600, "changed when given");
  files.set("real.txt", { data: Buffer.from("old"), mode: 0o100640 });
  links.set("link.txt", "real.txt");
  await file("put", { path: "link.txt", content: "new" });
  assert.deepEqual([...files.keys()].sort(), ["real.txt", "run.sh"], "no file took the link's place");
  assert.equal(files.get("real.txt")!.data.toString(), "new");
  assert.equal(files.get("real.txt")!.mode & 0o7777, 0o640);
});

test("a text file read in pages gives text in every page, each ending on a character", async () => {
  await register();
  await ops();
  await fileFn();
  files.set("utf.txt", { data: Buffer.from("éééé"), mode: 0o100644 }); // 8 bytes
  const first = await file("get", { path: "utf.txt", bytes: 3 });
  assert.deepEqual([first.content, first.encoding, first.eof], ["é", "utf8", false], "cut before the half of a character");
  const second = await file("get", { path: "utf.txt", offset: Buffer.byteLength(first.content), bytes: 3 });
  assert.deepEqual([second.content, second.encoding], ["é", "utf8"]);
  const rest = await file("get", { path: "utf.txt", offset: 4, bytes: 100 });
  assert.deepEqual([rest.content, rest.eof], ["éé", true]);
});

test("over 1 MB in one call, or a field of its own, is refused before anything is written", async () => {
  await register();
  await ops();
  await fileFn();
  const source = "async function main(i, kit) { return kit.ssh.put({ target: 'box', path: 'huge.txt', content: 'x'.repeat(1024 * 1024 + 1) }); }";
  await call({ action: "save", service: "ops", function: { name: "huge", description: "Too big.", source } });
  assert.match(await call({ action: "run", name: "ops.huge", inputs: {} }), /kit\.ssh\.put writes at most 1 MB a call: send a bigger file in parts/);
  assert.match(await call({ action: "run", name: "ops.file", inputs: { call: "put", req: { path: "x", content: "y", host: "elsewhere" } } }), /kit\.ssh\.put takes target, path, content, encoding, mode, append, not host/);
  assert.match(await call({ action: "run", name: "ops.file", inputs: { call: "get", req: { path: "x", key: "k" } } }), /kit\.ssh\.get takes target, path, offset, bytes, encoding, not key/);
  assert.deepEqual([...files.keys()], []);
});

test("a stopped run ends the transfer it's waiting on, and leaves no part file behind it in view", async () => {
  await register();
  await ops();
  await fileFn();
  process.env.LIBRARY_WAIT_MS = "300";
  const started = await call({ action: "run", name: "ops.file", inputs: { call: "put", req: { path: "stall.bin", content: "z" } } });
  const id = started.match(/\((r-[\w-]+)\)/)![1];
  await until(() => [...files.keys()].some((k) => k.startsWith("stall.bin.part-")));
  seen.closed = 0;
  assert.match(await call({ action: "run", run_id: id, stop: true }), /ops\.file.*stopped/);
  await until(() => seen.closed === 1);
  assert.ok(!files.has("stall.bin"), "nothing was moved into place");
  await until(() => ![...files.keys()].some((k) => k.startsWith("stall.bin.part-")), 10_000); // removed over a connection of its own
});

test("the user deletes a target on the page, and with it its key", async () => {
  await register();
  post({ secret: pageConfig().secret, ev: "target-delete", label: "box" });
  await call({ action: "library" });
  assert.deepEqual(pageState().targets, []);
});

/** Runs the "ops.run" function on the target, as the agent does, with `req` for kit.ssh.exec. */
const exec = (req: Record<string, unknown>) => call({ action: "run", name: "ops.run", inputs: { req } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a machine that never answers the request to run a command ends at the command's time, and frees its slot and connection", async () => {
  await register();
  await ops();
  process.env.LIBRARY_WAIT_MS = "4000"; // a call that doesn't end shows as "still running", which result() refuses
  for (let i = 0; i < 5; i++) {
    const ran = result(await exec({ command: "unanswered", timeout_s: 1 }));
    assert.deepEqual([ran.killed, ran.exit, ran.remote_may_run], ["timeout", null, true], "the machine may still run it");
    assert.ok(ran.ms >= 900 && ran.ms < 2500, `${ran.ms} ms`);
  }
  assert.equal(seen.unanswered, 5, "more than the 4 slots a target has: none was kept");
  assert.match(await exec({ command: "echo hi" }), /"stdout": "hi\\n"/);
});

test("a stopped run frees the slot of a command the machine never answered", async () => {
  await register();
  await ops();
  process.env.LIBRARY_WAIT_MS = "300";
  for (let i = 1; i <= 4; i++) {
    const id = (await exec({ command: "unanswered", timeout_s: 60 })).match(/\((r-[\w-]+)\)/)![1];
    await until(() => seen.unanswered === i);
    assert.match(await call({ action: "run", run_id: id, stop: true }), /ops\.run.*stopped/);
  }
  process.env.LIBRARY_WAIT_MS = "4000";
  assert.match(await exec({ command: "echo hi" }), /"stdout": "hi\\n"/, "the 4 stopped ones kept no slot");
});

test("nothing is sent to the machine once the command's time is up, even when signing in took it", async () => {
  await register();
  await ops();
  seen.execs = 0;
  seen.authDelay = 500; // signing in takes longer than the 0.2 s the command has
  const said = await exec({ command: "echo hi", timeout_s: 0.2 });
  assert.match(said, /signing in/);
  await sleep(700);
  assert.equal(seen.execs, 0, "the command never reached the machine");
  seen.authDelay = 0;
  seen.execs = 0;
  assert.match(await exec({ command: "echo hi", timeout_s: 0.001 }), /in time|"killed": "timeout"|didn't finish signing in within/);
  assert.equal(seen.execs, 0, "a time that is up before the first try sends nothing");
});

test("an upload cut off after it removed the file it replaces keeps the new content, on a server without posix-rename", async () => {
  await register();
  await ops();
  await fileFn();
  files.set("keep.txt", { data: Buffer.from("old"), mode: 0o100644 });
  stallRenames.set("keep.txt", 1); // the first rename is refused (the file is there), the one after the remove never answered
  process.env.LIBRARY_WAIT_MS = "300";
  const id = (await call({ action: "run", name: "ops.file", inputs: { call: "put", req: { path: "keep.txt", content: "new" } } })).match(/\((r-[\w-]+)\)/)![1];
  await until(() => !files.has("keep.txt") && [...files.keys()].some((k) => k.startsWith("keep.txt.part-")));
  assert.match(await call({ action: "run", run_id: id, stop: true }), /ops\.file.*stopped/);
  await sleep(1500); // time for the clean-up connection a cut-off upload opens
  const part = [...files.keys()].filter((k) => k.startsWith("keep.txt.part-"));
  assert.equal(part.length, 1, "the part file is kept: it holds the only copy");
  assert.equal(files.get(part[0])!.data.toString(), "new");
});

test("an upload cut off after its remove failed leaves the old file and no part file", async () => {
  await register();
  await ops();
  await fileFn();
  files.set("stay.txt", { data: Buffer.from("old"), mode: 0o100644 });
  failRemove.add("stay.txt");
  stallRenames.set("stay.txt", 1);
  process.env.LIBRARY_WAIT_MS = "300";
  const id = (await call({ action: "run", name: "ops.file", inputs: { call: "put", req: { path: "stay.txt", content: "new" } } })).match(/\((r-[\w-]+)\)/)![1];
  await until(() => [...files.keys()].some((k) => k.startsWith("stay.txt.part-")));
  await sleep(300); // past the failed remove, at the rename that never answers
  assert.match(await call({ action: "run", run_id: id, stop: true }), /ops\.file.*stopped/);
  await until(() => ![...files.keys()].some((k) => k.startsWith("stay.txt.part-")), 10_000);
  assert.equal(files.get("stay.txt")!.data.toString(), "old", "nothing was lost, so nothing is kept");
});

test("a name that resolves to a private address is refused unless the target is ticked, FENCE_ALLOW naming it or not", async () => {
  const lookup = dns.lookup;
  const allow = process.env.FENCE_ALLOW;
  process.env.FENCE_ALLOW = "127.0.0.1,box.example";
  dns.lookup = ((host: string, options: unknown, cb: (...a: unknown[]) => void) => (host === "box.example" ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : (lookup as (...a: unknown[]) => void)(host, options, cb))) as typeof dns.lookup;
  try {
    const refused = await register({ host: "box.example", private: false });
    assert.match(refused.status, /box\.example resolves to 127\.0\.0\.1, which isn't a public address/);
    assert.equal(seen.auths, 0, "no sign-in was tried");
    const ticked = await register({ host: "box.example", private: true });
    assert.equal(ticked.status, "signed in", "the tick is what lets it through, at its own host and port");
  } finally {
    dns.lookup = lookup;
    process.env.FENCE_ALLOW = allow;
  }
});

test("a target takes 60 uses a minute, a sign-in the page tried among them", async () => {
  await register(); // its sign-in was the first use
  const source = `async function main(input, kit) {
    let ok = 0;
    let error = null;
    for (let i = 0; i < 16; i++) {
      const got = await Promise.all([0, 1, 2, 3].map(() => kit.ssh.exec({ target: "box", command: "echo hi" }).then(() => 1, (e) => ((error = error || String(e.message || e)), 0))));
      ok += got.reduce((a, b) => a + b, 0);
    }
    return { ok, error };
  }`;
  await call({ action: "save", service: "ops", toolkit: { title: "Ops", targets: ["box"] }, function: { name: "many", description: "Many commands.", source } });
  const out = result(await call({ action: "run", name: "ops.many", inputs: {} }));
  assert.equal(out.ok, 59, "64 asked: 59 and the page's sign-in make the 60");
  assert.match(out.error, /the target "box" was used 60 times in the last minute/);
});

test("output and time are clamped, and what can't be one is refused before anything is sent", async () => {
  await register();
  await ops();
  await call({ action: "save", service: "ops", function: { name: "measure", description: "How much output a command gave.", inputs: { req: { type: "object", required: true } }, source: "async function main(input, kit) { const r = await kit.ssh.exec(Object.assign({ target: 'box' }, input.req)); return { length: r.stdout.length, truncated: r.truncated }; }" } });
  const measure = async (req: Record<string, unknown>) => result(await call({ action: "run", name: "ops.measure", inputs: { req } }));
  assert.deepEqual(await measure({ command: "huge", max_bytes: 5_000_000 }), { length: 1024 * 1024, truncated: true }, "1 MB at most");
  assert.deepEqual(await measure({ command: "big" }), { length: 256 * 1024, truncated: true }, "256 KB by default");
  process.env.LIBRARY_RUN_MS = "2500";
  const ended = await exec({ command: "hang", timeout_s: 300 }); // never past the run's own end
  assert.match(ended, /ran past its time and was stopped/, "the run's own end, not the 300 s");
  assert.ok(seen.hung >= 1);
  delete process.env.LIBRARY_RUN_MS;
  seen.execs = 0;
  for (const [req, said] of [
    [{ command: "echo hi", timeout_s: 0 }, /timeout_s is a positive number/],
    [{ command: "echo hi", timeout_s: "soon" }, /timeout_s is a positive number/],
    [{ command: "echo hi", max_bytes: -1 }, /max_bytes is a positive number/],
    [{ command: "x".repeat(32 * 1024 + 1) }, /at most 32768 characters/],
    [{ command: "echo\0hi" }, /kit\.ssh\.exec needs command/],
    [{ command: "  " }, /kit\.ssh\.exec needs command/],
    [{ command: "cat", stdin: "x".repeat(1024 * 1024 + 1) }, /stdin is at most 1 MB/],
    [{ command: "cat", stdin: 5 }, /stdin is text/],
  ] as [Record<string, unknown>, RegExp][]) assert.match(await exec(req), said, JSON.stringify(req).slice(0, 60));
  assert.equal(seen.execs, 0, "none of them reached the machine");
});

test("a transfer that runs past its time is ended and its part file removed", async () => {
  await register();
  await ops();
  await fileFn();
  process.env.LIBRARY_RUN_MS = "2500";
  process.env.LIBRARY_WAIT_MS = "6000";
  const said = await call({ action: "run", name: "ops.file", inputs: { call: "put", req: { path: "stall.bin", content: "z" } } });
  assert.match(said, /ran past its time and was stopped/, "the run's own end is the transfer's");
  await until(() => ![...files.keys()].some((k) => k.startsWith("stall.bin.part-")), 10_000);
});

test("a pasted private key is in no run record, log, page or vault file", async () => {
  const mine = utils.generateKeyPairSync("ed25519");
  const body = mine.private.split("\n").filter((l) => l && !l.startsWith("-----"))[0];
  await register({}, mine);
  await ops();
  await fileFn();
  await exec({ command: "echo hi" });
  await exec({ command: "fail" });
  await file("put", { path: "a.txt", content: "x" });
  await call({ action: "library", service: "ops" });
  const seenIn: string[] = [];
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, f.name);
      if (f.isDirectory()) walk(at);
      else if (fs.readFileSync(at, "utf8").includes(body)) seenIn.push(at);
    }
  };
  walk(storage);
  walk(path.dirname(path.join(storage, "..", "public")));
  assert.deepEqual(seenIn, [], "the key is nowhere in the clear");
});

test("moving a target to another host, port or account drops its key; an edit that stays put keeps it", async () => {
  const first = await register();
  const edit = async (fields: Record<string, unknown>) => {
    const n = pageState().result?.n ?? 0;
    post({ secret: pageConfig().secret, ev: "target-save", label: "box", host: "127.0.0.1", port: PORT, login: "sandbox", fingerprint: fingerprint(hostKey.public), private: true, sealed: "", ...fields });
    await call({ action: "library" });
    await until(() => (pageState().result?.n ?? 0) > n);
    await until(() => boxState().status !== "not tried yet", SIGN_IN_MS);
    return boxState();
  };
  const same = await edit({ unattended: true, fingerprint: fingerprint(otherHostKey.public) });
  assert.equal(same.public, first.public, "ticks and the fingerprint change, the key stays");
  for (const moved of [{ host: "127.0.0.2" }, { port: PORT + 1 }, { login: "other" }]) {
    const was = boxState().public;
    const now = await edit(moved);
    assert.match(now.public, /^ssh-ed25519 AAAA\S+ library-lean box$/);
    assert.notEqual(now.public, was, `${JSON.stringify(moved)}: a new key is made, whose line goes in the new account's authorized_keys`);
    await edit({ host: "127.0.0.1", port: PORT, login: "sandbox" });
  }
});

test("a target can't be this machine, however it is ticked: a literal address, a name, or a name that answers otherwise at connect time", async () => {
  await call({ action: "secret", kind: "ssh", label: "box" }); // makes the page
  await asThisMachine(async () => {
    const saved = () => pageState().targets.map((t: { label: string }) => t.label);
    const refusal = async (label: string, host: string) => {
      const n = pageState().result?.n ?? 0;
      post({ secret: pageConfig().secret, ev: "target-save", label, host, port: PORT, login: "sandbox", fingerprint: fingerprint(hostKey.public), private: true, sealed: "" });
      await call({ action: "library" });
      await until(() => (pageState().result?.n ?? 0) > n);
      return pageState().result.error as string | null;
    };
    for (const host of ["127.0.0.1", "127.0.0.9", "::1", "0.0.0.0", "169.254.169.254", "fe80::1"]) assert.match((await refusal("itself", host)) ?? "", /an address of this machine itself.*the vault's key/, host);
    assert.deepEqual(saved(), [], "none of them was saved");
    const lookup = dns.lookup;
    let calls = 0;
    dns.lookup = ((host: string, options: unknown, cb: (...a: unknown[]) => void) => {
      if (host === "me.example") return cb(null, [{ address: "127.0.0.1", family: 4 }]);
      // Public when the save asks, this machine when the connection does.
      if (host === "rebind.example") return cb(null, [{ address: ++calls === 1 ? "192.0.2.9" : "127.0.0.1", family: 4 }]);
      return (lookup as (...a: unknown[]) => void)(host, options, cb);
    }) as typeof dns.lookup;
    try {
      assert.match((await refusal("itself", "me.example")) ?? "", /me\.example resolves to 127\.0\.0\.1 is an address of this machine itself/);
      assert.equal(await refusal("rebind", "rebind.example"), null, "a name that was public when saved is saved");
      await until(() => pageState().targets.find((t: { label: string }) => t.label === "rebind")?.status !== "not tried yet", SIGN_IN_MS);
      assert.match(pageState().targets.find((t: { label: string }) => t.label === "rebind").status, /rebind\.example:\d+ isn't reached: .*an address of this machine itself/, "the address the connection goes to is checked, at connect time, though ticked");
      assert.equal(seen.open, 0, "nothing connected");
    } finally {
      dns.lookup = lookup;
    }
  });
});

// What a target can reach (src/targets.ts looked): tried when it is checked, and once on first use.
const BASE = "http://anythingllm.test:3001";
const reachLeft = () => (fs.existsSync(path.join(publicDir, "library-lean")) ? fs.readdirSync(path.join(publicDir, "library-lean")).filter((n) => n.startsWith("reach-")) : []);
/** Registers "box" with a pasted key, so the first sign-in works, and waits for what it reaches to be kept. */
async function registered(base: string | null = BASE) {
  const box = await register({}, utils.generateKeyPairSync("ed25519"), base ?? undefined);
  await until(() => boxState().notes.length > 0 || boxState().barred !== null, LOOK_MS);
  return { ...box, ...boxState() };
}

test("a target that can fetch this AnythingLLM's pages is refused, and the token file it was asked for is gone", async () => {
  machine.serve = pageOf;
  const box = await registered();
  assert.match(box.barred, /^it can fetch this AnythingLLM's pages \(at anythingllm\.test:3001\), which carry the page secret\. Change the machine's firewall .* so it can't reach anythingllm\.test:3001, then try it again$/);
  assert.equal(seen.fetched.length, 1);
  assert.match(seen.fetched[0], /^http:\/\/anythingllm\.test:3001\/library-lean\/reach-[0-9a-f]{16}\.txt$/);
  assert.deepEqual(reachLeft(), [], "the file is removed");
  await ops();
  const execs = seen.execs;
  assert.match(await call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } }), /the target "box" isn't used: it can fetch this AnythingLLM's pages/);
  assert.equal(seen.execs, execs, "nothing was run on it");
  assert.match(await call({ action: "library", service: "ops" }), /Targets: box \(sandbox@127\.0\.0\.1:\d+, signed in, not used: it can fetch this AnythingLLM's pages/);
  assert.match(boxState().barred, /can fetch/, "the Targets card shows it");
  // Put right, then tried again: used.
  machine.serve = () => null;
  post({ secret: pageConfig().secret, ev: "target-check", label: "box" });
  await called({ action: "library" }, { slug: "work", base: BASE });
  await until(() => boxState().barred === null, LOOK_MS);
  assert.equal(result(await call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } })).stdout, "hi\n");
});

test("a target that can't fetch the pages is used; one that can't say (no curl or wget) is shown, not refused", async () => {
  const blocked = await registered();
  assert.equal(blocked.barred, null);
  assert.ok(!blocked.notes.some((n: string) => /reaches/.test(n)), "a refused connection says nothing more");
  await ops();
  assert.equal(result(await call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } })).stdout, "hi\n");
  machine.tools = false;
  post({ secret: pageConfig().secret, ev: "target-check", label: "box" });
  await called({ action: "library" }, { slug: "work", base: BASE });
  await until(() => boxState().notes.some((n: string) => /it has neither curl nor wget/.test(n)), LOOK_MS);
  assert.equal(boxState().barred, null);
  assert.equal(result(await call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } })).stdout, "hi\n");
  assert.deepEqual(reachLeft(), []);
});

test("a target that sees AnythingLLM's storage, or is this machine's account, is refused", async () => {
  machine.sees = true;
  const sees = await registered();
  assert.match(sees.barred, /^it can see AnythingLLM's storage \(.*vault-lean\), which holds the vault and the pages' secrets\. Use another machine or account$/);
  assert.deepEqual(fs.readdirSync(path.join(storage, "vault-lean")).filter((n) => n.startsWith(".reach-marker")), [], "the marker is removed");
  machine.sees = false;
  Object.assign(machine, { hostname: os.hostname(), uid: String(process.getuid!()) });
  post({ secret: pageConfig().secret, ev: "target-check", label: "box" });
  await called({ action: "library" }, { slug: "work", base: BASE });
  await until(() => /this machine's own account/.test(boxState().barred ?? ""), LOOK_MS);
  // The same hostname alone, or the same user alone, proves nothing.
  for (const other of [{ hostname: os.hostname(), uid: String(process.getuid!() + 1) }, { hostname: `${os.hostname()}-x`, uid: String(process.getuid!()) }]) {
    Object.assign(machine, other);
    post({ secret: pageConfig().secret, ev: "target-check", label: "box" });
    await called({ action: "library" }, { slug: "work", base: BASE });
    await until(() => boxState().barred === null, LOOK_MS);
  }
});

test("a target is looked at on its first use when it wasn't at its check for want of AnythingLLM's address", async () => {
  machine.serve = pageOf;
  const box = await registered(null);
  assert.equal(box.barred, null);
  assert.ok(box.notes.some((n: string) => /AnythingLLM's own address isn't known here/.test(n)));
  assert.equal(seen.fetched.length, 0);
  await ops();
  assert.match(await called({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } }, { slug: "work", base: BASE }), /the target "box" isn't used: it can fetch this AnythingLLM's pages/);
  assert.equal(seen.fetched.length, 1, "looked at once");
  assert.match(boxState().barred, /can fetch/);
  assert.deepEqual(reachLeft(), []);
});

test("it warns, without refusing, of an AnythingLLM with no password, and the vault's key beside the vault", async () => {
  const answers = { results: { RequiresAuth: false, MultiUserMode: false } };
  const web = http.createServer((req, res) => res.end(req.url === "/api/setup-complete" ? JSON.stringify(answers) : "{}"));
  await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  try {
    const open = await registered(base);
    assert.equal(open.barred, null);
    assert.ok(open.notes.includes("this AnythingLLM has no password: whoever reaches it is its administrator"));
    assert.ok(open.notes.some((n: string) => /the vault's key is kept beside the vault \(VAULT_KEY_FILE isn't set\)/.test(n)));
    answers.results.RequiresAuth = true;
    post({ secret: pageConfig().secret, ev: "target-check", label: "box" });
    await called({ action: "library" }, { slug: "work", base });
    await until(() => !boxState().notes.some((n: string) => /no password/.test(n)), LOOK_MS);
    assert.equal(boxState().barred, null);
  } finally {
    web.close();
  }
});

// This machine, by what is recorded of it (shared/thishost.mts, written by the installer on the host).
const record = (value: unknown) => ((globalThis as unknown as Record<symbol, unknown>)[THISHOST_RECORD] = value);
const recordFile = () => path.join(storage, "anywherellm-suite", "this-host.json");
/** Saves a target the page way and answers the refusal the page shows, or null when it was saved. */
async function savedAs(label: string, fields: Record<string, unknown>, base?: string) {
  const n = pageState().result?.n ?? 0;
  post({ secret: pageConfig().secret, ev: "target-save", label, host: "127.0.0.1", port: PORT, login: "sandbox", fingerprint: fingerprint(hostKey.public), private: true, sealed: "", ...fields });
  await called({ action: "library" }, { slug: "work", base });
  await until(() => (pageState().result?.n ?? 0) > n);
  return pageState().result.error as string | null;
}

test("without a good record of this machine no target is saved or used", async () => {
  await register();
  await ops();
  assert.equal(result(await call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } })).stdout, "hi\n", "with the record it is used");
  const writeRecord = (text: string) => (fs.mkdirSync(path.dirname(recordFile()), { recursive: true }), fs.writeFileSync(recordFile(), text));
  const cases: [string, () => void, RegExp][] = [
    ["no file", () => fs.rmSync(recordFile(), { force: true }), /this machine isn't recorded.*is missing.*run the installer on the host/],
    ["a file that isn't JSON", () => writeRecord("not json"), /this machine isn't recorded.*isn't JSON/],
    ["a file that isn't a record", () => writeRecord('{"fingerprints":"x"}'), /this machine isn't recorded.*isn't a record of this machine/],
    ["no host key in it", () => writeRecord(JSON.stringify({ fingerprints: [], addresses: [] })), /holds no SSH host key.*run the installer on the host/],
  ];
  for (const [what, make] of cases.map(([w, m]) => [w, m] as const)) {
    record(undefined); // the file, as shipped code reads it
    make();
    const wanted = cases.find(([w]) => w === what)![2];
    const execs = seen.execs;
    const auths = seen.auths;
    assert.match(await call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } }), wanted, `${what}: a saved target isn't used`);
    assert.match((await savedAs("other", {})) ?? "", wanted, `${what}: nothing is saved`);
    assert.deepEqual(pageState().targets.map((t: { label: string }) => t.label), ["box"]);
    assert.equal(seen.execs, execs, `${what}: nothing was run`);
    assert.equal(seen.auths, auths, `${what}: nothing was signed in to`);
  }
});

test("a machine that shows this host's SSH host key is refused, whatever its address", async () => {
  await call({ action: "secret", kind: "ssh", label: "twin" }); // makes the page
  // The address is not this machine's by anything the container sees or the record holds; the key is.
  record({ fingerprints: [fingerprint(otherHostKey.public)], addresses: [] });
  assert.match((await savedAs("twin", { fingerprint: fingerprint(otherHostKey.public) })) ?? "", /^SHA256:\S+ is this machine's own SSH host key: signing in there would read what AnythingLLM keeps beside it/, "refused when the user gives its fingerprint");
  assert.deepEqual(pageState().targets, []);
  // Saved with a fingerprint that isn't this host's, at a machine that shows this host's key: the
  // key it shows is what is refused, before anything is sent.
  const imposterPort = (imposter.address() as AddressInfo).port;
  assert.equal(await savedAs("twin", { port: imposterPort }), null);
  await until(() => pageState().targets.find((t: { label: string }) => t.label === "twin")?.status !== "not tried yet", SIGN_IN_MS);
  assert.match(pageState().targets.find((t: { label: string }) => t.label === "twin").status, /is this machine: SHA256:\S+ is this machine's own SSH host key.*Nothing was sent/);
  assert.equal(seen.execs, 0);
});

test("a target is asked to fetch the pages from AnythingLLM's address and from each of this host's, on each port, at once", async () => {
  record({ fingerprints: [THIS_HOST_FINGERPRINT], addresses: ["127.0.0.1", "fe80::1", "10.1.2.3", "2001:db8::5"] });
  const page = (u: URL) => pageOf(u);
  const miss = await registered();
  assert.equal(miss.barred, null);
  const rel = /\/library-lean\/reach-[0-9a-f]{16}\.txt$/;
  const origins = seen.fetched.map((u) => u.replace(rel, "")).sort();
  assert.deepEqual(origins, ["http://10.1.2.3:3001", "http://10.1.2.3:8467", "http://[2001:db8::5]:3001", "http://[2001:db8::5]:8467", "http://anythingllm.test:3001", "https://10.1.2.3:443", "https://[2001:db8::5]:443"].sort(), "loopback and link-local addresses of the host mean the machine itself, and aren't tried");
  assert.equal(seen.execs - 1 >= 1, true);
  // Only a page that answers with the token is a hit: another service on 3001 saying something isn't.
  const one = seen.fetched.length;
  machine.serve = (u) => (u.host === "10.1.2.3:8467" ? page(u) : u.host === "10.1.2.3:3001" ? "<html>hello</html>" : null);
  post({ secret: pageConfig().secret, ev: "target-check", label: "box" });
  await called({ action: "library" }, { slug: "work", base: BASE });
  await until(() => boxState().barred !== null, LOOK_MS);
  assert.match(boxState().barred, /^it can fetch this AnythingLLM's pages \(at 10\.1\.2\.3:8467\), which carry the page secret/);
  assert.ok(seen.fetched.length > one);
  // Hits at two addresses are both named.
  machine.serve = (u) => (u.host === "10.1.2.3:8467" || u.host === "anythingllm.test:3001" ? page(u) : null);
  post({ secret: pageConfig().secret, ev: "target-check", label: "box" });
  await called({ action: "library" }, { slug: "work", base: BASE });
  await until(() => /anythingllm\.test:3001/.test(boxState().barred ?? "") && /10\.1\.2\.3:8467/.test(boxState().barred ?? ""), LOOK_MS);
  // Without AnythingLLM's own address the host's are still tried.
  machine.serve = (u) => (u.hostname === "[2001:db8::5]" && u.protocol === "https:" ? page(u) : null);
  post({ secret: pageConfig().secret, ev: "target-check", label: "box" });
  await called({ action: "library" }, { slug: "work" });
  await until(() => /2001:db8::5:443|\[?2001:db8::5\]?:443/.test(boxState().barred ?? ""), LOOK_MS);
  assert.deepEqual(reachLeft(), []);
});

test("every save looks at what the target reaches again, not only the first", async () => {
  const first = await registered();
  assert.equal(first.barred, null);
  const before = seen.fetched.length;
  machine.serve = pageOf;
  assert.equal(await savedAs("box", { unattended: true }, BASE), null, "saved again, only its tick changed");
  await until(() => boxState().barred !== null, LOOK_MS);
  assert.ok(seen.fetched.length > before, "looked at again");
  assert.match(boxState().barred, /can fetch/);
});

test("any failure of a target save is told to the page, which would otherwise wait for it", async () => {
  await call({ action: "secret", kind: "ssh", label: "box" });
  const lookup = dns.lookup;
  const logged: string[] = [];
  const log = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.join(" "));
  dns.lookup = ((host: string, options: unknown, cb: (...a: unknown[]) => void) => {
    if (host === "boom.example") throw new Error("the resolver broke");
    return (lookup as (...a: unknown[]) => void)(host, options, cb);
  }) as typeof dns.lookup;
  try {
    assert.equal(await savedAs("box", { host: "boom.example" }), "couldn't save the target (see the log)");
    assert.ok(logged.some((l) => /couldn't apply a page event \(target-save\): the resolver broke/.test(l)), "the real error is logged");
    assert.deepEqual(pageState().targets, []);
  } finally {
    dns.lookup = lookup;
    console.error = log;
  }
});
