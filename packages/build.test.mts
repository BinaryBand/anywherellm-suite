// The build's boundary check: a bundle may take in files only from the folders it is allowed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { bundle, staticFiles } from "./build.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "build-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// a/src/main.ts imports a/src/own.ts (its own) and b/other.ts (another part's).
fs.mkdirSync(path.join(tmp, "a", "src"), { recursive: true });
fs.mkdirSync(path.join(tmp, "b"));
fs.writeFileSync(path.join(tmp, "a", "src", "main.ts"), 'import { own } from "./own.ts";\nimport { other } from "../../b/other.ts";\nconsole.log(own, other);\n');
fs.writeFileSync(path.join(tmp, "a", "src", "own.ts"), "export const own = 1;\n");
fs.writeFileSync(path.join(tmp, "b", "other.ts"), "export const other = 2;\n");

const options = (outDir: string, allowed: string[], entry = "a/src/main.ts") => ({
  cwd: tmp,
  entry,
  outfile: path.join(tmp, outDir, "main.js"),
  target: "node18",
  allowed,
  label: "part a",
});

test("a bundle that takes in a file from outside its part fails and leaves no output", async () => {
  await assert.rejects(bundle(options("out1", ["a/src/"])), /part a bundles files outside a\/src\/: b\/other\.ts/);
  assert.ok(!fs.existsSync(path.join(tmp, "out1", "main.js")));
});

test("a bundle whose files are all allowed is built", async () => {
  await bundle(options("out2", ["a/src/", "b/"]));
  assert.match(fs.readFileSync(path.join(tmp, "out2", "main.js"), "utf8"), /console\.log/);
});

test("what is removed is `clean`, the whole output folder when one is given", async () => {
  const out = path.join(tmp, "out3");
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, "plugin.json"), "{}");
  await assert.rejects(bundle({ ...options("out3", ["a/src/"]), clean: out }), /bundles files outside/);
  assert.ok(!fs.existsSync(out));
});

test("a prefix is a folder, not a name that starts the same way", async () => {
  fs.mkdirSync(path.join(tmp, "a", "src-old"));
  fs.writeFileSync(path.join(tmp, "a", "src-old", "x.ts"), "export const x = 3;\n");
  fs.writeFileSync(path.join(tmp, "a", "src", "main4.ts"), 'import { x } from "../src-old/x.ts";\nconsole.log(x);\n');
  await assert.rejects(bundle(options("out4", ["a/src/"], "a/src/main4.ts")), /a\/src-old\/x\.ts/);
});

test("a package is bundled only when its folder is allowed, as VENDORED allows one", async () => {
  fs.mkdirSync(path.join(tmp, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "node_modules", "pkg", "package.json"), '{"name":"pkg","main":"index.js"}');
  fs.writeFileSync(path.join(tmp, "node_modules", "pkg", "index.js"), "module.exports = 5;\n");
  fs.writeFileSync(path.join(tmp, "a", "src", "main5.ts"), 'import pkg from "pkg";\nconsole.log(pkg);\n');
  await assert.rejects(bundle(options("out5", ["a/src/"], "a/src/main5.ts")), /node_modules\/pkg\/index\.js/);
  await bundle(options("out6", ["a/src/", "node_modules/pkg/"], "a/src/main5.ts"));
});

test("a static folder is every file under it as text, by its path there; none is {}", () => {
  const dir = path.join(tmp, "a", "static");
  fs.mkdirSync(path.join(dir, "guide"), { recursive: true });
  fs.writeFileSync(path.join(dir, "guide", "index.md"), "# Guide\n");
  fs.writeFileSync(path.join(dir, "helper.js"), "kit.x = () => 1;\n"); // text, not a module
  assert.deepEqual(staticFiles(dir), { "guide/index.md": "# Guide\n", "helper.js": "kit.x = () => 1;\n" });
  assert.deepEqual(staticFiles(path.join(tmp, "none")), {});
});
