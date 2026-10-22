// The library's pages: the Vault's keys section and the Library page, written where AnythingLLM
// serves them, showing nothing secret, and what the user does on them (posted as AnythingLLM's
// collector writes it) applied and told to the agent.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { linksFile, readLinks } from "#shared/page-links";
import { call, giveKey, hideLinks, library, pageConfig, pageState, post, postVault, publicDir, reset, seal, skillDir, storage, until, vaultConfig, vaultState } from "./harness.mts";

const KEY = "page-key-0123456789";
test.beforeEach(reset);

const vaultFile = (name: string) => path.join(publicDir, "vault-lean", name);

test("library ends with the Vault's link and the Library page's: relative, or absolute with ANYTHINGLLM_URL", async () => {
  assert.match(await call({ action: "library" }), /The Vault, the user's own view of every key and browser login, by name: \/vault-lean\/[\w-]+\.html\nThe Library page, the user's own view of the toolkits and runs: \/library-lean\/[\w-]+\.html$/);
  const said = await call({ action: "library" }, { base: "https://llm.example.com/" });
  const { token, key, secret } = pageConfig();
  assert.ok(said.endsWith(`https://llm.example.com/library-lean/${token}.html`));
  assert.ok(said.includes(`https://llm.example.com/vault-lean/${vaultConfig().token}.html\n`));
  assert.equal(key, "brx-test", "the page posts with the browser-extension key install keeps");
  assert.equal(vaultConfig().key, "brx-test");
  assert.ok(secret.length >= 20);
  assert.notEqual(vaultConfig().secret, secret, "the Vault has a secret of its own");
  assert.equal(pageState().vault, `https://llm.example.com/vault-lean/${vaultConfig().token}.html`, "the Library page links to the Vault");
});

test("with the links kept from the agent the pages are still written, the Library page's path is in the links file, and the page still links to the Vault", async () => {
  hideLinks(true);
  await call({ action: "library" }, { base: "https://llm.example.com/" });
  const { token } = pageConfig();
  assert.ok(fs.existsSync(path.join(publicDir, "library-lean", `${token}.html`)), "the page is written");
  assert.equal(readLinks().library, `/library-lean/${token}.html`, "root-relative, whatever ANYTHINGLLM_URL is");
  assert.equal(fs.statSync(linksFile()).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(library, "page.json"), "utf8")).hidden, true, "made under the switch, so marked");
  assert.equal(pageState().vault, `https://llm.example.com/vault-lean/${vaultConfig().token}.html`, "the Library page links to the Vault");
});

test("the Vault shows a saved key by name only, never its value, and only the library's section", async () => {
  await giveKey("ex", "api.example.com", KEY);
  await call({ action: "library" });
  const state = vaultState();
  assert.deepEqual(state.secrets, [{ label: "ex", site: "api.example.com" }]);
  assert.ok(!JSON.stringify(state).includes(KEY));
  assert.ok(!fs.readFileSync(vaultFile(`${vaultConfig().token}.html`), "utf8").includes(KEY));
  assert.ok(!fs.existsSync(vaultFile(`${vaultConfig().token}-logins.json`)), "no logins section without the browser");
});

test("a key and a target asked for under one label are on their own pages, and one given doesn't meet the other", async () => {
  await call({ action: "secret", site: "api.example.com", label: "pi" });
  await call({ action: "secret", kind: "ssh", label: "pi" });
  assert.deepEqual(vaultState().needs, [{ label: "pi", site: "api.example.com" }], "the key's need is on the Vault");
  assert.deepEqual(pageState().needs, [{ label: "pi", site: "" }], "the target's is on the Library page");
  postVault({ ev: "key-save", label: "pi", site: "api.example.com", sealed: seal(KEY) });
  await call({ action: "library" });
  assert.deepEqual(vaultState().needs, [], "the key's need is met");
  assert.deepEqual(pageState().needs, [{ label: "pi", site: "" }], "the target's is not");
});

test("a key is asked for on the Vault, given there, and the agent is told", async () => {
  const asked = await call({ action: "secret", site: "api.example.com", label: "ex" });
  assert.match(asked, /^The user gives the key on the Vault: \/vault-lean\/[\w-]+\.html\n/);
  assert.deepEqual(vaultState().needs, [{ label: "ex", site: "api.example.com" }]);
  postVault({ ev: "key-save", label: "ex", site: "api.example.com", sealed: seal(KEY) });
  await call({ action: "library" });
  assert.deepEqual(vaultState().needs, [], "the need is met");
  assert.deepEqual(vaultState().secrets, [{ label: "ex", site: "api.example.com" }]);
});

test("an event without the page's secret (an old link's, or a forgery) is dropped", async () => {
  await call({ action: "library" });
  postVault({ secret: "not-the-secret", ev: "key-save", label: "x", site: "api.example.com", sealed: seal(KEY) });
  postVault({ secret: pageConfig().secret, ev: "key-save", label: "y", site: "api.example.com", sealed: seal(KEY) }); // the Library page's, not the Vault's
  post({ secret: undefined, ev: "toolkit-delete", service: "x" });
  await call({ action: "library" });
  assert.deepEqual(vaultState().secrets, []);
});

