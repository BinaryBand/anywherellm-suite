// The built file, run as a person would run it: `node dist/anywherellm-suite.cjs install ...`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./fakes/tmp.mts";

const bundle = fileURLToPath(new URL("../dist/anywherellm-suite.cjs", import.meta.url));
const tmp = tempDir("bundle");
// Its own home and settings folder on every OS, so a run never reads or writes the real ones.
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: tmp, USERPROFILE: tmp, APPDATA: tmp, XDG_CONFIG_HOME: path.join(tmp, "config") }; // SystemRoot: Node on Windows needs it
const cli = (...args: string[]) => spawnSync(process.execPath, [bundle, ...args], { env, encoding: "utf8" });

test("install puts the control server and every skill it carries into the storage, and health finds them", () => {
  const storage = path.join(tmp, "storage");
  fs.mkdirSync(path.join(storage, "plugins"), { recursive: true });
  const done = cli("install", "--storage", storage, "--skills", "notebook");
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.ok(fs.existsSync(path.join(storage, "anywherellm-suite", "control.cjs")));
  assert.ok(fs.existsSync(path.join(storage, "plugins", "agent-skills", "notebook-lean", "handler.js")));
  const checked = cli("health");
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /ok +the control server/);
});

test("a command it doesn't know prints the usage and exits 2; health with nothing installed exits 1", () => {
  const unknown = cli("serve");
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /usage: anywherellm-suite/);
  assert.equal(spawnSync(process.execPath, [bundle, "health"], { env: { ...env, XDG_CONFIG_HOME: path.join(tmp, "none") }, encoding: "utf8" }).status, 1);
});
