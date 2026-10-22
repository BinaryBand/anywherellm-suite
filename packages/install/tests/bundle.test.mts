// The built file, run as a person would run it: `node dist/anywherellm-suite.cjs install ...`.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { close, listen } from "#shared/test-helpers";
import { tempDir } from "./fakes/tmp.mts";

const bundle = fileURLToPath(new URL("../dist/anywherellm-suite.cjs", import.meta.url));
const tmp = tempDir("bundle");
// Its own home on every OS, so a run never finds a real AnythingLLM Desktop's storage.
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: tmp, USERPROFILE: tmp, APPDATA: tmp }; // SystemRoot: Node on Windows needs it
const cli = (...args: string[]) => spawnSync(process.execPath, [bundle, ...args], { env, encoding: "utf8" });

/** The command run without blocking this process, so the stand-in AnythingLLM below can answer it. */
function cliAsync(extra: Record<string, string>, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bundle, ...args], { env: { ...env, ...extra } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

for (const [name, pages] of [["apps", true], ["browser", true], ["library", true], ["notebook", false]] as const) {
  test(`the ${name} skill installs alone into a fresh storage, and health finds it`, async (t) => {
    // A stand-in AnythingLLM that takes the pages' key, as its browser extension's check does.
    const anythingllm = http.createServer((req, res) => ((res.statusCode = req.url === "/api/browser-extension/check" ? 200 : 404), res.end("{}")));
    const extra = { ANYTHINGLLM_URL: `http://127.0.0.1:${await listen(anythingllm)}` };
    t.after(() => close(anythingllm));
    const storage = path.join(tmp, `alone-${name}`);
    fs.mkdirSync(path.join(storage, "plugins"), { recursive: true });
    const done = await cliAsync(extra, "install", "--storage", storage, "--skills", name, ...(pages ? ["--page-key", "brx-test"] : []));
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.deepEqual(fs.readdirSync(path.join(storage, "plugins", "agent-skills")), [`${name}-lean`], "that skill alone");
    assert.ok(fs.existsSync(path.join(storage, "plugins", "agent-skills", `${name}-lean`, "handler.js")));
    if (name === "library") assert.ok(fs.existsSync(path.join(storage, "anywherellm-suite", "this-host.json")), "the record of this machine, for kit.ssh");
    const checked = await cliAsync(extra, "health", "--storage", storage);
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.match(checked.stdout, new RegExp(`ok +the ${name} skill`));
    if (pages) assert.match(checked.stdout, /ok +the pages' key/);
  });
}

test("a command it doesn't know prints the usage and exits 2; health with no storage to be found exits 1", () => {
  const unknown = cli("serve");
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /usage: anywherellm-suite/);
  const none = cli("health");
  assert.equal(none.status, 1);
  assert.match(none.stderr, /say which AnythingLLM: --storage DIR/);
});

test("the usage lists pages, and pages with no links yet exits 1 while the switch can still be made", () => {
  const unknown = cli("serve");
  assert.match(unknown.stderr, /pages \[--storage DIR\]/);
  assert.match(unknown.stderr, /\[--hide \| --show\]/);
  const storage = path.join(tmp, "pages-storage");
  fs.mkdirSync(path.join(storage, "plugins"), { recursive: true });
  const none = cli("pages", "--storage", storage);
  assert.equal(none.status, 1, none.stdout + none.stderr);
  assert.match(none.stdout, /No page yet/);
  const hidden = cli("pages", "--storage", storage, "--hide");
  assert.equal(hidden.status, 0, hidden.stdout + hidden.stderr);
  assert.ok(fs.existsSync(path.join(storage, "anywherellm-suite", "page-links-hidden")));
  const both = cli("pages", "--storage", storage, "--hide", "--show");
  assert.equal(both.status, 1);
  assert.match(both.stderr, /choose one/);
});
