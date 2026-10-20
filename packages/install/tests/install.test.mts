import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { desktopStorage } from "../src/paths.mts";
import { type Payload } from "../src/addons.mts";
import { health, install, uninstall, type Ctx, type Options } from "../src/install.mts";
import { FakeAnythingLLM } from "./fakes/anythingllm.mts";
import { tempDir } from "./fakes/tmp.mts";

const PAYLOAD: Payload = { skills: [{ name: "library", hubId: "library-lean", files: { "handler.js": "// library\n" }, pages: true }] };
const tmp = tempDir("install");

let fake: FakeAnythingLLM;
let home: string;
let storage: string;
let printed: string[];
let ctx: Ctx;

beforeEach(async () => {
  fake = await new FakeAnythingLLM().start();
  home = fs.mkdtempSync(path.join(tmp, "home-"));
  storage = path.join(home, "storage");
  fs.mkdirSync(path.join(storage, "plugins"), { recursive: true });
  printed = [];
  ctx = {
    home,
    env: { ANYTHINGLLM_URL: fake.url },
    print: (l) => printed.push(l),
    payload: PAYLOAD,
    platform: "linux", // paths as on Linux, whatever runs the tests
  };
});
afterEach(() => fake.stop());

const opts = (more: Partial<Options> = {}): Options => ({ storage, ...more });

test("install puts the skills into the storage and asks nothing of AnythingLLM", async () => {
  await install(ctx, opts());
  assert.ok(fs.existsSync(path.join(storage, "plugins", "agent-skills", "library-lean", "handler.js")));
  assert.equal(fake.requests, 0);
  assert.match(printed.join("\n"), /switch on the skills you want/);
});

test("with no --storage each command takes AnythingLLM Desktop's", async () => {
  const desktop = desktopStorage(ctx);
  fs.mkdirSync(path.join(desktop, "plugins"), { recursive: true });
  await install(ctx, opts({ storage: undefined, pageKey: "brx-good" }));
  assert.ok(fs.existsSync(path.join(desktop, "plugins", "agent-skills", "library-lean", "handler.js")));
  assert.equal(await health(ctx), true, printed.join("\n"));
  uninstall(ctx);
  assert.ok(!fs.existsSync(path.join(desktop, "plugins", "agent-skills", "library-lean")));
});

test("with no storage to be found each command says how to name one", async () => {
  const refusal = { message: /--storage DIR.*mounted at \/app\/server\/storage.*bind mount.*Desktop's would be/ };
  await assert.rejects(install(ctx, opts({ storage: undefined })), refusal);
  await assert.rejects(health(ctx), refusal);
  assert.throws(() => uninstall(ctx), refusal);
  await assert.rejects(install(ctx, opts({ storage: home })), { message: /doesn't look like AnythingLLM's storage/ });
  fs.mkdirSync(path.join(home, "s2", "plugins"), { recursive: true });
  await install(ctx, opts({ storage: "~/s2" }));
  assert.ok(fs.existsSync(path.join(home, "s2", "plugins", "agent-skills", "library-lean", "handler.js")));
});

test("an unknown skill is refused before anything is written", async () => {
  await assert.rejects(install(ctx, opts({ skills: ["nope"] })), /no such skill: nope/);
  assert.ok(!fs.existsSync(path.join(storage, "plugins", "agent-skills")));
});

test("--skills none puts in nothing", async () => {
  await install(ctx, opts({ skills: ["none"] }));
  assert.ok(!fs.existsSync(path.join(storage, "plugins", "agent-skills")));
});

test("uninstall takes the skills out; their data stays", async () => {
  await install(ctx, opts());
  fs.mkdirSync(path.join(storage, "library-lean"));
  uninstall(ctx, opts());
  assert.ok(!fs.existsSync(path.join(storage, "plugins", "agent-skills", "library-lean")));
  assert.ok(fs.existsSync(path.join(storage, "library-lean")));
});

test("health checks what install put in", async () => {
  await install(ctx, opts({ pageKey: "brx-good" }));
  printed.length = 0;
  assert.equal(await health(ctx, opts()), true, printed.join("\n"));
  fs.writeFileSync(path.join(storage, "plugins", "agent-skills", "library-lean", "handler.js"), "old");
  printed.length = 0;
  assert.equal(await health(ctx, opts()), false);
  assert.match(printed.join("\n"), /FAIL the library skill: handler\.js not this version's/);
});

test("the pages' key is kept for its owner alone, until another is given; health asks AnythingLLM about it", async () => {
  await assert.rejects(install(ctx, opts({ pageKey: "good" })), /--page-key is a browser-extension key \(brx-\.\.\.\)/);
  await install(ctx, opts());
  assert.match(printed.join("\n"), /- The skills' pages need a key to post with: make one in AnythingLLM's Settings > Browser Extension/);
  printed.length = 0;
  assert.equal(await health(ctx, opts()), false);
  assert.match(printed.join("\n"), /FAIL the pages' key: none: make one/);

  const file = path.join(storage, "anywherellm-suite", "page-key");
  await install(ctx, opts({ pageKey: "brx-good" }));
  assert.equal(fs.readFileSync(file, "utf8"), "brx-good\n");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600); // Windows has no modes
  printed.length = 0;
  await install(ctx, opts());
  assert.equal(fs.readFileSync(file, "utf8"), "brx-good\n", "kept when install isn't given one");
  assert.ok(!printed.some((l) => l.includes("need a key")), printed.join("\n"));

  fake.extensionKeys.delete("brx-good"); // revoked in AnythingLLM's settings
  printed.length = 0;
  assert.equal(await health(ctx, opts()), false);
  assert.match(printed.join("\n"), /FAIL the pages' key: AnythingLLM refuses it \(403\)/);

  printed.length = 0;
  uninstall(ctx, opts());
  assert.match(printed.join("\n"), /the pages' key goes with it: revoke it in AnythingLLM's Settings > Browser Extension/);
  assert.ok(!fs.existsSync(file));
});

test("with no skill that has pages, no key is asked for or checked", async () => {
  const quiet: Ctx = { ...ctx, payload: { ...PAYLOAD, skills: [{ ...PAYLOAD.skills[0], pages: false }] } };
  await install(quiet, opts());
  assert.ok(!printed.some((l) => l.includes("need a key")), printed.join("\n"));
  printed.length = 0;
  assert.equal(await health(quiet, opts()), true, printed.join("\n"));
  assert.ok(!printed.some((l) => l.includes("the pages' key")), printed.join("\n"));
});

