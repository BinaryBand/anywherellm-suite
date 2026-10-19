import test from "node:test";
import assert from "node:assert/strict";
import { configDir, desktopStorage, expandHome } from "../src/paths.mts";

test("the settings folder is each OS's own", () => {
  assert.equal(configDir("a", { platform: "linux", env: {}, home: "/home/u" }), "/home/u/.config/a");
  assert.equal(configDir("a", { platform: "linux", env: { XDG_CONFIG_HOME: "/x" }, home: "/home/u" }), "/x/a");
  assert.equal(configDir("a", { platform: "linux", env: { XDG_CONFIG_HOME: "rel" }, home: "/home/u" }), "/home/u/.config/a", "a relative XDG_CONFIG_HOME is ignored");
  assert.equal(configDir("a", { platform: "darwin", env: {}, home: "/Users/u" }), "/Users/u/Library/Application Support/a");
  assert.equal(configDir("a", { platform: "win32", env: { APPDATA: "D:\\Roam" }, home: "C:\\Users\\u" }), "D:\\Roam\\a");
  assert.equal(configDir("a", { platform: "win32", env: {}, home: "C:\\Users\\u" }), "C:\\Users\\u\\AppData\\Roaming\\a");
});

test("AnythingLLM Desktop's storage is where its docs say", () => {
  assert.equal(desktopStorage({ platform: "linux", env: {}, home: "/home/u" }), "/home/u/.config/anythingllm-desktop/storage");
  assert.equal(desktopStorage({ platform: "darwin", env: {}, home: "/Users/u" }), "/Users/u/Library/Application Support/anythingllm-desktop/storage");
  assert.equal(desktopStorage({ platform: "win32", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, home: "C:\\Users\\u" }), "C:\\Users\\u\\AppData\\Roaming\\anythingllm-desktop\\storage");
});

test("a leading ~ is the home folder, with either slash", () => {
  assert.equal(expandHome("~", "/h"), "/h");
  assert.equal(expandHome("~/s", "/h"), "/h/s");
  assert.equal(expandHome("~\\s", "C:\\h"), "C:\\h\\s");
  assert.equal(expandHome("~bob/s", "/h"), "~bob/s");
  assert.equal(expandHome("/a/~", "/h"), "/a/~");
});
