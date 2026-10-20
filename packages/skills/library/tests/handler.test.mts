// The skill as the agent uses it: the built handler.js (build/library-lean, what AnythingLLM loads,
// QuickJS and all), the storage it keeps the library in, and a stand-in API on 127.0.0.1, which
// FENCE_ALLOW lets through. `npm run skills:test` builds the bundle first.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { asksDir } from "#shared/ask";
import { updateJson } from "#shared/atomic";
import { allowedFile } from "#shared/fence";
import { check } from "../src/sandbox.ts";
import { agentRun, call, cardsShown, giveKey, idOf, installed, library, reset, runRecord, skillDir, storage, until } from "./harness.mts";

const KEY = "tok-1234567890";

// The stand-in API: issues behind a bearer key, an echo of what was sent, and one that's busy once.
let busy = 0;
const api = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => (res.writeHead(status, { "content-type": "application/json", ...headers }), res.end(JSON.stringify(body)));
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (url.pathname === "/issues") {
      if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { message: "Bad credentials" });
      return json(200, [{ number: 1, title: "First", state: url.searchParams.get("state") }, { number: 2, title: "Second", pull_request: {} }]);
    }
    if (url.pathname === "/echo") return json(200, { authorization: req.headers.authorization ?? null, method: req.method, body: body ? JSON.parse(body) : null });
    if (url.pathname === "/busy") return busy++ % 2 === 0 ? json(429, { message: "slow down" }, { "retry-after": "0" }) : json(200, { ok: true });
    return json(404, { message: "no" });
  });
});
await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
const BASE = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
test.after(() => api.close());

const ISSUES = `async function main(input, kit) {
  const answer = await kit.http({ path: "/issues", params: { state: input.state || "open" } });
  if (!answer.ok) throw new Error("the API answered " + answer.status);
  return answer.body.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, state: i.state }));
}`;

/** A toolkit "demo" on the stand-in API, its key saved, and its list_issues function. */
async function demo(): Promise<void> {
  await giveKey("demo", "127.0.0.1", KEY);
  const toolkit = { title: "Demo API", base_urls: [BASE], secrets: [{ label: "demo", as: "bearer" }], notes: "Issues include pull requests." };
  const fn = { name: "list_issues", description: "The open issues.", inputs: { state: { type: "string" } }, source: ISSUES };
  assert.match(await call({ action: "save", service: "demo", toolkit, function: fn }), /Saved demo\.list_issues, version 1/);
}

test.beforeEach(reset);

test("the user's key is given on the Vault, never on the card, kept unseen, and goes with a function's requests", async () => {
  const said = await giveKey("demo", "https://127.0.0.1/", KEY);
  assert.match(said, /^The user gives the key on the Vault: \/vault-lean\/[\w-]+\.html\n/);
  assert.ok(!said.includes(KEY));
  assert.equal(cardsShown.length, 0, "a question card would show the key in the chat once answered");
  assert.ok(!fs.readFileSync(path.join(storage, "vault-lean", "vault.json"), "utf8").includes(KEY), "the vault holds it encrypted");
  await call({ action: "save", service: "demo", toolkit: { base_urls: [BASE], secrets: [{ label: "demo", as: "bearer" }] }, function: { name: "list_issues", description: "The open issues.", source: ISSUES } });
  const ran = await call({ action: "run", name: "demo.list_issues", inputs: {} });
  assert.match(ran, /^Ran demo\.list_issues \(r-[\w-]+\): ok, [\d.]+ s, 1 request\./);
  assert.match(ran, /"title": "First"/);
  assert.ok(!ran.includes("Second"), "the function's own filtering");
  assert.match(ran, /- GET 127\.0\.0\.1:\d+\/issues: 200/);
});

test("a key's site is checked before it's asked for", async () => {
  assert.match(await call({ action: "secret", site: "localhost", label: "x" }), /a key needs site/);
});

