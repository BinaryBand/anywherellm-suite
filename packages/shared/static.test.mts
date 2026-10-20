import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { staticFiles } from "./static.mts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "static-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const shipped = { "guide/index.md": "shipped index", "guide/research.md": "shipped research", "pages/a.html": "<p>" };

test("a shipped file is read as shipped until the user tunes it under the override folder", () => {
  const dir = path.join(tmp, "a");
  const files = staticFiles(shipped, dir);
  assert.deepEqual(files.get("guide/index.md"), { text: "shipped index", tuned: null });
  fs.mkdirSync(path.join(dir, "guide"), { recursive: true });
  fs.writeFileSync(path.join(dir, "guide", "index.md"), "tuned index");
  assert.deepEqual(files.get("guide/index.md"), { text: "tuned index", tuned: path.join(dir, "guide", "index.md") }, "read at each call: no reload needed");
  assert.deepEqual(files.get("guide/research.md"), { text: "shipped research", tuned: null });
  assert.equal(files.get("guide/none.md"), null);
});

test("a file the user adds is listed beside the shipped ones; folders below aren't", () => {
  const dir = path.join(tmp, "b");
  fs.mkdirSync(path.join(dir, "guide", "deeper"), { recursive: true });
  fs.writeFileSync(path.join(dir, "guide", "billing.md"), "mine");
  const files = staticFiles(shipped, dir);
  assert.deepEqual(files.list("guide/"), ["billing.md", "index.md", "research.md"]);
  assert.equal(files.get("guide/billing.md")?.text, "mine");
  assert.deepEqual(files.list("snippets/"), []);
});

test("only plain relative names are read: nothing reaches outside the folder", () => {
  const files = staticFiles({ ...shipped, "../x": "no" }, path.join(tmp, "c"));
  fs.writeFileSync(path.join(tmp, "secret.txt"), "secret");
  for (const name of ["../secret.txt", "/etc/passwd", "guide/../../secret.txt", ".hidden", "../x"]) assert.equal(files.get(name), null, name);
});

test("a file saved with Windows line endings is read with \\n, shipped or tuned", () => {
  const dir = path.join(tmp, "d");
  fs.mkdirSync(path.join(dir, "parts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "parts", "tuned.html"), "<!--part\r\n{}\r\n-->\r\nbody\r\n");
  const files = staticFiles({ "parts/shipped.html": "a\r\nb" }, dir);
  assert.equal(files.get("parts/tuned.html")?.text, "<!--part\n{}\n-->\nbody\n");
  assert.equal(files.get("parts/shipped.html")?.text, "a\nb");
});
