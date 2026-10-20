// OAuth sign-ins by the device flow (a code the user enters, no redirect), against a stand-in provider
// on 127.0.0.1: the code to show, the user agreeing, declining or letting it run out, the tokens sent
// by a function and renewed once as they run out, and the presets. A sign-in is seeded as a preset
// saves one, but at the stand-in rather than GitHub.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import * as vault from "#shared/vault";
import { call, giveKey, postVault, reset, saveSignIn, seal, storage, until, vaultState } from "./harness.mts";

// The provider: a device endpoint that gives codes, a token endpoint that checks the client (an ID, no
// secret) and rotates refresh tokens, and an API that wants the current access token. Whether the user agreed (or declined), whether the next ask is told to slow down or that the code
// ran out, how long a code lasts, how many codes it gave (each a new one), how many seconds a token
// lasts without a refresh token (0: the provider doesn't say, as GitHub's), whether the tokens it
// gives come with a refresh token that lasts `lifetime` seconds, and how many times the token address
// was asked.
const fresh = () => ({ hold: null as Promise<void> | null, refreshes: 0, access: "", refresh: "", lifetime: 3600, spent: new Set<string>(), agreed: false, declined: false, slow: false, expired: false, expires: 900, deviceLifetime: 0, deviceRefresh: false, asks: 0, codes: 0, current: new Map<string | undefined, number>() });
const provider = fresh();
const serve = (req: http.IncomingMessage, res: http.ServerResponse) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const json = (status: number, value: unknown) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(value)));
    const form = new URLSearchParams(body);
    if (req.url === "/device/code") {
      await provider.hold;
      if (form.get("client_id") !== "client-1") return json(401, { error: "invalid_client" });
      const n = ++provider.codes;
      provider.current.set(req.headers.host, n); // each address has its own latest code
      return json(200, { device_code: `dev-secret-${n}`, user_code: n === 1 ? "WDJB-MJHT" : `CODE-000${n}`, verification_uri: "https://example.com/login/device", expires_in: provider.expires, interval: 0 });
    }
    if (req.url === "/token" && form.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
      provider.asks++;
      if (form.get("client_id") !== "client-1" || form.get("device_code") !== `dev-secret-${provider.current.get(req.headers.host)}`) return json(400, { error: "invalid_grant" });
      if (provider.slow) return (provider.slow = false), json(400, { error: "slow_down" });
      if (provider.expired) return json(400, { error: "expired_token" });
      if (provider.declined) return json(400, { error: "access_denied" });
      if (!provider.agreed) return json(400, { error: "authorization_pending" });
      provider.access = `at-${crypto.randomUUID()}`;
      if (provider.deviceRefresh) {
        provider.refresh = `rt-${crypto.randomUUID()}`;
        return json(200, { access_token: provider.access, refresh_token: provider.refresh, expires_in: provider.lifetime, token_type: "bearer" });
      }
      return json(200, { access_token: provider.access, token_type: "bearer", scope: "me.read", ...(provider.deviceLifetime ? { expires_in: provider.deviceLifetime } : {}) });
    }
    if (req.url === "/token") {
      if (form.get("client_id") !== "client-1" || form.get("grant_type") !== "refresh_token") return json(400, { error: "unsupported_grant_type" });
      const used = form.get("refresh_token") ?? "";
      if (used !== provider.refresh || provider.spent.has(used)) return json(400, { error: "invalid_grant", error_description: "refresh token reused" });
      provider.spent.add(used);
      provider.refreshes++;
      provider.access = `at-${crypto.randomUUID()}`;
      provider.refresh = `rt-${crypto.randomUUID()}`;
      return json(200, { access_token: provider.access, refresh_token: provider.refresh, expires_in: provider.lifetime, token_type: "Bearer" });
    }
    if (req.url === "/me") return req.headers.authorization === `Bearer ${provider.access}` ? json(200, { name: "Ada" }) : json(401, { error: "no" });
    json(404, {});
  });
};
// The provider at two addresses, which count as two providers (one sign-in each).
const [BASE, OTHER] = await Promise.all(
  [0, 1].map(async () => {
    const server = http.createServer(serve);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    test.after(() => server.close());
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }),
);

