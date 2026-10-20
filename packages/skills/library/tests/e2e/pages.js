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

  console.log("ok");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