test("the user deletes a key on the Vault, and a function or a toolkit on the Library page", async () => {
  await giveKey("ex", "api.example.com", KEY);
  await call({ action: "save", service: "ex", toolkit: { base_urls: ["https://api.example.com"] }, function: { name: "one", description: "One.", source: "async function main() { return 1; }" } });
  await call({ action: "save", service: "ex", function: { name: "two", description: "Two.", source: "async function main() { return 2; }" } });
  await call({ action: "library" });
  post({ ev: "fn-delete", fn: "ex.one" });
  postVault({ ev: "key-delete", label: "ex" });
  const said = await call({ action: "library", service: "ex" });
  assert.match(said, /Functions:\n- ex\.two\(\)/);
  assert.deepEqual(vaultState().secrets, []);
  post({ ev: "toolkit-delete", service: "ex" });
  assert.match(await call({ action: "library" }), /^The library is empty/);
});

test("a new Library page link replaces the old one, whose files are removed and whose secret no longer works", async () => {
  await call({ action: "save", service: "ex", toolkit: { base_urls: ["https://api.example.com"] }, function: { name: "one", description: "One.", source: "async function main() { return 1; }" } });
  await call({ action: "library" });
  const old = pageConfig();
  post({ secret: old.secret, ev: "rotate" });
  await call({ action: "library" });
  const now = pageConfig();
  assert.notEqual(now.token, old.token);
  for (const ending of [".html", ".json"]) assert.ok(!fs.existsSync(path.join(publicDir, "library-lean", `${old.token}${ending}`)), ending);
  post({ secret: old.secret, ev: "fn-delete", fn: "ex.one" });
  assert.match(await call({ action: "library", service: "ex" }), /Functions:\n- ex\.one\(\)/, "the old secret deletes nothing");
});

test("a new Vault link moves every section's state to the new name, and the old secret no longer works", async () => {
  await call({ action: "library" });
  const old = vaultConfig();
  fs.writeFileSync(vaultFile(`${old.token}-logins.json`), JSON.stringify({ logins: [] })); // the browser's section, as it writes it
  postVault({ ev: "rotate" });
  await call({ action: "library" });
  const now = vaultConfig();
  assert.notEqual(now.token, old.token);
  assert.ok(!fs.existsSync(vaultFile(`${old.token}.html`)));
  for (const section of ["keys", "logins"]) {
    assert.ok(fs.existsSync(vaultFile(`${now.token}-${section}.json`)), section);
    assert.ok(!fs.existsSync(vaultFile(`${old.token}-${section}.json`)), section);
  }
  postVault({ secret: old.secret, ev: "key-save", label: "x", site: "api.example.com", sealed: seal(KEY) });
  await call({ action: "library" });
  assert.deepEqual(vaultState().secrets, []);
});

test("a newer Vault page another skill wrote isn't written over", async () => {
  await call({ action: "library" });
  const file = vaultFile(`${vaultConfig().token}.html`);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/"version":\d+/, '"version":999'));
  await call({ action: "library" });
  assert.match(fs.readFileSync(file, "utf8"), /"version":999/);
});

test("while the Vault is open, what the user does is applied without waiting for the agent", async () => {
  await call({ action: "library" });
  postVault({ ev: "key-save", label: "live", site: "api.example.com", sealed: seal(KEY) });
  let state = vaultState();
  for (let i = 0; i < 100 && !state.secrets.length; i++) {
    await new Promise((r) => setTimeout(r, 50));
    state = vaultState();
  }
  assert.deepEqual(state.secrets.map((s: { label: string }) => s.label), ["live"], "the section's state was written again by the watch");
});

const FINGERPRINT = `SHA256:${"A".repeat(43)}`;
const saveTarget = (fields: Record<string, unknown> = {}) => post({ ev: "target-save", label: "box", host: "box.internal", port: "22", login: "sandbox", fingerprint: FINGERPRINT, private: true, sealed: "", ...fields });

test("a target the user deletes with the page open is gone from its state without the agent's next call", async () => {
  await call({ action: "library" });
  saveTarget();
  // Once its sign-in has been tried: a try still going would write the state again after the delete, and hide that the delete doesn't.
  await until(() => pageState().targets[0]?.status && pageState().targets[0].status !== "not tried yet", 15000);
  post({ ev: "target-delete", label: "box" });
  await until(() => pageState().targets.length === 0);
});

test("a save posted with another page's secret is dropped: no target, and no word of one saved", async () => {
  await call({ action: "library" });
  saveTarget({ label: "forged", secret: "not-the-secret" });
  saveTarget({ label: "real" }); // after it, so that the forgery was taken before this was applied
  await until(() => pageState().result?.n === 1);
  assert.deepEqual(pageState().result, { n: 1, ev: "target-save", label: "real", error: null });
  assert.deepEqual(pageState().targets.map((m: { label: string }) => m.label), ["real"]);
  saveTarget({ label: "forged", secret: "not-the-secret" });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(pageState().result.n, 1, "a forgery alone makes no result");
});

