// OAuth sign-ins, against a stand-in provider on 127.0.0.1: the definition, the user's client on the
// Library page, the sign-in link (PKCE), the code coming back through oauth.html's event, the tokens sent by
// a function and renewed once as they run out, and the paste fallback.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { call, cardsShown, pageConfig, pageState, post, publicDir, reset, seal, storage } from "./harness.mts";

// The provider: a token endpoint that checks the client and PKCE and rotates refresh tokens, and an
// API that wants the current access token.
const provider = { challenge: "", refreshes: 0, access: "", refresh: "", lifetime: 3600, spent: new Set<string>() };
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = (status: number, value: unknown) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(value)));
    if (req.url === "/token") {
      const form = new URLSearchParams(body);
      if (form.get("client_id") !== "client-1" || form.get("client_secret") !== "shh-secret") return json(401, { error: "invalid_client" });
      if (form.get("grant_type") === "authorization_code") {
        const challenge = crypto.createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (form.get("code") !== "good-code" || challenge !== provider.challenge) return json(400, { error: "invalid_grant" });
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
  Object.assign(provider, { challenge: "", refreshes: 0, access: "", refresh: "", lifetime: 3600, spent: new Set() });
});

/** Defines the sign-in "demo", gives its client on the page, and answers the sign-in link; `base`
 *  is AnythingLLM's address. */
async function link(base: string = LLM): Promise<URL> {
  const first = await call({ action: "secret", kind: "oauth", label: "demo", definition }, { base });
  assert.match(first, /"demo" needs the user's own OAuth client at the provider \(127\.0\.0\.1:\d+\)/);
  assert.ok(first.includes(base.startsWith("https://") ? `${LLM}/library-lean/oauth.html` : "http://127.0.0.1/library-lean/oauth"), "the redirect address to register");
  assert.deepEqual(pageState().needs, [{ label: "demo", site: "127.0.0.1", kind: "client" }], "asked for on the page");
  post({ secret: pageConfig().secret, ev: "oauth-client", label: "demo", client_id: "client-1", sealed: seal("shh-secret") });
  const second = await call({ action: "secret", kind: "oauth", label: "demo" }, { base });
  assert.equal(cardsShown.length, 0, "never on a card");
  assert.ok(!second.includes("shh-secret"));
  const url = new URL(second.match(/^(http\S+)$/m)![1]);
  provider.challenge = url.searchParams.get("code_challenge")!;
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
  assert.match(JSON.parse(fs.readFileSync(sFile, "utf8")).key, /^brx-test-\d+$/, "what oauth.html posts with, for this sign-in only");

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
  assert.match(JSON.stringify(pageState().secrets), /"status":"ready to sign in"/, "a code for no waiting sign-in is ignored");
  post({ ev: "oauth-code", state: q.state, error: "access_denied" });
  await call({ action: "library" });
  assert.match(JSON.stringify(pageState().secrets), /"status":"its last sign-in didn't finish: the provider didn't give a code: access_denied"/, "and why a sign-in didn't finish is shown");
});

test("with ANYTHINGLLM_URL unset, the answer says so and gives no redirect address", async () => {
  const said = await call({ action: "secret", kind: "oauth", label: "demo", definition });
  assert.match(said, /ANYTHINGLLM_URL is empty/);
  assert.ok(!said.includes("/library-lean/oauth"), "no redirect address");
  await call({ action: "library" });
  assert.equal(pageState().redirect, null, "nor on the page");
});

test("one sign-in per provider: a definition under another name points to the one there", async () => {
  await call({ action: "secret", kind: "oauth", label: "demo", definition }, { base: LLM });
  const said = await call({ action: "secret", kind: "oauth", label: "demo-2", definition }, { base: LLM });
  assert.match(said, /^Library: there's a sign-in at 127\.0\.0\.1:\d+ already: "demo"/);
  assert.deepEqual(pageState().secrets.map((s: { label: string }) => s.label), ["demo"]);
});

test("without an https address, the sign-in ends on 127.0.0.1, and the user pastes that address into the page", async () => {
  const q = Object.fromEntries((await link("http://192.168.1.5:3001")).searchParams);
  assert.equal(q.redirect_uri, "http://127.0.0.1/library-lean/oauth");
  post({ ev: "oauth-code", state: q.state, code: "good-code" }); // as the page's paste form posts it
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
