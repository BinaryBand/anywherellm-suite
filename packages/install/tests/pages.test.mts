import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { type Payload } from "../src/addons.mts";
import { health, type Ctx } from "../src/install.mts";
import { pages, type PagesOptions } from "../src/pages.mts";
import { tempDir } from "./fakes/tmp.mts";

const PAYLOAD: Payload = { skills: [{ name: "library", hubId: "library-lean", files: { "handler.js": "// library\n" }, pages: true }] };
const SECRET = "SECRET-never-printed-9f3a";
const tmp = tempDir("pages");

let home: string;
let storage: string;
let printed: string[];
let ctx: Ctx;

const suiteDir = () => path.join(storage, "anywherellm-suite");
const linksFile = () => path.join(suiteDir(), "page-links.json");
const switchFile = () => path.join(suiteDir(), "page-links-hidden");
const keep = (links: unknown) => {
  fs.mkdirSync(suiteDir(), { recursive: true });
  fs.writeFileSync(linksFile(), typeof links === "string" ? links : JSON.stringify(links));
};
const BOTH = { library: "/library-lean/aaa.html", vault: "/vault-lean/bbb.html" };
const out = () => printed.join("\n");
const run = (more: PagesOptions = {}) => pages(ctx, { storage, ...more });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(tmp, "home-"));
  storage = path.join(home, "storage");
  fs.mkdirSync(path.join(storage, "plugins"), { recursive: true });
  // The pages' own state holds the secrets. Directories where those files would be: reading one as a
  // file is an error, so a command that opened either would fail its test.
  fs.mkdirSync(path.join(storage, "library-lean", "page.json"), { recursive: true });
  fs.mkdirSync(path.join(storage, "vault-lean", "vault-page.json"), { recursive: true });
  printed = [];
  ctx = { home, env: {}, print: (l) => printed.push(l), payload: PAYLOAD, platform: "linux" };
});

