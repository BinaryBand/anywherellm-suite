import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checks, chosen, entry, put, serversFile, setEntry, take, type Payload } from "../src/addons.mts";
import { readEnv } from "#shared/envfile";
import { tempDir } from "./fakes/tmp.mts";

const tmp = tempDir("addons");
const PAYLOAD: Payload = {
  control: "// the control server\n",
  skills: [
    { name: "library", hubId: "library-lean", files: { "handler.js": "// library\n", "plugin.json": "{}\n" } },
    { name: "other", hubId: "other-skill", files: { "handler.js": "// other\n" } },
  ],
};
const ENTRY = entry("container", "/unused", ["chat"], "/usr/bin/node");

const storage = (): string => {
  const dir = fs.mkdtempSync(path.join(tmp, "storage-"));
  fs.mkdirSync(path.join(dir, "plugins"));
  return dir;
};
const servers = (dir: string) => JSON.parse(fs.readFileSync(serversFile(dir), "utf8")).mcpServers;

test("a container's entry runs its own node on the path it sees; a native one, this node on the host's", () => {
  assert.deepEqual(entry("container", "/srv/s", ["chat", "schedule"], "/usr/bin/node"), {
    command: "node",
    args: ["/app/server/storage/anywherellm-suite/control.cjs"],
    env: { ANYTHINGLLM_MCP_ROLES: "chat,schedule" },
  });
  assert.deepEqual(entry("native", "/home/u/storage", ["chat"], "/opt/node/bin/node"), {
    command: "/opt/node/bin/node",
    args: [path.join("/home/u/storage", "anywherellm-suite", "control.cjs")],
    env: { ANYTHINGLLM_MCP_ROLES: "chat" },
  });
});

test("put writes the server, the entry and the skills, and a second put changes nothing", () => {
  const dir = storage();
  const first = put(dir, PAYLOAD, ENTRY, PAYLOAD.skills.slice(0, 1));
  assert.equal(fs.readFileSync(path.join(dir, "anywherellm-suite", "control.cjs"), "utf8"), PAYLOAD.control);
  assert.deepEqual(servers(dir), { control: ENTRY });
  assert.equal(fs.readFileSync(path.join(dir, "plugins", "agent-skills", "library-lean", "handler.js"), "utf8"), "// library\n");
  assert.ok(!fs.existsSync(path.join(dir, "plugins", "agent-skills", "other-skill")), "only the skills chosen");
  assert.match(first.join("\n"), /wrote the control server.*\n.*set control.*\n.*wrote the library skill/);
  assert.ok(put(dir, PAYLOAD, ENTRY, PAYLOAD.skills.slice(0, 1)).every((line) => line.startsWith("unchanged")));
});