test("a key never shows: not in a run's result, its log, or call's answer, even when the API echoes it", async () => {
  await demo();
  const echo = "async function main(input, kit) { const a = await kit.http({ path: '/echo' }); kit.log('sent', a.body.authorization); return a.body; }";
  const saved = await call({ action: "save", service: "demo", function: { name: "echo", description: "Echoes.", source: echo }, test: {} });
  assert.match(saved, /"authorization": "Bearer •••"/);
  assert.match(saved, /sent Bearer •••/);
  assert.ok(!saved.includes(KEY));
  const called = await call({ action: "call", url: `${BASE}/echo`, auth: '{"key": "demo", "as": "bearer"}' });
  assert.match(called, /Status: 200/);
  assert.ok(!called.includes(KEY));
  assert.match(called, /Bearer •••/);
  const kept = await call({ action: "call", url: `${BASE}/issues`, auth: "bearer", keep: "0.title" });
  assert.match(kept, /Kept 0\.title: First/, "a key found by the address's site");
});

test("a function can't set a credential, reach another host, or name a key its toolkit lacks", async () => {
  await demo();
  const tries = {
    header: "async function main(i, kit) { await kit.http({ path: '/echo', headers: { Authorization: 'Bearer stolen' } }); }",
    host: "async function main(i, kit) { await kit.http({ url: 'https://example.com/' }); }",
    key: "async function main(i, kit) { await kit.http({ path: '/echo', auth: 'other' }); }",
    inside: "async function main(i, kit) { await kit.http({ url: 'http://10.0.0.1/' }); }",
  };
  const expected = {
    header: /can't set Authorization: a credential comes from a key the user saved/,
    host: /example\.com isn't one of the demo toolkit's hosts \(127\.0\.0\.1\)/,
    key: /the demo toolkit has no key "other"/,
    inside: /10\.0\.0\.1 isn't one of the demo toolkit's hosts/,
  };
  for (const [name, source] of Object.entries(tries)) {
    const said = await call({ action: "save", service: "demo", function: { name, description: "A try.", source }, test: {} });
    assert.match(said, /: error, /, name);
    assert.match(said, expected[name as keyof typeof expected], name);
  }
});

