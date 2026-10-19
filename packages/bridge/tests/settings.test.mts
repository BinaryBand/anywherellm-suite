import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readEnv } from "#shared/envfile";
import { fileFor, fromEnv, settingsFile, shown } from "../src/settings.mts";

test("defaults", () => {
  const s = fromEnv({});
  assert.equal(s.port, 8467);
  assert.equal(s.storage, null);
  assert.equal(s.envFile, null);
  assert.deepEqual(s.allow, []);
  assert.equal(shown(s).BRIDGE_ALLOW, "");
});

test("the env file follows the storage, and an explicit one wins", () => {
  const s = fromEnv({ ANYTHINGLLM_STORAGE: "/srv/a", ANYTHINGLLM_URL: "http://x:1/" });
  assert.equal(s.envFile, path.join("/srv/a", ".env"));
  assert.equal(s.anythingllmUrl, "http://x:1");
  assert.equal(fromEnv({ ANYTHINGLLM_STORAGE: "/srv/a", ANYTHINGLLM_ENV: "/e/.env" }).envFile, "/e/.env");
});

test("the routes are read and a bad one is refused", () => {
  const s = fromEnv({ BRIDGE_ALLOW: "GET /scheduled-jobs, /workspaces" });
  assert.equal(shown(s).BRIDGE_ALLOW, "GET /scheduled-jobs, /workspaces");
  assert.throws(() => fromEnv({ BRIDGE_ALLOW: "workspaces" }), /BRIDGE_ALLOW/);
});

test("a bad port is refused", () => {
  for (const port of ["99999", "0", "80x", "-1"]) assert.throws(() => fromEnv({ BRIDGE_PORT: port }), /BRIDGE_PORT/, port);
});

test("the public addresses follow PUBLIC_HOST and the ports", () => {
  const found = fromEnv({ PUBLIC_HOST: "gir.example", ANYTHINGLLM_URL: "http://127.0.0.1:3005" });
  assert.equal(found.publicUrl, "https://gir.example:8467");
  assert.equal(found.anythingllmPublicUrl, "https://gir.example:3005");
  assert.equal(found.appsUrl, null);
  assert.equal(fromEnv({ PUBLIC_HOST: "gir.example" }).anythingllmPublicUrl, "https://gir.example:3001");
  const unset = fromEnv({});
  assert.deepEqual([unset.publicUrl, unset.anythingllmPublicUrl, unset.appsUrl], [null, null, null]);
  assert.equal(shown(unset).PUBLIC_URL, "");
});

test("the public addresses win and lose their trailing slash", () => {
  const found = fromEnv(
    { PUBLIC_HOST: "gir.example", PUBLIC_URL: " https://bridge.example.com/ ", ANYTHINGLLM_PUBLIC_URL: "https://ai.example.com/", APPS_URL: "http://192.168.1.2:8466/ " },
  );
  assert.deepEqual([found.publicUrl, found.anythingllmPublicUrl, found.appsUrl], ["https://bridge.example.com", "https://ai.example.com", "http://192.168.1.2:8466"]);
  assert.equal(shown(found).ANYTHINGLLM_PUBLIC_URL, "https://ai.example.com");
});

test("a public address the phone cannot use is refused, by name", () => {
  for (const name of ["PUBLIC_URL", "ANYTHINGLLM_PUBLIC_URL", "APPS_URL"]) {
    for (const value of ["ai.example.com", "http://ai.example.com", "ftp://nas"]) {
      assert.throws(() => fromEnv({ [name]: value }), new RegExp(`${name}: .*private network`), `${name} ${value}`);
    }
  }
});

test("the settings file is in the user's settings folder, or BRIDGE_ENV_FILE", () => {
  assert.equal(settingsFile({ env: {}, home: "/h", platform: "linux" }), "/h/.config/anywherellm-bridge/bridge.env");
  assert.equal(settingsFile({ env: { XDG_CONFIG_HOME: "/c" }, home: "/h", platform: "linux" }), "/c/anywherellm-bridge/bridge.env");
  assert.equal(settingsFile({ env: {}, home: "/Users/u", platform: "darwin" }), "/Users/u/Library/Application Support/anywherellm-bridge/bridge.env");
  assert.equal(settingsFile({ env: { APPDATA: "C:\\R" }, home: "C:\\h", platform: "win32" }), "C:\\R\\anywherellm-bridge\\bridge.env");
  assert.equal(fileFor({ env: { BRIDGE_ENV_FILE: "/e" }, home: "/h", platform: "linux" }), "/e");
});

test("the ports it defaults to are the contract's", () => {
  const contract = readEnv(fileURLToPath(new URL("../../../contract/versions.env", import.meta.url)));
  const s = fromEnv({});
  assert.equal(s.port, Number(contract.BRIDGE_PORT));
  assert.equal(s.anythingllmUrl, `http://127.0.0.1:${contract.INNER_PORT}`);
});
