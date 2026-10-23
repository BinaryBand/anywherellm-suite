// The built wake, alone: install writes its settings file once (mode 600) and its unit, and starts
// it only once the settings are filled in; uninstall takes the unit away and keeps the settings.
// systemctl is a stand-in on PATH that notes what it was asked, so no real user manager is touched.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const BUILT = fileURLToPath(new URL("../dist/anywherellm-wake.cjs", import.meta.url));

function place() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-install-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh\necho "$*" >> "${dir}/systemctl.log"\n[ "$2" = is-active ] && echo inactive\nexit 0\n`, { mode: 0o755 });
  const storage = path.join(dir, "storage");
  fs.mkdirSync(storage);
  fs.writeFileSync(path.join(storage, ".env"), "AUTH_TOKEN=pw\n");
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: dir, XDG_CONFIG_HOME: path.join(dir, "config"), XDG_DATA_HOME: path.join(dir, "data"), XDG_STATE_HOME: path.join(dir, "state") };
  const run = (...args: string[]) => spawnSync(process.execPath, [BUILT, ...args], { env, encoding: "utf8" });
  const asked = () => (fs.existsSync(path.join(dir, "systemctl.log")) ? fs.readFileSync(path.join(dir, "systemctl.log"), "utf8") : "");
  return { dir, storage, run, asked, settings: path.join(dir, "config", "anywherellm-wake", "wake.env"), unit: path.join(dir, "config", "systemd", "user", "anywherellm-wake.service"), program: path.join(dir, "data", "anywherellm-wake", "anywherellm-wake.cjs") };
}

test("install, fill in, install again, uninstall", () => {
  const p = place();
  let r = p.run("install", "--storage", p.storage);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Left for you: fill in/);
  assert.equal((fs.statSync(p.settings).mode & 0o777).toString(8), "600");
  assert.match(fs.readFileSync(p.settings, "utf8"), new RegExp(`ANYTHINGLLM_STORAGE=${p.storage}`));
  const unit = fs.readFileSync(p.unit, "utf8");
  assert.match(unit, new RegExp(`EnvironmentFile=${p.settings}`));
  assert.ok(unit.includes(`ExecStart=${process.execPath} ${p.program} serve`));
  assert.ok(fs.readFileSync(p.program).equals(fs.readFileSync(BUILT)));
  assert.doesNotMatch(p.asked(), /restart/, "not started with the settings empty");

  fs.appendFileSync(p.settings, "NTFY_URL=https://ntfy.example\nNTFY_TOKEN=tk\nWAKE=inbox=26\n");
  r = p.run("install");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /started anywherellm-wake.service/);
  assert.match(p.asked(), /--user enable anywherellm-wake.service\n--user restart anywherellm-wake.service/);
  assert.match(fs.readFileSync(p.settings, "utf8"), /NTFY_TOKEN=tk/, "the settings are kept");

  r = p.run("uninstall");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(p.unit) && !fs.existsSync(p.program));
  assert.ok(fs.existsSync(p.settings));
  assert.match(p.asked(), /--user disable --now anywherellm-wake.service/);
  fs.rmSync(p.dir, { recursive: true, force: true });
});

test("install refuses a folder without AnythingLLM's .env; serve refuses empty settings", () => {
  const p = place();
  let r = p.run("install", "--storage", p.dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has no \.env/);
  r = p.run("serve");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing NTFY_URL/);
  fs.rmSync(p.dir, { recursive: true, force: true });
});

test("health says what's missing and fails", () => {
  const p = place();
  p.run("install", "--storage", p.storage);
  const r = p.run("health");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL the settings .*missing NTFY_URL/);
  assert.match(r.stdout, /FAIL the service \(anywherellm-wake.service\): inactive/);
  fs.rmSync(p.dir, { recursive: true, force: true });
});