test("a function that doesn't compile isn't saved, and says on which line", async () => {
  await demo();
  const said = await call({ action: "save", service: "demo", function: { name: "broken", description: "Broken.", source: "async function main() {\n  return (;\n}" } });
  assert.match(said, /^Library: demo\.broken wasn't saved: SyntaxError: .* \(line 2\)\.$/);
  assert.match(await call({ action: "library", service: "demo" }), /- demo\.list_issues\(state\?: string\): The open issues\. \(version 1\)/);
  assert.ok(!fs.existsSync(path.join(library, "toolkits", "demo", "functions", "broken.json")));
  assert.match(await call({ action: "save", service: "demo", function: { name: "nodesc", source: "async function main() {}" } }), /needs a description/);
  assert.match(await call({ action: "save", service: "nope", function: { name: "x", description: "x", source: "async function main() {}" } }), /no toolkit nope yet/);
});

test("a function runs another, across toolkits: a flow, with its depth limited", async () => {
  await demo();
  await call({ action: "save", service: "digest", toolkit: { base_urls: [BASE] }, function: { name: "count", description: "Counts the open issues.", source: "async function main(i, kit) { const issues = await kit.run('demo.list_issues', {}); return { open: issues.length }; }" } });
  assert.match(await call({ action: "run", name: "digest.count" }), /"open": 1/);
  await call({ action: "save", service: "digest", function: { name: "loop", description: "Runs itself.", inputs: { n: { type: "number" } }, source: "async function main(i, kit) { return kit.run('digest.loop', { n: (i.n || 0) + 1 }); }" } });
  assert.match(await call({ action: "run", name: "digest.loop" }), /functions run functions at most 4 deep/);
});

test("what a function keeps is kept between runs, only when a run ends well", async () => {
  await demo();
  const source = "async function main(i, kit) { const n = (kit.state.get() || 0) + 1; kit.state.set(n); if (i.fail) throw new Error('failed on ' + n); return n; }";
  await call({ action: "save", service: "demo", function: { name: "counter", description: "Counts its runs.", inputs: { fail: { type: "boolean" } }, source } });
  assert.match(await call({ action: "run", name: "demo.counter" }), /Result \(JSON\):\n1/);
  assert.match(await call({ action: "run", name: "demo.counter", inputs: { fail: true } }), /Error: Error: failed on 2 \(line 1/);
  assert.match(await call({ action: "run", name: "demo.counter" }), /Result \(JSON\):\n2/, "the failed run's count wasn't kept");
});

test("inputs are checked against what the function takes", async () => {
  await demo();
  await call({ action: "save", service: "demo", function: { name: "needs", description: "Needs a repo.", inputs: { repo: { type: "string", required: true, about: "owner/name" } }, source: "async function main(i) { return i.repo; }" } });
  assert.match(await call({ action: "run", name: "demo.needs" }), /needs the input repo \(owner\/name\)/);
  assert.match(await call({ action: "run", name: "demo.needs", inputs: { repo: 5 } }), /input repo is a string, not a number/);
  assert.match(await call({ action: "run", name: "demo.needs", inputs: { repo: "a/b", other: 1 } }), /takes no input other/);
  assert.match(await call({ action: "run", name: "demo.needs", inputs: '{"repo": "a/b"}' }), /Result \(JSON\):\n"a\/b"/, "inputs given as JSON text");
});

test("a run from a scheduled job (no workspace) is recorded as one, and shows in the library", async () => {
  await demo();
  const ran = await call({ action: "run", name: "demo.list_issues" }, null);
  const id = idOf(ran);
  const record = runRecord(id);
  assert.equal(record.trigger, "job");
  assert.equal(record.workspace, null);
  assert.equal(await call({ action: "run", run_id: id }), ran, "a run is shown again by its id");
  const listing = await call({ action: "library" });
  assert.match(listing, /^The library's toolkits/);
  assert.match(listing, /- demo: Demo API\. Functions: list_issues\. Keys: demo \(bearer, saved\)/);
  assert.match(listing, new RegExp(`- demo\\.list_issues: ok, \\d+ s ago, from a scheduled job \\[${id}\\]`));
});

test("the prelude's helpers: kit.retry waits out a 429, kit.b64 round-trips UTF-8", async () => {
  await demo();
  const source = `async function main(i, kit) {
    const a = await kit.retry({ path: "/busy" });
    const text = "héllo ✓ 🙂";
    const b = kit.b64.encode(text);
    return { status: a.status, b, url: kit.b64.encode("??>", { url: true }), back: kit.b64.decode(b) === text };
  }`;
  const said = await call({ action: "save", service: "demo", function: { name: "helpers", description: "Uses the prelude.", source }, test: {} });
  assert.match(said, /"status": 200/);
  assert.ok(said.includes(`"b": "${Buffer.from("héllo ✓ 🙂").toString("base64")}"`), said);
  assert.match(said, /"url": "Pz8-"/);
  assert.match(said, /"back": true/);
  assert.match(said, /2 requests/);
});

test("a toolkit saved again keeps what isn't given; a function or a toolkit is removed", async () => {
  await demo();
  await call({ action: "save", service: "demo", toolkit: { notes: "New notes." } });
  const shown = await call({ action: "library", service: "demo" });
  assert.match(shown, /Base addresses: http:\/\/127\.0\.0\.1:\d+/);
  assert.match(shown, /Notes:\nNew notes\./);
  assert.match(await call({ action: "save", service: "demo", remove: "list_issues" }), /^Removed demo\.list_issues\.$/);
  assert.match(await call({ action: "save", service: "demo", remove: "demo" }), /^Removed the toolkit demo and its functions\. Its keys stay saved\.$/);
  assert.match(await call({ action: "library" }), /^The library is empty: no toolkit yet\. guide says how to build one \(topic toolkits\)\.\n\nThe Vault/);
});

// The guide, and the static files it's made of.

const shipped = (sub: string): string[] => fs.readdirSync(path.join(skillDir, "static", sub)).sort();
const read = (name: string): string => fs.readFileSync(path.join(skillDir, "static", name), "utf8");

test("guide with no topic gives the overview; with a topic, that topic", async () => {
  assert.equal(await call({ action: "guide" }), read("guide/index.md").trim());
  assert.equal(await call({ action: "guide", topic: "Functions" }), read("guide/functions.md").trim());
  assert.match(await call({ action: "guide", topic: "nothing" }), /^Library: there's no topic "nothing"; the topics are: functions, research, schedules, secrets, snippets, toolkits\.$/);
  assert.equal(await call({}), read("guide/index.md").trim(), "guide is the default");
});

test("a snippet is given to adapt, and an unknown one names the ones there are", async () => {
  const answer = await call({ action: "guide", snippet: "cursor-pagination" });
  assert.ok(answer.startsWith("Snippet cursor-pagination (a worked example: adapt it, don't save it as is):"));
  assert.ok(answer.endsWith(read("snippets/cursor-pagination.js").trim()));
  assert.match(await call({ action: "guide", snippet: "nope" }), /no snippet "nope"; the snippets are: cursor-pagination/);
});

test("a guide topic tuned on this instance wins, says where it lives, and a topic added there is listed", async () => {
  const own = path.join(library, "static", "guide");
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, "functions.md"), "Tuned: keep functions short.\n");
  fs.writeFileSync(path.join(own, "billing.md"), "How this user's billing APIs work.\n");
  assert.equal(await call({ action: "guide", topic: "functions" }), `Tuned: keep functions short.\n\n(Tuned on this instance: ${path.join(own, "functions.md")})`);
  assert.match(await call({ action: "guide", topic: "billing" }), /^How this user's billing APIs work\./);
  assert.match(await call({ action: "guide", topic: "nothing" }), /the topics are: billing, functions, research/);
});

// Drift: what the static files say must match what the skill has, so polishing one can't break it.

test("every guide topic is listed in the overview, and every topic listed there has a file", () => {
  const files = shipped("guide").filter((f) => f !== "index.md").map((f) => f.replace(/\.md$/, ""));
  const listed = [...read("guide/index.md").matchAll(/^- `([a-z-]+)`:/gm)].map((m) => m[1]).sort();
  assert.deepEqual(listed, files);
});

test("every action the plugin offers has a handler, and the kit the guide describes is the kit there is", async () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(skillDir, "plugin.json"), "utf8"));
  const offered = [...String(plugin.entrypoint.params.action.description).matchAll(/(?:^|\), )([a-z]+) \(/g)].map((m) => m[1]);
  assert.deepEqual(offered, ["guide", "library", "secret", "call", "save", "run"]);
  assert.match(await call({ action: "fly" }), new RegExp(`action is ${offered.join(", ")}, not "fly"`));
  await demo();
  const named = [...new Set([...read("guide/functions.md").matchAll(/kit\.([a-z0-9]+(?:\.[a-z]+)?)\(/g)].map((m) => m[1]))];
  const source = `async function main() { return ${JSON.stringify(named)}.filter((n) => typeof n.split(".").reduce((o, k) => o && o[k], kit) !== "function"); }`;
  const said = await call({ action: "save", service: "demo", function: { name: "kit_names", description: "Which kit names are missing.", source }, test: {} });
  assert.match(said, /Result \(JSON\):\n\[\]/, `each kit function the guide names exists: ${named.join(", ")}`);
});

test("every snippet is listed in the snippets topic, and compiles as a function", async () => {
  const files = shipped("snippets").map((f) => f.replace(/\.js$/, ""));
  const listed = [...read("guide/snippets.md").matchAll(/^- `([a-z-]+)`:/gm)].map((m) => m[1]).sort();
  assert.deepEqual(listed, files);
  for (const file of shipped("snippets")) assert.equal(await check(read(`snippets/${file}`)), null, file);
});

test("the bundle ships two text files, QuickJS and the static folder inside handler.js", () => {
  const built = path.join(skillDir, "build", "library-lean");
  assert.deepEqual(fs.readdirSync(built).sort(), ["handler.js", "plugin.json"]);
  const bytes = fs.readFileSync(path.join(built, "handler.js"));
  assert.ok(bytes.toString("utf8").includes("cursor-pagination.js"));
  assert.ok(bytes.length > 500_000, "QuickJS's wasm is inlined");
  assert.ok(!bytes.includes(0), "text, which install's payload and the Hub's upload both carry");
});

test("the installed skill's description ends with the functions saved now, for the model to see on every turn", async (t) => {
  const shippedDescription = JSON.parse(fs.readFileSync(path.join(skillDir, "plugin.json"), "utf8")).description;
  const { description, config } = installed(t, { active: false });
  await demo();
  assert.equal(description(), `${shippedDescription}\n\nSaved now: demo.list_issues (The open issues.). When one does what's asked, run it (run, name) rather than searching the web.`);
  assert.equal(config().active, false, "the rest of plugin.json as AnythingLLM saved it");
  await call({ action: "save", service: "demo", remove: "list_issues" });
  assert.equal(description(), shippedDescription, "nothing listed once nothing is saved");
});

// A host the fence refuses (localhost: a name on this machine), the stand-in API behind it.
const INSIDE = BASE.replace("127.0.0.1", "localhost");

/** Answers the ask a chat's lines name with `decision`, as AnywhereLLM's bridge writes it. */
async function answerAsk(said: string[], decision: string): Promise<string> {
  await until(() => said.some((l) => l.includes("[ask:")));
  const id = said.find((l) => l.includes("[ask:"))!.match(/\[ask:([0-9a-f]{32})\]/)![1];
  await updateJson<Record<string, unknown>, void>(path.join(asksDir(), `${id}.json`), () => ({}), (a) => Object.assign(a, { decision, decided: new Date().toISOString() }));
  return id;
}

test("a chat in AnywhereLLM asks the user for a host the fence refuses, and a yes lets it through for the run", async () => {
  fs.rmSync(path.join(storage, "fence-lean"), { recursive: true, force: true });
  const said: string[] = [];
  const run = agentRun("work", true);
  const asked = call({ action: "call", url: `${INSIDE}/echo` }, { said, run });
  const id = await answerAsk(said, "once");
  assert.match(said[0], /^Waiting for your approval in AnywhereLLM to reach localhost \[ask:[0-9a-f]{32}\]$/);
  assert.match(await asked, /Status: 200/);
  assert.ok(!fs.existsSync(path.join(asksDir(), `${id}.json`)), "the ask is taken away once answered");
  assert.match(await call({ action: "call", url: `${INSIDE}/echo` }, { said, run }), /Status: 200/, "the same run isn't asked again");
  assert.equal(said.length, 1);
  // A function the run starts reaches it too, though a function never asks itself.
  await call({ action: "save", service: "inside", toolkit: { base_urls: [INSIDE] }, function: { name: "echo", description: "Echoes.", source: "async function main(input, kit) { return (await kit.http({ path: '/echo', auth: false })).status; }" } }, { said, run });
  assert.match(await call({ action: "run", name: "inside.echo", inputs: {} }, { said, run }), /Result \(JSON\):\n200/);
  assert.match(await call({ action: "run", name: "inside.echo", inputs: {} }), /localhost:\d+ isn't reached: localhost is a name on this machine or its network\. That's final/, "another run's function isn't let through");
});

test("a no, or no answer, keeps the fence's refusal, and it's final", async () => {
  const said: string[] = [];
  const asked = call({ action: "call", url: `${INSIDE}/echo` }, { said });
  await answerAsk(said, "deny");
  assert.match(await asked, /^Library: http:\/\/localhost:\d+ isn't reached: the user declined it in AnywhereLLM\. That's final/);
});

test("a scheduled job, or a chat AnywhereLLM doesn't stream, is refused without asking; a host let through for good passes for both", async () => {
  fs.rmSync(path.join(storage, "fence-lean"), { recursive: true, force: true });
  assert.match(await call({ action: "call", url: `${INSIDE}/echo` }, null), /^Library: http:\/\/localhost:\d+ isn't reached: localhost is a name on this machine or its network\. That's final/);
  assert.match(await call({ action: "call", url: `${INSIDE}/echo` }), /isn't reached: localhost is a name/);
  assert.ok(!fs.existsSync(asksDir()), "nobody was asked");
  fs.mkdirSync(path.dirname(allowedFile(storage)), { recursive: true });
  fs.writeFileSync(allowedFile(storage), JSON.stringify({ hosts: [{ host: "localhost", added: new Date().toISOString() }] }));
  assert.match(await call({ action: "call", url: `${INSIDE}/echo` }, null), /Status: 200/);
  fs.rmSync(path.join(storage, "fence-lean"), { recursive: true, force: true });
});
