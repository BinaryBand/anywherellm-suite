import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readEnv, saveEnv } from "#shared/envfile";
import { tempDir } from "./fakes/tmp.mts";

const tmp = tempDir("env");

test("a missing file reads as empty, and quotes and comments are dropped", () => {
  assert.deepEqual(readEnv(path.join(tmp, "none")), {});
  const file = path.join(tmp, "a.env");
  fs.writeFileSync(file, "# a comment\nAUTH_TOKEN='pw'\nJWT=\"x y\"\n\nA = 1\n#B=2\n");
  assert.deepEqual(readEnv(file), { AUTH_TOKEN: "pw", JWT: "x y", A: "1" });
});

test("a new file gets the header and mode 600, in a folder made for it", () => {
  const file = path.join(tmp, "new", "dir", "bridge.env");
  saveEnv(file, { A: "1" });
  const lines = fs.readFileSync(file, "utf8").split("\n");
  assert.match(lines[0], /^# anywherellm-bridge's settings/);
  assert.equal(lines.at(-2), "A=1");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600); // Windows has no modes
  saveEnv(path.join(tmp, "own.env"), { A: "1" }, ["# mine"]);
  assert.equal(fs.readFileSync(path.join(tmp, "own.env"), "utf8"), "# mine\nA=1\n");
});

test("it sets, adds and drops, keeping the others and the comments", () => {
  const file = path.join(tmp, "b.env");
  fs.writeFileSync(file, "# keep\nA=1\nB=2\nC=3\n");
  saveEnv(file, { A: "9", B: null, D: "4", E: null });
  assert.equal(fs.readFileSync(file, "utf8"), "# keep\nA=9\nC=3\nD=4\n");
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.endsWith(".tmp")), []);
});
