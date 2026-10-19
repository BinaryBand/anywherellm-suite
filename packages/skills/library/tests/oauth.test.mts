// OAuth sign-ins, against a stand-in provider on 127.0.0.1: the definition, the user's client on the
// Vault, the sign-in link (PKCE), the code coming back through oauth.html's event, the tokens sent by
// a function and renewed once as they run out, and the paste fallback; a device-flow sign-in (a code the
// user enters, no redirect), the presets, and AnythingLLM's address learned from the Vault.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { call, cardsShown, post, postVault, publicDir, reset, seal, skillDir, storage, vaultState } from "./harness.mts";

// The provider: a token endpoint that checks the client (in the form, or by HTTP Basic) and PKCE (when
// the sign-in link asked for it) and rotates refresh tokens, and an API that wants the current access
// token.
// For the device flow: whether the user agreed (or declined), whether the next ask is told to slow
// down or that the code ran out, how long a code lasts, how many codes it gave (each a new one), and
// how many times the token address was asked.
const fresh = () => ({ challenge: "", refreshes: 0, access: "", refresh: "", lifetime: 3600, spent: new Set<string>(), basic: false, agreed: false, declined: false, slow: false, expired: false, expires: 900, asks: 0, codes: 0 });
const provider = fresh();
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = (status: number, value: unknown) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(value)));
    const form = new URLSearchParams(body);
    if (req.url === "/device/code") {
      if (form.get("client_id") !== "client-1") return json(401, { error: "invalid_client" });
      const n = ++provider.codes;
      return json(200, { device_code: `dev-secret-${n}`, user_code: n === 1 ? "WDJB-MJHT" : `CODE-000${n}`, verification_uri: "https://example.com/login/device", expires_in: provider.expires, interval: 0 });
    }
    if (req.url === "/token" && form.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
      provider.asks++;
      if (form.get("client_id") !== "client-1" || form.get("device_code") !== `dev-secret-${provider.codes}`) return json(400, { error: "invalid_grant" });
      if (provider.slow) return (provider.slow = false), json(400, { error: "slow_down" });
      if (provider.expired) return json(400, { error: "expired_token" });
      if (provider.declined) return json(400, { error: "access_denied" });
      if (!provider.agreed) return json(400, { error: "authorization_pending" });
      provider.access = `at-${crypto.randomUUID()}`;
      return json(200, { access_token: provider.access, token_type: "bearer", scope: "me.read" });
    }
    if (req.url === "/token") {
      provider.basic = req.headers.authorization === `Basic ${Buffer.from("client-1:shh-secret").toString("base64")}`;
      if (form.get("client_id") !== "client-1" || (form.get("client_secret") !== "shh-secret" && !provider.basic)) return json(401, { error: "invalid_client" });
      if (form.get("grant_type") === "authorization_code") {
        const verifier = form.get("code_verifier");
        const pkce = provider.challenge ? crypto.createHash("sha256").update(verifier ?? "").digest("base64url") === provider.challenge : verifier === null;
        if (form.get("code") !== "good-code" || !pkce) return json(400, { error: "invalid_grant" });
      } else if (form.get("grant_type") === "refresh_token") {
        const used = form.get("refresh_token") ?? "";
        if (used !== provider.refresh || provider.spent.has(used)) return json(400, { error: "invalid_grant", error_description: "refresh token reused" });
        provider.spent.add(used);
        provider.refreshes++;
      } else return json(400, { error: "unsupported_grant_type" });
      provider.access = `at-${crypto.randomUUID()}`;
      provider.refresh = `rt-${crypto.randomUUID()}`;
      return json(200, { access_token: provider.access, refresh_token: provider.refresh, expires_in: provider.lifetime, token_type: "Bearer" });
    }
    if (req.url === "/me") return req.headers.authorization === `Bearer ${provider.access}` ? json(200, { name: "Ada" }) : json(401, { error: "no" });
    json(404, {});
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => server.close());

const definition = { site: "127.0.0.1", authorize_url: `${BASE}/authorize`, token_url: `${BASE}/token`, scopes: ["me.read"], params: { access_type: "offline" } };
const LLM = "https://llm.example.com";

