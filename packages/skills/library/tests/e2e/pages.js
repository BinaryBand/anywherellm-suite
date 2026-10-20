// Run inside a stock AnythingLLM container whose server is running (podman exec; see the skill's
// notes): the Vault as AnythingLLM really serves it and really takes what it posts. The
// pages' key is the one install was given (--page-key); the page and its state are fetched from the
// server; a key is given through the real browser-extension upload (the collector writes the event)
// and lands in the vault. Prints "ok" or throws.
const assert = require("assert");
const crypto = require("crypto");
const { HUB_ID } = process.env;
const APP = "/app/server";
const SERVER = "http://127.0.0.1:3001";

const ImportedPlugin = require(`${APP}/utils/agents/imported.js`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
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
  assert.deepEqual(state.needs, [{ label: "ex", site: "api.example.com" }], "the server serves the page's state");

  const pub = crypto.createPublicKey({ key: Buffer.from(cfg.pub, "base64"), format: "der", type: "spki" });
  // Sealed as the page seals it, with the vault's public key.
  const seal = (text) => crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(text)).toString("base64");
  const sealed = seal("e2e-api-key");
  // Posted as the Vault posts in its keys section.
  const postEvent = (event) =>
    fetch(SERVER + "/api/browser-extension/upload-content", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.key },
      body: JSON.stringify({ textContent: JSON.stringify({ vault_lean_event: 1, ...event }), metadata: { title: "vault-lean-keys", docSource: "e2e" } }),
    });
  const posted = await postEvent({ secret: cfg.secret, ev: "key-save", label: "ex", site: "api.example.com", sealed });
  assert.equal(posted.status, 200, "AnythingLLM took the event");
  const stateOf = async () => (await fetch(SERVER + pagePath.replace(/\.html$/, "-keys.json"))).json();
  let secrets = [];
  for (let i = 0; i < 40 && !secrets.length; i++) {
    await sleep(250);
    await call({ action: "library" });
    secrets = (await stateOf()).secrets;
  }
  assert.deepEqual(secrets, [{ site: "api.example.com", label: "ex", kind: "key", status: "saved" }], "the key the page posted is in the vault");

  // The links kept from the agent (`anywherellm-suite pages --hide` writes this file on the host): the
  // pages are still served, the answers carry no link, the links file has the two paths the bridge
  // reads, and turning the switch on replaced both pages' addresses once.
  const fs = require("fs");
  const dir = `${process.env.STORAGE_DIR || `${APP}/storage`}/anywherellm-suite`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/page-links-hidden`, new Date().toISOString() + "\n");
  try {
    const hidden = await call({ action: "library" });
    assert.ok(!/vault-lean\/|library-lean\/|\.html/.test(hidden), "no page link in the answer");
    assert.match(hidden, /You are never given their links/);
    const linksPath = `${dir}/page-links.json`;
    assert.equal(fs.statSync(linksPath).mode & 0o777, 0o600, "the links file is the owner's alone");
    const links = JSON.parse(fs.readFileSync(linksPath, "utf8"));
    assert.match(links.vault, /^\/vault-lean\/[\w-]+\.html$/);
    assert.match(links.library, /^\/library-lean\/[\w-]+\.html$/);
    assert.notEqual(links.vault, pagePath, "turning the switch on replaced the Vault's address");
    assert.equal((await fetch(SERVER + pagePath)).status, 404, "the old address is gone");
    const page = await fetch(SERVER + links.vault);
    assert.equal(page.status, 200, "AnythingLLM serves the page at the address the links file holds");
    const cfg2 = JSON.parse((await page.text()).match(/const cfg = (\{.*?\});/)[1]);
    assert.notEqual(cfg2.secret, cfg.secret, "and with a new secret");
    for (const part of [links.vault, links.library]) assert.ok(!hidden.includes(part.split("/")[2].replace(".html", "")), "no token in the answer");
    // A key given on the new page still lands in the vault.
    const keyed = await postEvent({ secret: cfg2.secret, ev: "key-save", label: "ex2", site: "api.example.com", sealed: seal("e2e-api-key-2") });
    assert.equal(keyed.status, 200);
    let again = [];
    for (let i = 0; i < 40 && !again.some((s) => s.label === "ex2"); i++) {
      await sleep(250);
      await call({ action: "library" });
      again = (await (await fetch(SERVER + links.vault.replace(/\.html$/, "-keys.json"))).json()).secrets;
    }
    assert.ok(again.some((s) => s.label === "ex2" && s.status === "saved"), "a key given on the new page is in the vault");
  } finally {
    fs.rmSync(`${dir}/page-links-hidden`, { force: true });
  }

  console.log("ok");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
