// Targets: machines the library's functions run commands on over SSH (src/targets.ts), against a
// stand-in machine, ssh2's own Server on 127.0.0.1, run here in the test. It accepts the one key it's
// told to, runs a few named commands, serves files over SFTP from memory (`files`), and can
// misbehave: show another host key, open channels toward the client, never end, stall a write. The built handler.js does the client's side, as AnythingLLM loads it.
// ssh2's server ignores a signal once the client has ended stdin, which OpenSSH's doesn't, so that
// TERM reaches a command is checked against a real sshd (tests/e2e), not here.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import ssh2 from "ssh2";
import { call as called, pageConfig, pageState, post, reset, seal, storage, until } from "./harness.mts";

const { Server, utils } = ssh2;
const call = (args: Record<string, unknown>, slug: string | null = "work") => called(args, { slug });

const hostKey = utils.generateKeyPairSync("ed25519");
const otherHostKey = utils.generateKeyPairSync("ed25519");
const fingerprint = (pub: string) => `SHA256:${crypto.createHash("sha256").update(Buffer.from(pub.split(" ")[1], "base64")).digest("base64").replace(/=+$/, "")}`;

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
  sftp.on("STAT", (id, path) => (files.has(path) ? sftp.attrs(id, attrs(files.get(path)!)) : sftp.status(id, S.NO_SUCH_FILE)));
  const setMode = (path: string, mode: number | undefined) => mode !== undefined && files.has(path) && (files.get(path)!.mode = mode);
  sftp.on("SETSTAT", (id, path, a) => (setMode(path, a.mode), sftp.status(id, S.OK)));
  sftp.on("FSETSTAT", (id, handle, a) => (setMode(of(handle)!.path, a.mode), sftp.status(id, S.OK)));
  sftp.on("REALPATH", (id, path) => {
    const real = links.get(path) ?? path;
    sftp.name(id, [{ filename: real, longname: real, attrs: {} as ssh2.Attributes }]);
  });
  sftp.on("REMOVE", (id, path) => sftp.status(id, files.delete(path) ? S.OK : S.NO_SUCH_FILE));
  sftp.on("RENAME", (id, from, to) => {
    if (!files.has(from) || files.has(to)) return sftp.status(id, S.FAILURE);
    files.set(to, files.get(from)!);
    files.delete(from);
    sftp.status(id, S.OK);
  });
}

/** What the stand-in saw, for the tests to check: sign-ins tried, naps going at once, channels
 *  refused, hung commands started, and their connections closed. */
const seen = { auths: 0, open: 0, most: 0, refused: [] as string[], hung: 0, closed: 0 };
let allowed: ssh2.ParsedKey | null = null;

const standIn = (key: string) =>
  new Server({ hostKeys: [key] }, (client) => {
    client.on("error", () => {}); // a client that hangs up mid-handshake, as one refusing the host key does
    client.on("authentication", (ctx) => {
      seen.auths++;
      if (ctx.method !== "publickey" || !allowed || ctx.key.algo !== allowed.type || !ctx.key.data.equals(allowed.getPublicSSH())) return ctx.reject(["publickey"]);
      if (ctx.signature && !allowed.verify(ctx.blob!, ctx.signature, ctx.hashAlgo)) return ctx.reject(["publickey"]);
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
          const s = acceptExec();
          const done = (code: number) => (s.exit(code), s.end());
          if (command === "echo hi") return s.write("hi\n"), done(0);
          if (command === "fail") return s.stderr.write("no such thing\n"), done(3);
          if (command === "cat") {
            let got = "";
            s.on("data", (d: Buffer) => (got += d));
            return s.on("end", () => (s.write(got.toUpperCase()), done(0)));
          }
          if (command === "big") return s.write("x".repeat(300 * 1024)), s.stderr.write("y".repeat(10)), done(0);
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
async function register(fields: Record<string, unknown> = {}, pasted?: { private: string; public: string }) {
  await call({ action: "secret", kind: "ssh", label: "box" });
  if (pasted) allowed = utils.parseKey(pasted.public) as ssh2.ParsedKey;
  post({ secret: pageConfig().secret, ev: "target-save", label: "box", host: "127.0.0.1", port: PORT, login: "sandbox", fingerprint: fingerprint(hostKey.public), private: true, sealed: pasted ? seal(pasted.private) : "", ...fields });
  await call({ action: "library" });
  await until(() => boxState().status !== "not tried yet", 15_000); // past the 10 s a sign-in may take
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
  Object.assign(seen, { auths: 0, open: 0, most: 0, refused: [], hung: 0, closed: 0 });
  files.clear();
  links.clear();
  allowed = null;
  delete process.env.LIBRARY_WAIT_MS;
});

test("a target is asked for and registered on the page, with a key made there whose private half nobody is shown", async () => {
  const asked = await call({ action: "secret", kind: "ssh", label: "box" });
  assert.match(asked, /^The user registers the target "box" on the Library page, under Targets: \/library-lean\/[\w-]+\.html\n/);
  assert.deepEqual(pageState().needs, [{ label: "box", site: "", kind: "target" }]);
  const box = await register();
  assert.match(box.public, /^ssh-ed25519 AAAA\S+ library-lean box$/);
  assert.equal(box.status, "the target \"box\" refused its key: the public line goes in ~sandbox/.ssh/authorized_keys on the machine (the Library page shows it)", "tried at once, before its line was added");
  assert.deepEqual(pageState().needs, [], "the need is met");
  post({ secret: pageConfig().secret, ev: "target-check", label: "box" });
  await call({ action: "library" });
  await until(() => boxState().status === "signed in");
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
  assert.match(hi, /- SSH box \$ echo hi: 0 \(\d+ ms\)/);
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
  assert.ok(seen.most <= 4, `${seen.most} at once`);
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