test("the links print as root-relative paths, with a hint, and say the agent is given them", () => {
  keep(BOTH);
  assert.equal(run(), 0);
  assert.match(out(), /^AnythingLLM's storage: .*storage$/m);
  assert.match(out(), /^Library page: \/library-lean\/aaa\.html$/m);
  assert.match(out(), /^Vault: +\/vault-lean\/bbb\.html$/m);
  assert.match(out(), /root-relative: set ANYTHINGLLM_URL/);
  assert.match(out(), /The agent is given these links too \(pages --hide keeps them from it\)\./);
});

test("with ANYTHINGLLM_URL set they print as full addresses; one that isn't an address is no base", () => {
  keep(BOTH);
  ctx.env = { ANYTHINGLLM_URL: "https://owen.example:3001/" };
  assert.equal(run(), 0);
  assert.match(out(), /^Library page: https:\/\/owen\.example:3001\/library-lean\/aaa\.html$/m);
  assert.match(out(), /^Vault: +https:\/\/owen\.example:3001\/vault-lean\/bbb\.html$/m);
  assert.doesNotMatch(out(), /root-relative/);
  printed.length = 0;
  ctx.env = { ANYTHINGLLM_URL: "not a url" };
  assert.equal(run(), 0);
  assert.match(out(), /^Library page: \/library-lean\/aaa\.html$/m);
  assert.match(out(), /root-relative/);
});

test("no storage to be found is the same refusal as the other commands", () => {
  assert.throws(() => pages(ctx, {}), { message: /say which AnythingLLM: --storage DIR/ });
  assert.throws(() => pages(ctx, { storage: home }), { message: /doesn't look like AnythingLLM's storage/ });
});

test("with no links file there is no page yet: it says so and exits 1, unless it was asked to change the switch", () => {
  assert.equal(run(), 1);
  assert.match(out(), /No page yet: the agent makes them at its first library call \(or browser tab\); run pages again then/);
  assert.doesNotMatch(out(), /Library page:/);
  assert.equal(run({ hide: true }), 0, "the switch was made: that worked");
});

test("a page that was never shown reads as none, and the command still succeeds", () => {
  keep({ vault: "/vault-lean/bbb.html" });
  assert.equal(run(), 0);
  assert.match(out(), /^Library page: none \(the library skill isn't installed, or hasn't shown it yet\)$/m);
  assert.match(out(), /^Vault: +\/vault-lean\/bbb\.html$/m);
});

test("a links file that isn't JSON, isn't an object or holds something other than a page's path is refused, saying how it is made again", () => {
  for (const bad of ["{not json", "[]", "null", JSON.stringify({ library: "https://evil.example/x.html" }), JSON.stringify({ vault: 7 }), JSON.stringify({ library: "/library-lean/../x.html" })]) {
    keep(bad);
    assert.throws(() => run(), { message: /remove it, and the agent's next library call or browser step makes it again/ }, bad);
  }
});

test("a links file the user can't read says to run it as the storage's owner", { skip: process.getuid?.() === 0 && "root reads it" }, () => {
  keep(BOTH);
  fs.chmodSync(linksFile(), 0);
  try {
    assert.throws(() => run(), { message: /run it as the storage's owner/ });
  } finally {
    fs.chmodSync(linksFile(), 0o600);
  }
});

test("--hide and --show together are refused before anything is touched", () => {
  keep(BOTH);
  assert.throws(() => run({ hide: true, show: true }), /choose one/);
  assert.ok(!fs.existsSync(switchFile()));
  assert.equal(printed.length, 0);
});

test("--hide makes the switch once, leaves its time alone the next time, and the agent is no longer given the links", () => {
  keep(BOTH);
  assert.equal(run({ hide: true }), 0);
  assert.match(out(), /kept the pages' links from the agent: .*page-links-hidden/);
  assert.match(fs.readFileSync(switchFile(), "utf8"), /^\d{4}-\d\d-\d\dT[\d:.]+Z\n$/);
  assert.match(out(), /The agent isn't given these links\./);
  assert.equal(fs.statSync(switchFile()).mode & 0o777, 0o644);
  const past = new Date(Date.now() - 3_600_000);
  fs.utimesSync(switchFile(), past, past);
  fs.utimesSync(linksFile(), past, past);
  const text = fs.readFileSync(switchFile(), "utf8");
  printed.length = 0;
  assert.equal(run({ hide: true }), 0);
  assert.match(out(), /unchanged: the pages' links are kept from the agent already/);
  assert.equal(fs.readFileSync(switchFile(), "utf8"), text);
  assert.equal(Math.round(fs.statSync(switchFile()).mtimeMs / 1000), Math.round(past.getTime() / 1000));
  assert.doesNotMatch(out(), /made before the switch/, "links not older than the switch");
});

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

test("each page's link is said to be old or not on its own: a Vault-only rotation doesn't hide the Library's warning", () => {
  keep(BOTH);
  run({ hide: true });
  const switchedAt = fs.statSync(switchFile()).mtimeMs;
  const at = (offset: number) => new Date(switchedAt + offset).toISOString();
  // Only the Vault was replaced after the switch.
  keep({ ...BOTH, rotated: { vault: at(5_000) } });
  printed.length = 0;
  run();
  assert.match(out(), /^Library page: its link was made before the switch: it changes at the agent's next library call\.$/m);
  assert.doesNotMatch(out(), /^Vault: its link was made before/m);
  // Both replaced after it: nothing to warn of.
  keep({ ...BOTH, rotated: { library: at(1_000), vault: at(5_000) } });
  printed.length = 0;
  run();
  assert.doesNotMatch(out(), /made before the switch|unknown whether/);
  // The Library replaced after it, the Vault before.
  keep({ ...BOTH, rotated: { library: at(1_000), vault: at(-60_000) } });
  printed.length = 0;
  run();
  assert.match(out(), /^Vault: its link was made before the switch: it changes at the agent's next library call or browser step\.$/m);
  assert.doesNotMatch(out(), /^Library page: its link was made before/m);
});

test("a links file that records no rotations can't say, and says so for each page it has a link for", () => {
  keep({ library: BOTH.library });
  run({ hide: true });
  assert.match(out(), /^Library page: unknown whether its link was made after the switch/m);
  assert.doesNotMatch(out(), /^Vault: unknown/m, "no Vault link, so nothing to say of it");
  assert.doesNotMatch(out(), /made before the switch/);
});

test("with the switch off no age is said", () => {
  keep({ ...BOTH, rotated: { library: iso(-3_600_000) } });
  run();
  assert.doesNotMatch(out(), /made before the switch|unknown whether/);
});

test("rotation times that aren't times are refused, saying how the file is made again", () => {
  for (const rotated of ["yesterday", [], { vault: "not a time" }, { library: 5 }]) {
    keep({ ...BOTH, rotated });
    assert.throws(() => run(), /rotation/, JSON.stringify(rotated));
  }
});

test("--hide warns of page events that wait to be applied, by section, and counts only the pages'", () => {
  keep(BOTH);
  const docs = path.join(storage, "documents", "custom-documents");
  fs.mkdirSync(docs, { recursive: true });
  for (const name of ["raw-library-lean-event-1.json", "raw-library-lean-event-2.json", "raw-vault-lean-keys-3.json", "raw-vault-lean-logins-4.json", "raw-vault-lean-logins-5.json", "raw-vault-lean-other-6.json", "raw-something-else-7.json", "other.json"]) fs.writeFileSync(path.join(docs, name), "{}");
  run({ hide: true });
  assert.match(out(), /5 page events wait to be applied \(Vault keys: 1, Vault logins: 2, Library page: 2\): ask the agent to call library and open a tab first, or they're dropped when the links change/);
  printed.length = 0;
  for (const name of fs.readdirSync(docs)) if (/^raw-vault-lean-logins/.test(name)) fs.rmSync(path.join(docs, name));
  run({ hide: true });
  assert.match(out(), /3 page events wait to be applied \(Vault keys: 1, Library page: 2\)/, "a section with none isn't listed");
  printed.length = 0;
  for (const name of fs.readdirSync(docs)) if (/^raw-(library|vault)/.test(name)) fs.rmSync(path.join(docs, name));
  run({ hide: true });
  assert.doesNotMatch(out(), /page events? wait/);
});

test("--hide refuses a link where the switch goes, a link for its folder and a hard link", () => {
  keep(BOTH);
  const elsewhere = path.join(home, "elsewhere");
  fs.writeFileSync(elsewhere, "keep me");
  fs.symlinkSync(elsewhere, switchFile());
  assert.throws(() => run({ hide: true }), /is a link or not a plain file/);
  assert.throws(() => run({ show: true }), /is a link or not a plain file/);
  assert.equal(fs.readFileSync(elsewhere, "utf8"), "keep me");
  fs.rmSync(switchFile());
  fs.linkSync(elsewhere, switchFile());
  assert.throws(() => run({ hide: true }), /is a link or not a plain file/);
  fs.rmSync(switchFile());
  fs.rmSync(suiteDir(), { recursive: true });
  const real = path.join(home, "real-suite");
  fs.mkdirSync(real);
  fs.symlinkSync(real, suiteDir());
  assert.throws(() => run({ hide: true }), /is a link; the switch isn't kept through it/);
  assert.deepEqual(fs.readdirSync(real), []);
});

test("--show removes the switch, and says so when there is none", () => {
  keep(BOTH);
  run({ hide: true });
  printed.length = 0;
  assert.equal(run({ show: true }), 0);
  assert.match(out(), /gave the pages' links to the agent again: removed .*page-links-hidden/);
  assert.ok(!fs.existsSync(switchFile()));
  assert.match(out(), /The agent is given these links too/);
  printed.length = 0;
  run({ show: true });
  assert.match(out(), /unchanged: the pages' links are not kept from the agent/);
});

test("a page's own state, with its secret, is never read or printed", () => {
  // page.json and vault-page.json are directories here (beforeEach): opening one as a file fails.
  keep({ ...BOTH, secret: SECRET, page_secret: SECRET });
  fs.writeFileSync(path.join(storage, "library-lean", "stray.json"), JSON.stringify({ token: "aaa", secret: SECRET }));
  for (const more of [{}, { hide: true }, { show: true }, { hide: true }]) run(more);
  ctx.payload = PAYLOAD;
  assert.doesNotMatch(out(), new RegExp(SECRET));
});

test("health says which way the links go, and fails on a links file that isn't sound", async () => {
  fs.mkdirSync(path.join(storage, "plugins", "agent-skills", "library-lean"), { recursive: true });
  fs.writeFileSync(path.join(storage, "plugins", "agent-skills", "library-lean", "handler.js"), "// library\n");
  ctx.host = { sshDir: path.join(home, "no-ssh"), interfaces: { eth0: [{ address: "192.0.2.10" }] as never } };
  keep(BOTH);
  await health(ctx, { storage });
  assert.match(out(), /ok +the pages' links: switch off: given to the agent too \(pages --hide keeps them from it\)/);
  run({ hide: true });
  printed.length = 0;
  await health(ctx, { storage });
  assert.match(out(), /ok +the pages' links: switch on since \d{4}-\d\d-\d\dT[\d:]+Z: kept from the agent/);
  keep("{not json");
  printed.length = 0;
  assert.equal(await health(ctx, { storage }), false);
  assert.match(out(), /FAIL the pages' links: .*isn't JSON.*\(switch on since .*: kept from the agent\)/);
});