test("what the skill refuses on a target the user saves reaches the page in its own words, one reason each; a save that works says so", async () => {
  await call({ action: "library" });
  assert.equal(pageState().result, null);
  const refusals: [Record<string, unknown>, RegExp][] = [
    [{ sealed: seal("not a key") }, /isn't a private key/],
    [{ fingerprint: "SHA256:short" }, /needs its host key's fingerprint/],
    [{ private: false }, /tick "On my network"/],
    [{ host: "bad host!" }, /host is a name or an address/],
  ];
  let n = 0;
  for (const [fields, why] of refusals) {
    saveTarget({ label: "bad", ...fields });
    n++;
    await until(() => pageState().result?.n === n);
    assert.equal(pageState().result.ev, "target-save");
    assert.match(pageState().result.error, why);
  }
  assert.deepEqual(pageState().targets, [], "nothing was saved");
  saveTarget();
  n++;
  await until(() => pageState().result?.n === n);
  assert.deepEqual(pageState().result, { n, ev: "target-save", label: "box", error: null });
});

test("an event that breaks (not a refusal) is logged, and the events after it are still applied", async () => {
  await call({ action: "save", service: "ex", toolkit: { base_urls: ["https://api.example.com"] }, function: { name: "one", description: "One.", source: "async function main() { return 1; }" } });
  await call({ action: "save", service: "ex", function: { name: "two", description: "Two.", source: "async function main() { return 2; }" } });
  await call({ action: "library" });
  fs.mkdirSync(path.join(library, "toolkits", "ex", "state", "one.json", "x"), { recursive: true }); // removing one's state fails with EISDIR, not a refusal
  post({ ev: "fn-delete", fn: "ex.one" });
  post({ ev: "fn-delete", fn: "ex.two" });
  const said = await call({ action: "library", service: "ex" });
  assert.doesNotMatch(said, /ex\.two\(/, "the event after the one that broke was applied");
});

// Drift: what the pages post and read must be what the skill applies and writes.

const pageSource = (name: string) => fs.readFileSync(path.join(skillDir, "static", "pages", name), "utf8");
const vaultSource = () => fs.readFileSync(path.join(skillDir, "..", "..", "shared", "vault.html"), "utf8");
const source = fs.readFileSync(path.join(skillDir, "src", "page.ts"), "utf8");
const handled = (fn: string) => [...source.slice(source.indexOf(`function ${fn}(`)).split("\n}\n")[0].matchAll(/case "([a-z-]+)":|e\.ev === "([a-z-]+)"/g)].map((m) => m[1] || m[2]);

test("every event the pages post is one the skill applies", () => {
  const posted = [...pageSource("library.html").matchAll(/post\("([a-z-]+)"|remove\("[^"]*", "([a-z-]+)"/g)].map((m) => m[1] || m[2]);
  assert.ok(posted.length >= 3);
  for (const ev of posted) assert.ok(handled("apply").includes(ev), ev);
  const keys = [...vaultSource().matchAll(/post\("keys", "([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 4);
  for (const ev of [...keys, "rotate"]) assert.ok(handled("applyKeys").includes(ev), `keys: ${ev}`);
});

test("every field the pages read from their state is one the skill writes", async () => {
  await giveKey("ex", "api.example.com", KEY);
  await call({ action: "secret", site: "api.other.example", label: "other" });
  await call({ action: "save", service: "ex", toolkit: { base_urls: ["https://api.example.com"] }, function: { name: "one", description: "One.", source: "async function main() { return 1; }" }, test: {} });
  await call({ action: "secret", kind: "ssh", label: "pi" });
  postVault({ ev: "signing-new", label: "signer", namespace: "test-ns" });
  await call({ action: "library" });
  const state = pageState();
  const html = pageSource("library.html");
  for (const [, field] of html.matchAll(/\bs\.([a-z_]+)/g)) assert.ok(field in state, `s.${field}`);
  const items = { t: state.toolkits[0], f: state.toolkits[0].functions[0], r: state.runs[0], need: state.needs[0] };
  for (const [name, item] of Object.entries(items)) for (const [, field] of html.matchAll(new RegExp(`\\b${name}\\.([a-z_]+)`, "g"))) assert.ok(field in item, `${name}.${field}`);
  const keys = vaultState();
  const vault = vaultSource();
  for (const [, field] of vault.matchAll(/\bks\.([a-z_]+)/g)) assert.ok(field in keys, `ks.${field}`);
  const vaultItems = { k: keys.secrets[0], n: keys.needs[0], g: keys.signing[0] };
  for (const [name, item] of Object.entries(vaultItems)) {
    assert.ok(item, name);
    for (const [, field] of vault.matchAll(new RegExp(`\\b${name}\\.([a-z_]+)`, "g"))) assert.ok(field in item, `${name}.${field}`);
  }
  assert.ok(fs.existsSync(path.join(library, "page.json")));
  assert.ok(fs.existsSync(path.join(storage, "vault-lean", "vault-page.json")));
});