/** The secret `label` as the Vault shows it now; undefined when there's none. */
const secretIn = (label: string): { status: string; tag?: { text: string; ok: boolean } } | undefined => vaultState().secrets.find((s: { label: string }) => s.label === label);

/** The sign-in `label`'s status as the Vault shows it now; undefined when there's none. */
const statusIn = (label: string): string | undefined => secretIn(label)?.status;

/** The sign-in `label`'s status, as the Vault shows it once a library call has written it again;
 *  undefined when there's none. */
async function statusOf(label: string): Promise<string | undefined> {
  await call({ action: "library" });
  return statusIn(label);
}

test.beforeEach(() => {
  reset();
  Object.assign(provider, fresh());
});

/** The definition of a sign-in at the stand-in provider at `base`. */
const definitionAt = (base: string, scopes = "me.read") => ({ token_url: `${base}/token`, device_url: `${base}/device/code`, scopes });

/** Saves the sign-in `label` as a preset does (the suite's client, an ID and no secret), at the
 *  stand-in provider at `base`. */
async function seed(label: string, base = BASE): Promise<void> {
  await saveSignIn("127.0.0.1", label, definitionAt(base), "client-1");
}

/** Seeds the sign-in "dev" and answers the code to show. */
async function code(): Promise<string> {
  await seed("dev");
  return call({ action: "secret", label: "dev" });
}

const devStatus = () => statusIn("dev");

/** A toolkit whose function calls the provider's /me with the sign-in "dev" (or is `source`). */
async function toolkit(source = "async function main(i, kit) { const a = await kit.http({ path: '/me' }); if (!a.ok) throw new Error('status ' + a.status); return a.body.name; }"): Promise<void> {
  await call({ action: "save", service: "dev", toolkit: { base_urls: [BASE], secrets: [{ label: "dev", as: "bearer" }] }, function: { name: "me", description: "Who signed in.", source } });
}

test("a device sign-in: the code to show, the user agrees, and library finds it signed in", async () => {
  const said = await code();
  assert.match(said, /^Show the user this code in a code block of its own, so they can copy it:\n\n```\nWDJB-MJHT\n```\n\nThey open https:\/\/example\.com\/login\/device, enter the code and agree; it's good for 15 minutes\./);
  assert.ok(!said.includes("dev-secret-1"), "the device code never reaches the model");
  await call({ action: "library" });
  assert.equal(devStatus(), "waiting for the user to enter its code");
  assert.ok(provider.asks >= 1, "asked while the user hadn't agreed");
  provider.agreed = true;
  await call({ action: "library" });
  assert.equal(devStatus(), "signed in");
  await toolkit();
  const ran = await call({ action: "run", name: "dev.me" });
  assert.match(ran, /: ok, .*Result \(JSON\):\n"Ada"/s);
  assert.ok(!ran.includes(provider.access));
  const vaultText = fs.readFileSync(path.join(storage, "vault-lean", "vault.json"), "utf8");
  assert.ok(!vaultText.includes(provider.access), "tokens kept encrypted");
  const asked = provider.asks;
  await call({ action: "library" });
  assert.equal(provider.asks, asked, "nothing more is asked once signed in");
  assert.match(await call({ action: "library", service: "dev" }), /Keys: dev \(bearer, signed in\)/);
});

test("a provider that asks to slow down is asked less often", async () => {
  provider.slow = true;
  await code();
  await call({ action: "guide" });
  const asked = provider.asks;
  assert.ok(asked >= 1);
  await call({ action: "guide" });
  assert.equal(provider.asks, asked, "not asked again before the longer interval");
  provider.agreed = true;
  await call({ action: "library" }); // waits for the interval, as when the user says they're done
  assert.equal(devStatus(), "signed in");
});

test("a device sign-in the user declines, or whose code runs out, says why", async () => {
  provider.declined = true;
  await code();
  await call({ action: "library" });
  assert.equal(devStatus(), "its last sign-in didn't finish: the user didn't agree at the provider");
  provider.declined = false;
  provider.expires = 1;
  assert.match(await call({ action: "secret", label: "dev" }), /good for 1 minute\./);
  await new Promise((r) => setTimeout(r, 1100));
  await call({ action: "library" });
  assert.equal(devStatus(), "its last sign-in didn't finish: the code ran out before the user entered it: start the sign-in again");
});

test("an unknown preset names the presets", async () => {
  assert.match(await call({ action: "secret", preset: "nope" }), /there's no preset "nope": the presets are github; for another service, ask for a key or token with secret/);
});

test("the user agrees and no call follows: the Vault shows signed in once the loop finds it", async () => {
  await code();
  await call({ action: "library" });
  assert.equal(devStatus(), "waiting for the user to enter its code");
  provider.agreed = true;
  await until(() => devStatus() === "signed in"); // the loop asks every half second
});

test("a device sign-in that ends says how in the log, and nothing secret", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "log", (m: string) => void logged.push(m));
  await code();
  provider.declined = true;
  await call({ action: "library" });
  assert.ok(logged.includes('library-lean: the sign-in "dev" ended: the user didn\'t agree at the provider'), logged.join("\n"));
  provider.declined = false;
  await call({ action: "secret", label: "dev" });
  provider.agreed = true;
  await call({ action: "library" });
  assert.ok(logged.includes('library-lean: the sign-in "dev" signed in'), logged.join("\n"));
  assert.ok(!/dev-secret|WDJB-MJHT|CODE-0002|at-[\w-]{8}/.test(logged.join("\n")), "no device code, user code or token");
});