test.beforeEach(() => {
  reset();
  Object.assign(provider, fresh());
});

/** Gives the client of the sign-in `label` on the page, as the user does: its ID, and its secret
 *  sealed (or none), from a page opened at `origin`. */
function giveClient(label: string, { secret = "", origin }: { secret?: string; origin?: string } = {}): void {
  postVault({ ev: "oauth-client", label, client_id: "client-1", sealed: secret ? seal(secret) : "", ...(origin ? { origin } : {}) });
}

/** Defines the sign-in "demo" (as `def`), gives its client on the page, and answers the sign-in link;
 *  `base` is AnythingLLM's address. */
async function link(base: string = LLM, def: Record<string, unknown> = definition): Promise<URL> {
  const first = await call({ action: "secret", kind: "oauth", label: "demo", definition: def }, { base });
  assert.match(first, /"demo" needs the user's own OAuth client at the provider \(127\.0\.0\.1:\d+\)/);
  assert.ok(first.includes(base.startsWith("https://") ? `${LLM}/library-lean/oauth.html` : "http://127.0.0.1/library-lean/oauth"), "the redirect address to register");
  assert.deepEqual(vaultState().needs, [{ label: "demo", site: "127.0.0.1", kind: "client" }], "asked for on the page");
  giveClient("demo", { secret: "shh-secret" });
  const second = await call({ action: "secret", kind: "oauth", label: "demo" }, { base });
  assert.equal(cardsShown.length, 0, "never on a card");
  assert.ok(!second.includes("shh-secret"));
  const url = new URL(second.match(/^(http\S+)$/m)![1]);
  provider.challenge = url.searchParams.get("code_challenge") ?? "";
  return url;
}

/** A toolkit whose function calls the provider's /me with the sign-in. */
async function toolkit(): Promise<void> {
  await call({ action: "save", service: "demo", toolkit: { base_urls: [BASE], secrets: [{ label: "demo", as: "bearer" }] }, function: { name: "me", description: "Who signed in.", source: "async function main(i, kit) { const a = await kit.http({ path: '/me' }); if (!a.ok) throw new Error('status ' + a.status); return a.body.name; }" } });
}

test("a sign-in: its definition, the client, the link, the code back through oauth.html, and a call with it", async () => {
  const url = await link();
  assert.equal(url.origin + url.pathname, `${BASE}/authorize`);
  const q = Object.fromEntries(url.searchParams);
  assert.equal(q.client_id, "client-1");
  assert.equal(q.redirect_uri, `${LLM}/library-lean/oauth.html`);
  assert.equal(q.scope, "me.read");
  assert.equal(q.access_type, "offline");
  assert.equal(q.code_challenge_method, "S256");
  assert.ok(fs.existsSync(path.join(publicDir, "library-lean", "oauth.html")), "the page the provider sends the user back to");
  const sFile = path.join(publicDir, "library-lean", `s-${q.state}.json`);
  assert.equal(JSON.parse(fs.readFileSync(sFile, "utf8")).key, "brx-test", "what oauth.html posts with");
  assert.equal(JSON.parse(fs.readFileSync(sFile, "utf8")).label, "demo", "the name its button back to the app says");

  post({ ev: "oauth-code", state: q.state, code: "good-code" }); // as oauth.html posts it: no page secret
  await call({ action: "library" }); // a call from a chat applies what the page posted
  assert.ok(!fs.existsSync(sFile), "used once");
  const vaultText = fs.readFileSync(path.join(storage, "vault-lean", "vault.json"), "utf8");
  assert.ok(!vaultText.includes(provider.access) && !vaultText.includes("shh-secret"), "tokens and client kept encrypted");

  await toolkit();
  const ran = await call({ action: "run", name: "demo.me" });
  assert.match(ran, /: ok, .*Result \(JSON\):\n"Ada"/s);
  assert.ok(!ran.includes(provider.access));
  assert.match(await call({ action: "library", service: "demo" }), /Keys: demo \(bearer, signed in\)/);
});

test("a provider that wants the client by HTTP Basic, and no PKCE, has it so (client_auth, pkce)", async () => {
  const q = Object.fromEntries((await link(LLM, { ...definition, client_auth: "basic", pkce: false })).searchParams);
  assert.equal(q.code_challenge, undefined, "no PKCE in the link");
  post({ ev: "oauth-code", state: q.state, code: "good-code" });
  await call({ action: "library" });
  assert.ok(provider.basic, "the client went by HTTP Basic");
  await toolkit();
  assert.match(await call({ action: "run", name: "demo.me" }), /"Ada"/);
});

test("a token about to run out is renewed once, even for requests at once, and the new one kept", async () => {
  provider.lifetime = 30; // under the minute a token is renewed before it runs out
  const q = Object.fromEntries((await link()).searchParams);
  post({ ev: "oauth-code", state: q.state, code: "good-code" });
  await call({ action: "library" });
  await toolkit();
  const both = "async function main(i, kit) { const [a, b] = await Promise.all([kit.http({ path: '/me' }), kit.http({ path: '/me' })]); return [a.status, b.status]; }";
  const said = await call({ action: "save", service: "demo", function: { name: "both", description: "Two at once.", source: both }, test: {} });
  assert.match(said, /Result \(JSON\):\n\[\n 200,\n 200\n\]/);
  assert.equal(provider.refreshes, 1, "one renewal for both requests: a rotated refresh token is spent once");
  provider.lifetime = 3600;
  assert.match(await call({ action: "run", name: "demo.me" }), /"Ada"/);
  assert.equal(provider.refreshes, 2, "the token kept was the renewed one, itself about to run out");
});

test("a code for a sign-in nobody waits for is ignored, and a refused sign-in says why", async () => {
  const q = Object.fromEntries((await link()).searchParams);
  post({ ev: "oauth-code", state: "not-a-state-anyone-made", code: "good-code" });
  await call({ action: "library" });
  assert.match(JSON.stringify(vaultState().secrets), /"status":"ready to sign in"/, "a code for no waiting sign-in is ignored");
  post({ ev: "oauth-code", state: q.state, error: "access_denied" });
  await call({ action: "library" });
  assert.match(JSON.stringify(vaultState().secrets), /"status":"its last sign-in didn't finish: the provider didn't give a code: access_denied"/, "and why a sign-in didn't finish is shown");
});

test("with ANYTHINGLLM_URL unset, the address the Vault was opened at is learned with the client", async () => {
  const said = await call({ action: "secret", kind: "oauth", label: "demo", definition });
  assert.match(said, /with the redirect address the Vault shows registered/);
  assert.ok(!said.includes("/library-lean/oauth"), "no redirect address the skill can't know");
  assert.equal(vaultState().redirect, null, "nor on the page, which shows its own");
  giveClient("demo", { secret: "shh-secret", origin: "http://phone.example.com" });
  giveClient("demo", { origin: "https://phone.example.com/a/path" });
  assert.match(await call({ action: "secret", kind: "oauth", label: "demo" }), /AnythingLLM's address isn't known/, "only an https origin counts");
  giveClient("demo", { origin: "https://phone.example.com" });
  const link = new URL((await call({ action: "secret", kind: "oauth", label: "demo" })).match(/^(http\S+)$/m)![1]);
  assert.equal(link.searchParams.get("redirect_uri"), "https://phone.example.com/library-lean/oauth.html");
  assert.equal(vaultState().redirect, "https://phone.example.com/library-lean/oauth.html");
  assert.match(await call({ action: "library" }), /: https:\/\/phone\.example\.com\/vault-lean\/[\w-]+\.html\n.*: https:\/\/phone\.example\.com\/library-lean\/[\w-]+\.html$/, "and the pages' links are absolute");
  assert.match(await call({ action: "secret", kind: "oauth", label: "demo" }, { base: "https://llm.example.com" }), /redirect_uri=https%3A%2F%2Fllm\.example\.com%2F/, "ANYTHINGLLM_URL still wins");
});

test("one sign-in per provider: a definition under another name points to the one there", async () => {
  await call({ action: "secret", kind: "oauth", label: "demo", definition }, { base: LLM });
  const said = await call({ action: "secret", kind: "oauth", label: "demo-2", definition }, { base: LLM });
  assert.match(said, /^Library: there's a sign-in at 127\.0\.0\.1:\d+ already: "demo"/);
  assert.deepEqual(vaultState().secrets.map((s: { label: string }) => s.label), ["demo"]);
});

test("without an https address, the sign-in ends on 127.0.0.1, and the user pastes that address into the page", async () => {
  const q = Object.fromEntries((await link("http://192.168.1.5:3001")).searchParams);
  assert.equal(q.redirect_uri, "http://127.0.0.1/library-lean/oauth");
  postVault({ ev: "oauth-code", state: q.state, code: "good-code" }); // as the Vault's paste form posts it
  await call({ action: "library" });
  await toolkit();
  assert.match(await call({ action: "run", name: "demo.me" }), /"Ada"/);
});

test("a definition is checked, and a sign-in that isn't there is said so", async () => {
  assert.match(await call({ action: "secret", kind: "oauth", label: "nope" }), /there's no sign-in "nope": give its definition/);
  assert.match(await call({ action: "secret", kind: "oauth", label: "x", definition: { ...definition, params: { client_id: "sneaky" } } }), /params can't set client_id/);
  assert.match(await call({ action: "secret", kind: "oauth", label: "x", definition: { ...definition, token_url: "ftp://x.example/token" } }), /token_url is an https address/);
  assert.match(await call({ action: "secret", kind: "magic", label: "x" }), /kind is "key" \(an API key or token\) or "oauth"/);
});

// The device flow.

const deviceDef = { site: "127.0.0.1", authorize_url: `${BASE}/authorize`, token_url: `${BASE}/token`, device_url: `${BASE}/device/code`, scopes: "me.read", pkce: false };

/** Defines the device-flow sign-in "dev", gives its client (an ID, no secret) on the page, and
 *  answers the code to show. */
async function code(): Promise<string> {
  const first = await call({ action: "secret", kind: "oauth", label: "dev", definition: deviceDef });
  assert.match(first, /a client with the device flow switched on \(it needs no redirect address\)/);
  giveClient("dev");
  return call({ action: "secret", kind: "oauth", label: "dev" });
}

const devStatus = () => vaultState().secrets.find((s: { label: string }) => s.label === "dev").status;

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
  await call({ action: "save", service: "dev", toolkit: { base_urls: [BASE], secrets: [{ label: "dev", as: "bearer" }] }, function: { name: "me", description: "Who signed in.", source: "async function main(i, kit) { const a = await kit.http({ path: '/me' }); if (!a.ok) throw new Error('status ' + a.status); return a.body.name; }" } });
  assert.match(await call({ action: "run", name: "dev.me" }), /"Ada"/);
  const asked = provider.asks;
  await call({ action: "library" });
  assert.equal(provider.asks, asked, "nothing more is asked once signed in");
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
  assert.match(await call({ action: "secret", kind: "oauth", label: "dev" }), /good for 1 minute\./);
  await new Promise((r) => setTimeout(r, 1100));
  await call({ action: "library" });
  assert.equal(devStatus(), "its last sign-in didn't finish: the code ran out before the user entered it: start the sign-in again");
});

test("a preset is the suite's own client, and an unknown one names the presets", async (t) => {
  assert.match(await call({ action: "secret", kind: "oauth", preset: "nope" }), /there's no preset "nope": the presets are github/);
  const registered = /GITHUB_CLIENT_ID = "([^"]+)"/.test(fs.readFileSync(path.join(skillDir, "src", "presets.ts"), "utf8"));
  // Once it's registered, secret would ask GitHub itself for a code.
  if (registered) return t.skip("the suite's GitHub client is registered");
  assert.match(await call({ action: "secret", kind: "oauth", preset: "github", scopes: "repo" }), /the suite's github client isn't registered yet/);
});

// The device flow, asked again: a second call while a code waits must never make a new one, since the
// user may be entering the first.

/** Forgets what this process kept of the device flow (when to ask, the loop), as a restart of
 *  AnythingLLM does; the vault keeps the code. */
function restart(): void {
  for (const key of ["schedule", "loop", "asking"]) delete (globalThis as Record<symbol, unknown>)[Symbol.for(`anythingllm-suite.library-lean.device.${key}`)];
}

const sameCode = /^The code shown before still waits, and no new one was made: show it again\. Show the user this code in a code block of its own, so they can copy it:\n\n```\nWDJB-MJHT\n```\n/;

test("asked for the code again while it waits, secret shows the same one and makes no other", async () => {
  await code();
  assert.match(await call({ action: "secret", kind: "oauth", label: "dev" }), sameCode);
  assert.match(await call({ action: "secret", kind: "oauth", label: "dev", definition: deviceDef }), sameCode, "the same definition again changes nothing");
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
  assert.match(await call({ action: "secret", kind: "oauth", label: "dev" }), /^"dev" is signed in already: start no new sign-in\./);
  await call({ action: "library" }); // the Vault's state is written again
  assert.equal(devStatus(), "signed in");
  assert.equal(provider.codes, 1);
  assert.match(await call({ action: "secret", kind: "oauth", label: "dev" }), /signed in already/, "and stays so");
  assert.equal(provider.codes, 1);
});

test("a code the provider says ran out ends the sign-in, and the next secret makes a new one", async () => {
  await code();
  provider.expired = true;
  await call({ action: "library" });
  assert.equal(devStatus(), "its last sign-in didn't finish: the code ran out before the user entered it: start the sign-in again");
  provider.expired = false;
  assert.match(await call({ action: "secret", kind: "oauth", label: "dev" }), /^Show the user this code[^]*CODE-0002/);
  assert.equal(provider.codes, 2);
});

test("a restart between the code and the user agreeing: the same code shows, and it finishes", async () => {
  await code();
  restart();
  assert.match(await call({ action: "secret", kind: "oauth", label: "dev" }), sameCode);
  restart();
  provider.agreed = true;
  await call({ action: "library" });
  assert.equal(devStatus(), "signed in");
  assert.equal(provider.codes, 1);
});

test("two chats asking for the code at once get one code", async () => {
  await call({ action: "secret", kind: "oauth", label: "dev", definition: deviceDef });
  giveClient("dev");
  const [a, b] = await Promise.all([call({ action: "secret", kind: "oauth", label: "dev" }, "work"), call({ action: "secret", kind: "oauth", label: "dev" }, "other")]);
  assert.equal(provider.codes, 1);
  for (const said of [a, b]) assert.match(said, /```\nWDJB-MJHT\n```/);
});

/** secrets.ts's saveSignIn and oauth.ts's define, bundled as the handler is (src imports without
 *  extensions, which Node alone doesn't resolve). */
async function fromSrc(): Promise<{ saveSignIn: (site: string, label: string, oauth: unknown, shared?: string) => Promise<void>; define: (given: Record<string, unknown>) => unknown }> {
  const { build } = await import("esbuild");
  const outfile = path.join(storage, "..", "from-src.mjs");
  await build({ stdin: { contents: 'export { saveSignIn } from "./secrets"; export { define } from "./oauth";', resolveDir: path.join(skillDir, "src"), loader: "ts" }, bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent" });
  return import(outfile);
}

test("a preset's sign-in takes no definition: the code waiting stays, and so do the tokens", async () => {
  // A preset's sign-in, as presetOf saves one, but at the stand-in provider rather than GitHub.
  const { saveSignIn, define } = await fromSrc();
  await saveSignIn("127.0.0.1", "gh", define(deviceDef), "client-1");
  assert.match(await call({ action: "secret", kind: "oauth", label: "gh" }), /```\nWDJB-MJHT\n```/);
  const redefined = await call({ action: "secret", kind: "oauth", label: "gh", definition: { ...deviceDef, scopes: ["repo", "read:user", "workflow"], client_auth: "basic" } });
  assert.match(redefined, /"gh" signs in with a preset, the suite's own client: don't give it a definition\./);
  assert.equal(provider.codes, 1);
  provider.agreed = true;
  await call({ action: "library" });
  const gh = () => vaultState().secrets.find((s: { label: string }) => s.label === "gh");
  assert.equal(gh().status, "signed in");
  assert.match(await call({ action: "secret", kind: "oauth", label: "gh", definition: deviceDef }), /signs in with a preset/);
  assert.equal(gh().status, "signed in", "a refused definition drops no tokens");
});
