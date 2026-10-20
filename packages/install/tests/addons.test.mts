import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checks, chosen, INNER_STORAGE, put, take, type Payload } from "../src/addons.mts";
import { tempDir } from "./fakes/tmp.mts";

const tmp = tempDir("addons");
const PAYLOAD: Payload = {
  skills: [
    { name: "library", hubId: "library-lean", files: { "handler.js": "// library\n", "plugin.json": "{}\n" } },
    { name: "other", hubId: "other-skill", files: { "handler.js": "// other\n" } },
  ],
};

const storage = (): string => {
  const dir = fs.mkdtempSync(path.join(tmp, "storage-"));
  fs.mkdirSync(path.join(dir, "plugins"));
  return dir;
};

test("put writes the skills chosen, and a second put changes nothing", () => {
  const dir = storage();
  const first = put(dir, PAYLOAD.skills.slice(0, 1));
  assert.equal(fs.readFileSync(path.join(dir, "plugins", "agent-skills", "library-lean", "handler.js"), "utf8"), "// library\n");
  assert.ok(!fs.existsSync(path.join(dir, "plugins", "agent-skills", "other-skill")), "only the skills chosen");
  assert.match(first.join("\n"), /^wrote the library skill/);
  assert.ok(put(dir, PAYLOAD.skills.slice(0, 1)).every((line) => line.startsWith("unchanged")));
});

test("an update removes what an older version of a skill left in its folder (the lean browser's modules), and checks find it first", () => {
  const dir = storage();
  const folder = path.join(dir, "plugins", "agent-skills", "library-lean");
  fs.mkdirSync(folder, { recursive: true });
  for (const name of ["act.js", "guide.md", "handler.js"]) fs.writeFileSync(path.join(folder, name), "// lean\n");
  const [library] = PAYLOAD.skills;
  assert.match(checks(dir, PAYLOAD).find(([what]) => what === "the library skill")![2], /handler\.js, plugin\.json not this version's; act\.js, guide\.md left from an older version: run install again/);
  const done = put(dir, [library]);
  assert.match(done.at(-1)!, /wrote the library skill: .* \(removed what it no longer ships: act\.js, guide\.md\)$/);
  assert.deepEqual(fs.readdirSync(folder).sort(), ["handler.js", "plugin.json"]);
  assert.ok(checks(dir, PAYLOAD).find(([what]) => what === "the library skill")![1]);
});

test("a skill's update keeps what AnythingLLM and the skill saved in its plugin.json: on or off, its settings, what it lists", () => {
  const dir = storage();
  const manifest = (url?: string, active = true, saved = "") => `${JSON.stringify({ active, version: "1", description: `Does things.${saved}`, setup_args: { URL: { type: "string", ...(url ? { value: url } : {}) } } }, null, 2)}\n`;
  const skill = { name: "lib", hubId: "lib-lean", files: { "plugin.json": manifest() } };
  const file = path.join(dir, "plugins", "agent-skills", "lib-lean", "plugin.json");
  put(dir, [skill]);
  fs.writeFileSync(file, JSON.stringify(JSON.parse(manifest("https://llm.example.com", false, "\n\nSaved now: a.b (One.)")))); // as AnythingLLM saves it, and the skill lists what it holds
  assert.ok(checks(dir, { ...PAYLOAD, skills: [skill] }).every(([, ok]) => ok), "still this version's");
  const next = { ...skill, files: { "plugin.json": manifest().replace('"version": "1"', '"version": "2"') } };
  put(dir, [next]);
  const found = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(found.version, "2");
  assert.equal(found.active, false);
  assert.equal(found.setup_args.URL.value, "https://llm.example.com");
  assert.equal(found.description, "Does things.\n\nSaved now: a.b (One.)");
});

test("take removes the skills it knows, and leaves a skill's data", () => {
  const dir = storage();
  put(dir, PAYLOAD.skills);
  fs.mkdirSync(path.join(dir, "library-lean"));
  fs.writeFileSync(path.join(dir, "library-lean", "data.json"), "{}");
  take(dir, PAYLOAD);
  assert.deepEqual(fs.readdirSync(path.join(dir, "plugins", "agent-skills")), []);
  assert.ok(fs.existsSync(path.join(dir, "library-lean", "data.json")));
});

test("checks find what is missing or not this version's", () => {
  const dir = storage();
  const failing = () => checks(dir, PAYLOAD).filter(([, ok]) => !ok).map(([what, , detail]) => `${what}: ${detail}`);
  assert.deepEqual(failing(), [], "a skill that isn't in the storage wasn't chosen");
  put(dir, PAYLOAD.skills.slice(0, 1));
  assert.deepEqual(failing(), []);
  fs.writeFileSync(path.join(dir, "plugins", "agent-skills", "library-lean", "handler.js"), "old");
  assert.deepEqual(failing(), ["the library skill: handler.js not this version's: run install again"]);
});

test("skills are chosen by name, all by default", () => {
  assert.equal(chosen(PAYLOAD).length, 2);
  assert.equal(chosen(PAYLOAD, ["all"]).length, 2);
  assert.deepEqual(chosen(PAYLOAD, ["none"]), []);
  assert.deepEqual(
    chosen(PAYLOAD, ["other"]).map((s) => s.hubId),
    ["other-skill"],
  );
  assert.throws(() => chosen(PAYLOAD, ["library", "nope"]), /no such skill: nope; the skills are library, other/);
});

test("a storage that isn't the user's to write says what to do", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const dir = storage();
  const plugins = path.join(dir, "plugins");
  fs.chmodSync(plugins, 0o555);
  try {
    assert.throws(() => put(dir, PAYLOAD.skills.slice(0, 1)), { message: /belongs to another user.*podman unshare/ });
  } finally {
    fs.chmodSync(plugins, 0o755);
  }
});

test("the storage path inside the container is the pinned image's", () => {
  const versions = fs.readFileSync(fileURLToPath(new URL("../../../tools/versions.env", import.meta.url)), "utf8");
  assert.equal(INNER_STORAGE, /^INNER_STORAGE=(.+)$/m.exec(versions)?.[1]);
});