// The device flow, asked again: a second call while a code waits must never make a new one, since the
// user may be entering the first.

/** Forgets what this process kept of the device flow (when to ask, the loop), as a restart of
 *  AnythingLLM does; the vault keeps the code. */
function restart(): void {
  for (const key of ["schedule", "loop", "asking"]) delete (globalThis as Record<symbol, unknown>)[Symbol.for(`anywherellm-suite.library-lean.device.${key}`)];
}

const sameCode = /^The code shown before still waits, and no new one was made: show it again\. Show the user this code in a code block of its own, so they can copy it:\n\n```\nWDJB-MJHT\n```\n/;

test("asked for the code again while it waits, secret shows the same one and makes no other", async () => {
  await code();
  assert.match(await call({ action: "secret", label: "dev" }), sameCode);
  assert.equal(provider.codes, 1);
  provider.agreed = true;
  await call({ action: "library" });
  assert.equal(devStatus(), "signed in");
});

test("the user agreed before the first ask: library finds it signed in", async () => {
  await code();
  provider.agreed = true;
  await call({ action: "library" });
  assert.equal(devStatus(), "signed in");
  assert.equal(provider.asks, 1);
});

test("the user agreed after several asks: secret called again finds it signed in, not a new code", async () => {
  await code();
  for (let i = 0; i < 3; i++) await call({ action: "library" });
  assert.ok(provider.asks >= 3, "asked while the user hadn't agreed");
  assert.equal(devStatus(), "waiting for the user to enter its code");
  provider.agreed = true;
  assert.match(await call({ action: "secret", label: "dev" }), /^"dev" is signed in already: start no new sign-in\./);
  await call({ action: "library" }); // the Vault's state is written again
  assert.equal(devStatus(), "signed in");
  assert.equal(provider.codes, 1);
  assert.match(await call({ action: "secret", label: "dev" }), /signed in already/, "and stays so");
  assert.equal(provider.codes, 1);
});

