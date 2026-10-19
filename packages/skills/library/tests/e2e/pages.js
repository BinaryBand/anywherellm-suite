// Run inside a stock AnythingLLM container whose server is running (podman exec; see the skill's
// notes): the Vault as AnythingLLM really serves it and really takes what it posts. The
// pages' key is the one install was given (--page-key); the page and its state are fetched from the
// server; a key is given through the real browser-extension upload (the collector writes the event)
// and lands in the vault; then an OAuth sign-in against a stand-in provider, its client given on the
// page and its code posted the way
// oauth.html posts it, with the key from the file the server serves for that sign-in.
// Prints "ok" or throws.
const assert = require("assert");
const crypto = require("crypto");
const http = require("http");
const { HUB_ID } = process.env;
const APP = "/app/server";
const SERVER = "http://127.0.0.1:3001";
const PORT = 18084;

const ImportedPlugin = require(`${APP}/utils/agents/imported.js`);

const provider = { challenge: "", access: "" };
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/token") {
      const form = new URLSearchParams(body);
      const challenge = crypto.createHash("sha256").update(form.get("code_verifier") || "").digest("base64url");
      if (form.get("code") !== "e2e-code" || challenge !== provider.challenge || form.get("client_secret") !== "e2e-secret") return ((res.statusCode = 400), res.end('{"error":"invalid_grant"}'));
      provider.access = "e2e-access-" + crypto.randomUUID();
      return res.end(JSON.stringify({ access_token: provider.access, refresh_token: "e2e-refresh", expires_in: 3600 }));
    }
    if (req.url === "/me") return res.end(req.headers.authorization === `Bearer ${provider.access}` ? '{"name":"Ada"}' : '{"error":"no"}');
    res.statusCode = 404;
    res.end("{}");
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const plugin = ImportedPlugin.loadPluginByHubId(HUB_ID).plugin({ ANYTHINGLLM_URL: SERVER }); // the skill's setting, as AnythingLLM passes it
  const call = async (args) => {
    let fn;
    const agent = {
      handlerProps: { invocation: { workspace: { slug: "check" }, thread_id: 1 }, log: (m) => console.error(m) },
      function: (def) => (fn = def),
    };
    plugin.setup(agent);
    return fn.handler.call(fn, args);
  };

  // A key, given on the Vault.
  const asked = await call({ action: "secret", site: "api.example.com", label: "ex" });
  const pagePath = asked.match(/(\/vault-lean\/[\w-]+\.html)/)[1];
  const html = await (await fetch(SERVER + pagePath)).text();
  const cfg = JSON.parse(html.match(/const cfg = (\{.*?\});/)[1]);
  assert.match(cfg.key, /^brx-/, "the browser-extension key install was given");
  const state = await (await fetch(SERVER + pagePath.replace(/\.html$/, "-keys.json"))).json();
  assert.deepEqual(state.needs, [{ label: "ex", site: "api.example.com", kind: "key" }], "the server serves the page's state");

  const pub = crypto.createPublicKey({ key: Buffer.from(cfg.pub, "base64"), format: "der", type: "spki" });
  // Sealed as the page seals it, with the vault's public key.
  const seal = (text) => crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(text)).toString("base64");
  const sealed = seal("e2e-api-key");
  // Posted as the Vault posts in its keys section, or (with `title`) as oauth.html posts.
  const postEvent = (key, event, title = "vault-lean-keys") =>
    fetch(SERVER + "/api/browser-extension/upload-content", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ textContent: JSON.stringify({ [title === "vault-lean-keys" ? "vault_lean_event" : "library_lean_event"]: 1, ...event }), metadata: { title, docSource: "e2e" } }),
    });
  const posted = await postEvent(cfg.key, { secret: cfg.secret, ev: "key-save", label: "ex", site: "api.example.com", sealed });
  assert.equal(posted.status, 200, "AnythingLLM took the event");
  const stateOf = async () => (await fetch(SERVER + pagePath.replace(/\.html$/, "-keys.json"))).json();
  let secrets = [];
  for (let i = 0; i < 40 && !secrets.length; i++) {
    await sleep(250);
    await call({ action: "library" });
    secrets = (await stateOf()).secrets;
  }
  assert.deepEqual(secrets, [{ site: "api.example.com", label: "ex", kind: "key", status: "saved" }], "the key the page posted is in the vault");

  // An OAuth sign-in, its code posted as oauth.html posts it.
  const definition = { site: "127.0.0.1", authorize_url: `http://127.0.0.1:${PORT}/authorize`, token_url: `http://127.0.0.1:${PORT}/token`, scopes: "me" };
  await call({ action: "secret", kind: "oauth", label: "demo", definition });
  assert.equal((await postEvent(cfg.key, { secret: cfg.secret, ev: "oauth-client", label: "demo", client_id: "e2e-client", sealed: seal("e2e-secret") })).status, 200);
  let linkAnswer = "";
  for (let i = 0; i < 40 && !/^http/m.test(linkAnswer); i++) {
    await sleep(250);
    linkAnswer = await call({ action: "secret", kind: "oauth", label: "demo" });
  }
  const linkLine = linkAnswer.match(/^(http\S+)$/m);
  assert.ok(linkLine, `a sign-in link, not: ${linkAnswer}`);
  const link = new URL(linkLine[1]);
  provider.challenge = link.searchParams.get("code_challenge");
  const state2 = link.searchParams.get("state");
  const sFile = await (await fetch(`${SERVER}/library-lean/s-${state2}.json`)).json();
  assert.equal((await fetch(`${SERVER}/library-lean/oauth.html`)).status, 200, "the page a provider sends the user back to");
  assert.equal((await postEvent(sFile.key, { ev: "oauth-code", state: state2, code: "e2e-code" }, sFile.title)).status, 200);
  let status = "";
  for (let i = 0; i < 40 && status !== "signed in"; i++) {
    await sleep(250);
    await call({ action: "library" });
    status = (await stateOf()).secrets.find((s) => s.label === "demo")?.status;
  }
  assert.equal(status, "signed in");
  await call({ action: "save", service: "demo", toolkit: { base_urls: [`http://127.0.0.1:${PORT}`], secrets: [{ label: "demo", as: "bearer" }] }, function: { name: "me", description: "Who.", source: "async function main(i, kit) { return (await kit.http({ path: '/me' })).body.name; }" } });
  assert.match(await call({ action: "run", name: "demo.me" }), /"Ada"/);

  server.close();
  console.log("ok");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