test("an update removes what an older version of a skill left in its folder (the lean browser's modules), and checks find it first", () => {
  const dir = storage();
  const folder = path.join(dir, "plugins", "agent-skills", "library-lean");
  fs.mkdirSync(folder, { recursive: true });
  for (const name of ["act.js", "guide.md", "handler.js"]) fs.writeFileSync(path.join(folder, name), "// lean\n");
  const [library] = PAYLOAD.skills;
  assert.match(checks(dir, PAYLOAD).find(([what]) => what === "the library skill")![2], /handler\.js, plugin\.json not this version's; act\.js, guide\.md left from an older version: run install again/);
  const done = put(dir, PAYLOAD, ENTRY, [library]);
  assert.match(done.at(-1)!, /wrote the library skill: .* \(removed what it no longer ships: act\.js, guide\.md\)$/);
  assert.deepEqual(fs.readdirSync(folder).sort(), ["handler.js", "plugin.json"]);
  assert.ok(checks(dir, PAYLOAD).find(([what]) => what === "the library skill")![1]);
});

test("a skill's update keeps what AnythingLLM and the skill saved in its plugin.json: on or off, its settings, what it lists", () => {
  const dir = storage();
  const manifest = (url?: string, active = true, saved = "") => `${JSON.stringify({ active, version: "1", description: `Does things.${saved}`, setup_args: { URL: { type: "string", ...(url ? { value: url } : {}) } } }, null, 2)}\n`;
  const skill = { name: "lib", hubId: "lib-lean", files: { "plugin.json": manifest() } };
  const file = path.join(dir, "plugins", "agent-skills", "lib-lean", "plugin.json");
  put(dir, { ...PAYLOAD, skills: [skill] }, ENTRY, [skill]);
  fs.writeFileSync(file, JSON.stringify(JSON.parse(manifest("https://llm.example.com", false, "\n\nSaved now: a.b (One.)")))); // as AnythingLLM saves it, and the skill lists what it holds
  assert.ok(checks(dir, { ...PAYLOAD, skills: [skill] }).every(([, ok]) => ok), "still this version's");
  const next = { ...skill, files: { "plugin.json": manifest().replace('"version": "1"', '"version": "2"') } };
  put(dir, { ...PAYLOAD, skills: [next] }, ENTRY, [next]);
  const found = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(found.version, "2");
  assert.equal(found.active, false);
  assert.equal(found.setup_args.URL.value, "https://llm.example.com");
  assert.equal(found.description, "Does things.\n\nSaved now: a.b (One.)");
});

test("the servers file keeps other servers and AnythingLLM's settings in ours, and is written in place", () => {
  const dir = storage();
  const theirs = { command: "npx", args: ["some-server"] };
  fs.writeFileSync(serversFile(dir), JSON.stringify({ mcpServers: { theirs, control: { ...ENTRY, anythingllm: { suppressedTools: ["chat_delete"] } } }, other: 1 }));
  const inode = fs.statSync(serversFile(dir)).ino;
  const wanted = entry("container", dir, ["chat", "schedule"], "node");
  setEntry(dir, wanted);
  const found = JSON.parse(fs.readFileSync(serversFile(dir), "utf8"));
  assert.deepEqual(found, { mcpServers: { theirs, control: { ...wanted, anythingllm: { suppressedTools: ["chat_delete"] } } }, other: 1 });
  assert.equal(fs.statSync(serversFile(dir)).ino, inode);
  assert.match(setEntry(dir, null), /dropped control/);
  assert.deepEqual(servers(dir), { theirs });
  assert.match(setEntry(dir, null), /no control entry/);
});

test("another server named control is refused; a servers file that isn't JSON is refused", () => {
  const dir = storage();
  fs.writeFileSync(serversFile(dir), JSON.stringify({ mcpServers: { control: { command: "npx", args: ["someone-elses"] } } }));
  assert.throws(() => setEntry(dir, ENTRY), { status: 400, message: /a server named control that isn't ours/ });
  fs.writeFileSync(serversFile(dir), "{oops");
  assert.throws(() => setEntry(dir, ENTRY), /isn't JSON/);
});

test("a native entry on Windows is still ours", () => {
  const dir = storage();
  const windows = { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\Users\\u\\AppData\\Roaming\\anythingllm-desktop\\storage\\anywherellm-suite\\control.cjs"] };
  fs.writeFileSync(serversFile(dir), JSON.stringify({ mcpServers: { control: windows } }));
  assert.match(setEntry(dir, ENTRY), /set control/);
});

test("take removes the server, the entry and the skills it knows, and leaves a skill's data", () => {
  const dir = storage();
  put(dir, PAYLOAD, ENTRY, PAYLOAD.skills);
  fs.mkdirSync(path.join(dir, "library-lean"));
  fs.writeFileSync(path.join(dir, "library-lean", "data.json"), "{}");
  take(dir, PAYLOAD);
  assert.deepEqual(servers(dir), {});
  assert.ok(!fs.existsSync(path.join(dir, "anywherellm-suite")));
  assert.deepEqual(fs.readdirSync(path.join(dir, "plugins", "agent-skills")), []);
  assert.ok(fs.existsSync(path.join(dir, "library-lean", "data.json")));
});

test("checks find what is missing or not this version's", () => {
  const dir = storage();
  const failing = () => checks(dir, PAYLOAD).filter(([, ok]) => !ok).map(([what, , detail]) => `${what}: ${detail}`);
  assert.deepEqual(failing(), ["the control server: missing: run install again", `the control entry: missing from ${serversFile(dir)}`]);
  put(dir, PAYLOAD, ENTRY, PAYLOAD.skills.slice(0, 1));
  assert.deepEqual(failing(), []);
  fs.writeFileSync(path.join(dir, "plugins", "agent-skills", "library-lean", "handler.js"), "old");
  fs.writeFileSync(path.join(dir, "anywherellm-suite", "control.cjs"), "old");
  assert.deepEqual(failing(), ["the control server: not this version's: run install again", "the library skill: handler.js not this version's: run install again"]);
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
  fs.chmodSync(dir, 0o555);
  try {
    assert.throws(() => put(dir, PAYLOAD, ENTRY, []), { status: 400, message: /belongs to another user.*podman unshare/ });
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

test("the storage path inside the container is the contract's", () => {
  const contract = readEnv(fileURLToPath(new URL("../../../contract/versions.env", import.meta.url)));
  assert.deepEqual(entry("container", "/x", ["chat"], "node").args, [`${contract.INNER_STORAGE}/anywherellm-suite/control.cjs`]);
});