test("secret with a sign-in's label alone, no kind, goes to that sign-in, not to a key", async () => {
  await code();
  assert.match(await call({ action: "secret", label: "dev" }), sameCode);
  assert.equal(provider.codes, 1);
  provider.agreed = true;
  assert.match(await call({ action: "secret", label: "dev" }), /^"dev" is signed in already/);
  assert.equal(provider.codes, 1);
  assert.match(await call({ action: "secret", label: "nope" }), /a key needs site/, "a label that names no sign-in is a key's");
  assert.doesNotMatch(await call({ action: "secret", label: "dev", site: "api.example.com" }), /signed in already/, "a site means a key");
  assert.match(await call({ action: "secret", preset: "nope" }), /there's no preset "nope"/, "a preset means a sign-in");
});

test("a code the provider says ran out ends the sign-in, and the next secret makes a new one", async () => {
  await code();
  provider.expired = true;
  await call({ action: "library" });
  assert.equal(devStatus(), "its last sign-in didn't finish: the code ran out before the user entered it: start the sign-in again");
  provider.expired = false;
  assert.match(await call({ action: "secret", label: "dev" }), /^Its last sign-in didn't finish \(the code ran out before the user entered it: start the sign-in again\), so this is a new one\. Show the user this code[^]*CODE-0002/);
  assert.equal(provider.codes, 2);
});

test("secret says why a new code is made: the last one declined", async () => {
  provider.declined = true;
  await code();
  await call({ action: "library" });
  provider.declined = false;
  assert.match(await call({ action: "secret", label: "dev" }), /^Its last sign-in didn't finish \(the user didn't agree at the provider\), so this is a new one\. Show the user this code/);
});

test("a restart between the code and the user agreeing: the same code shows, and it finishes", async () => {
  await code();
  restart();
  assert.match(await call({ action: "secret", label: "dev" }), sameCode);
  restart();
  provider.agreed = true;
  await call({ action: "library" });
  assert.equal(devStatus(), "signed in");
  assert.equal(provider.codes, 1);
});

test("two chats asking for the code at once get one code", async () => {
  await seed("dev");
  const [a, b] = await Promise.all([call({ action: "secret", label: "dev" }, "work"), call({ action: "secret", label: "dev" }, "other")]);
  assert.equal(provider.codes, 1);
  for (const said of [a, b]) assert.match(said, /```\nWDJB-MJHT\n```/);
});

test("a preset saved again keeps the code waiting and the tokens; other scopes drop them", async () => {
  await code();
  await saveSignIn("127.0.0.1", "dev", definitionAt(BASE), "client-1");
  assert.match(await call({ action: "secret", label: "dev" }), sameCode);
  assert.equal(provider.codes, 1);
  provider.agreed = true;
  assert.equal(await statusOf("dev"), "signed in");
  await saveSignIn("127.0.0.1", "dev", definitionAt(BASE), "client-1");
  assert.equal(await statusOf("dev"), "signed in", "the preset given again keeps the tokens");
  await saveSignIn("127.0.0.1", "dev", definitionAt(BASE, "me.read me.write"), "client-1");
  assert.equal(await statusOf("dev"), "ready to sign in", "other scopes need a new sign-in");
});

test("one sign-in per provider: a preset under another name points to the one there", async () => {
  await seed("dev");
  await assert.rejects(saveSignIn("127.0.0.1", "dev-2", definitionAt(BASE), "client-1"), /there's a sign-in at 127\.0\.0\.1:\d+ already: "dev"/);
  await seed("dev-3", OTHER); // another provider is another sign-in
  await call({ action: "library" });
  assert.deepEqual(vaultState().secrets.map((s: { label: string }) => s.label), ["dev", "dev-3"]);
});

test("a token about to run out is renewed once, even for requests at once, and the new one kept", async () => {
  provider.deviceRefresh = true;
  provider.lifetime = 30; // under the minute a token is renewed before it runs out
  await code();
  provider.agreed = true;
  await call({ action: "library" });
  await toolkit();
  const both = "async function main(i, kit) { const [a, b] = await Promise.all([kit.http({ path: '/me' }), kit.http({ path: '/me' })]); return [a.status, b.status]; }";
  const said = await call({ action: "save", service: "dev", function: { name: "both", description: "Two at once.", source: both }, test: {} });
  assert.match(said, /Result \(JSON\):\n\[\n 200,\n 200\n\]/);
  assert.equal(provider.refreshes, 1, "one renewal for both requests: a rotated refresh token is spent once");
  provider.lifetime = 3600;
  assert.match(await call({ action: "run", name: "dev.me" }), /"Ada"/);
  assert.equal(provider.refreshes, 2, "the token kept was the renewed one, itself about to run out");
});

test("a device sign-in whose token ran out with nothing to renew it signs in again with a new code", async () => {
  provider.deviceLifetime = 1; // and no refresh token
  await code();
  provider.agreed = true;
  await toolkit("async function main() { return 1; }");
  const ranOut = "its sign-in ran out and can't be renewed: start it again with secret";
  assert.match(await call({ action: "library" }), new RegExp(`dev \\(bearer, ${ranOut}\\)`), "library says what secret finds");
  assert.equal(devStatus(), ranOut, "and so does the Vault");
  const again = await call({ action: "secret", label: "dev" });
  assert.match(again, /^Its sign-in ran out and can't be renewed, so this is a new one\. Show the user this code[^]*CODE-0002/, "not \"signed in already\"");
  assert.equal(provider.codes, 2);
});

test("a sign-in waiting on its provider holds up no other sign-in", async () => {
  await seed("demo");
  assert.match(await call({ action: "secret", label: "demo" }), /```\nWDJB-MJHT\n```/);
  await seed("dev", OTHER);
  let release!: () => void;
  provider.hold = new Promise((r) => (release = r));
  let devAnswered = false;
  const dev = call({ action: "secret", label: "dev" }).then((said) => ((devAnswered = true), said));
  await new Promise((r) => setTimeout(r, 100)); // dev waits on the provider, holding its own lock
  assert.match(await call({ action: "secret", label: "demo" }), /still waits/);
  assert.equal(devAnswered, false, "demo answered while dev still waited");
  release();
  assert.match(await dev, /```\nCODE-0002\n```/);
});

test("a sign-in of the removed kind (no device address) is never used, and says what to do", async () => {
  await saveSignIn("attacker.example", "old", { token_url: "https://attacker.example/token", scopes: "" } as never, "client-1");
  const removed = /made by a sign-in the suite no longer has/;
  assert.match(await call({ action: "secret", label: "old" }), removed);
  assert.match((await statusOf("old")) ?? "", removed);
  await vault.update((v) => void Object.assign(v.entries.find((e) => e.user === "old")!, { tokens: { access_token: "at-old", refresh_token: "rt-old", expires_at: null } }));
  assert.match(await statusOf("old") ?? "", removed, "tokens it holds don't make it signed in");
  assert.match(await call({ action: "call", url: "https://attacker.example/x", auth: { key: "old", as: "bearer" } }), removed, "and none is sent");
});

test("a name is one secret: a key can't take a sign-in's name, nor a sign-in a key's", async () => {
  await seed("dev");
  await call({ action: "library" }); // the Vault is there
  const signInTaken = /"dev" is a sign-in already: use another name, or the user deletes it on the Vault first/;
  assert.match(await call({ action: "secret", site: "api.example.com", label: "dev" }), signInTaken, "asked for a key under its name: told, and the Vault asks for none");
  assert.deepEqual(vaultState().needs, []);
  postVault({ ev: "key-save", label: "dev", site: "api.example.com", sealed: seal("k") }); // as a stale page could post it
  assert.equal(await statusOf("dev"), "ready to sign in", "the sign-in stays");
  await giveKey("kk", "api.example.com", "v1");
  await assert.rejects(saveSignIn("127.0.0.1", "kk", definitionAt(OTHER), "client-1"), /"kk" is a key already: use another name/);
  assert.equal(await statusOf("kk"), "saved", "the key stays");
  await giveKey("kk", "api.example.com", "v2"); // a key is rotated by saving it again
  assert.equal(vaultState().secrets.filter((s: { label: string }) => s.label === "kk").length, 1);
});

test("the Vault shows each sign-in's tag as the library gives it", async () => {
  await code();
  await call({ action: "library" });
  assert.deepEqual(secretIn("dev")?.tag, { text: "Enter the code", ok: false });
  provider.agreed = true;
  await call({ action: "library" });
  assert.deepEqual(secretIn("dev")?.tag, { text: "Signed in", ok: true });
});
