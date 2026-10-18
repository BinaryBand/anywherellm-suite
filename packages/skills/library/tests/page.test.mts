// The Library page: written where AnythingLLM serves it, showing nothing secret, and what the user
// does on it (posted as AnythingLLM's collector writes it) applied and told to the agent.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { call, giveKey, library, pageConfig, pageState, post, publicDir, reset, seal, skillDir } from "./harness.mts";

const KEY = "page-key-0123456789";
test.beforeEach(reset);

test("library ends with the page's link: relative, or absolute with ANYTHINGLLM_URL", async () => {
  assert.match(await call({ action: "library" }), /The Library page, the user's own view of it \(keys, sign-ins, toolkits, runs\): \/library-lean\/[\w-]+\.html$/);
  const said = await call({ action: "library" }, { base: "https://llm.example.com/" });
  const { token, key, secret } = pageConfig();
  assert.ok(said.endsWith(`https://llm.example.com/library-lean/${token}.html`));
  assert.equal(key, "brx-test", "the page posts with the browser-extension key install keeps");
  assert.ok(secret.length >= 20);
});

test("the page shows a saved key by name only, never its value", async () => {
  await giveKey("ex", "api.example.com", KEY);
  await call({ action: "library" });
  const state = pageState();
  assert.deepEqual(state.secrets, [{ label: "ex", site: "api.example.com", kind: "key", status: "saved" }]);
  assert.ok(!JSON.stringify(state).includes(KEY));
  assert.ok(!fs.readFileSync(path.join(publicDir, "library-lean", `${pageConfig().token}.html`), "utf8").includes(KEY));
});

test("a key is asked for on the page, given there, and the agent is told", async () => {
  const asked = await call({ action: "secret", site: "api.example.com", label: "ex" });
  assert.match(asked, /^The user gives the key on the Library page: \/library-lean\/[\w-]+\.html\n/);
  assert.deepEqual(pageState().needs, [{ label: "ex", site: "api.example.com", kind: "key" }]);
  post({ secret: pageConfig().secret, ev: "key-save", label: "ex", site: "api.example.com", sealed: seal(KEY) });
  await call({ action: "library" });
  assert.deepEqual(pageState().needs, [], "the need is met");
  assert.equal(pageState().secrets[0].status, "saved");
});

test("an event without the page's secret (an old link's, or a forgery) is dropped", async () => {
  await call({ action: "library" });
  post({ secret: "not-the-secret", ev: "key-save", label: "x", site: "api.example.com", sealed: seal(KEY) });
  post({ ev: "toolkit-delete", service: "x" });
  await call({ action: "library" });
  assert.deepEqual(pageState().secrets, []);
});

test("the user deletes a key, a function or a toolkit on the page", async () => {
  await giveKey("ex", "api.example.com", KEY);
  await call({ action: "save", service: "ex", toolkit: { base_urls: ["https://api.example.com"] }, function: { name: "one", description: "One.", source: "async function main() { return 1; }" } });
  await call({ action: "save", service: "ex", function: { name: "two", description: "Two.", source: "async function main() { return 2; }" } });
  await call({ action: "library" });
  const { secret } = pageConfig();
  post({ secret, ev: "fn-delete", fn: "ex.one" });
  post({ secret, ev: "key-delete", label: "ex" });
  const said = await call({ action: "library", service: "ex" });
  assert.match(said, /Functions:\n- ex\.two\(\)/);
  assert.deepEqual(pageState().secrets, []);
  post({ secret, ev: "toolkit-delete", service: "ex" });
  assert.match(await call({ action: "library" }), /^The library is empty/);
});

test("a new link replaces the old one, whose files are removed and whose secret no longer works", async () => {
  await call({ action: "library" });
  const old = pageConfig();
  post({ secret: old.secret, ev: "rotate" });
  await call({ action: "library" });
  const now = pageConfig();
  assert.notEqual(now.token, old.token);
  assert.ok(!fs.existsSync(path.join(publicDir, "library-lean", `${old.token}.html`)));
  assert.ok(!fs.existsSync(path.join(publicDir, "library-lean", `${old.token}.json`)));
  post({ secret: old.secret, ev: "key-save", label: "x", site: "api.example.com", sealed: seal(KEY) });
  await call({ action: "library" });
  assert.deepEqual(pageState().secrets, []);
});

test("while the page is open, what the user does is applied without waiting for the agent", async () => {
  await call({ action: "library" });
  post({ secret: pageConfig().secret, ev: "key-save", label: "live", site: "api.example.com", sealed: seal(KEY) });
  let state = pageState();
  for (let i = 0; i < 100 && !state.secrets.length; i++) {
    await new Promise((r) => setTimeout(r, 50));
    state = pageState();
  }
  assert.deepEqual(state.secrets.map((s: { label: string }) => s.label), ["live"], "the page's state was written again by the watch");

});

// Drift: what the pages post and read must be what the skill applies and writes.

const pageSource = (name: string) => fs.readFileSync(path.join(skillDir, "static", "pages", name), "utf8");
const handled = [...fs.readFileSync(path.join(skillDir, "src", "page.ts"), "utf8").matchAll(/case "([a-z-]+)":|e\.ev === "([a-z-]+)"/g)].map((m) => m[1] || m[2]);

test("every event the pages post is one the skill applies", () => {
  const posted = [...pageSource("library.html").matchAll(/post\("([a-z-]+)"|remove\("[^"]*", "([a-z-]+)"/g), ...pageSource("oauth.html").matchAll(/ev: "([a-z-]+)"/g)].map((m) => m[1] || m[2]);
  assert.ok(posted.length >= 7);
  for (const ev of posted) assert.ok(handled.includes(ev), ev);
});

test("every field the page reads from its state is one the skill writes", async () => {
  await giveKey("ex", "api.example.com", KEY);
  await call({ action: "save", service: "ex", toolkit: { base_urls: ["https://api.example.com"] }, function: { name: "one", description: "One.", source: "async function main() { return 1; }" }, test: {} });
  await call({ action: "library" });
  const state = pageState();
  const html = pageSource("library.html");
  for (const [, field] of html.matchAll(/\bs\.([a-z_]+)/g)) assert.ok(field in state, `s.${field}`);
  const items = { k: state.secrets[0], t: state.toolkits[0], f: state.toolkits[0].functions[0], r: state.runs[0] };
  for (const [name, item] of Object.entries(items)) for (const [, field] of html.matchAll(new RegExp(`\\b${name}\\.([a-z_]+)`, "g"))) assert.ok(field in item, `${name}.${field}`);
  assert.ok(fs.existsSync(path.join(library, "page.json")));
});
