import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { pageKeyFile } from "./anythingllm.mts";
import { writeAtomic } from "./atomic.mts";
import { Told } from "./errors.mts";
import { embed, eventsDir, inTurn, listPublic, pageKey, putBack, readPublic, removePublic, renamePublic, take, watch, writePublic, publicDir } from "./pages.mts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pages-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.STORAGE_DIR = path.join(tmp, "storage");
process.env.ANYTHINGLLM_PUBLIC_DIR = path.join(tmp, "public");

/** An event as AnythingLLM's collector writes what a page posted, `ms` ago. */
function posted(title: string, event: unknown, ms = 0, name = `${Math.random().toString(36).slice(2)}`) {
  fs.mkdirSync(eventsDir(), { recursive: true });
  const file = path.join(eventsDir(), `raw-${title}-${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ id: name, pageContent: JSON.stringify(event) }));
  const at = new Date(Date.now() - ms);
  fs.utimesSync(file, at, at);
  return file;
}

beforeEach(() => fs.rmSync(eventsDir(), { recursive: true, force: true }));

test("events are taken oldest first, only the title's, each file deleted", () => {
  posted("library-lean-event", { n: 2 }, 1000);
  posted("library-lean-event", { n: 1 }, 2000);
  const other = posted("browser-lean-event", { n: 9 });
  assert.deepEqual(take("library-lean-event"), [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(take("library-lean-event"), []);
  assert.ok(fs.existsSync(other), "another skill's events are left for it");
});

test("an event another process claimed (renamed) first isn't taken again", () => {
  const file = posted("c", { n: 1 });
  fs.renameSync(file, `${file}.taken-1`);
  posted("c", { n: 2 });
  assert.deepEqual(take("c"), [{ n: 2 }]);
});

test("an event put back is taken again by the next pass, ahead of those posted since, in its order", () => {
  posted("c", { n: 1 });
  const [event] = take("c");
  putBack("c", event);
  assert.deepEqual(take("c"), [{ n: 1 }]);
  posted("c", { n: 3 });
  putBack("c", { n: 1 });
  putBack("c", { n: 2 });
  assert.deepEqual(take("c"), [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test("a file still being written waits; one that stays unreadable is dropped as null", () => {
  fs.mkdirSync(eventsDir(), { recursive: true });
  const partial = path.join(eventsDir(), "raw-t-x.json");
  fs.writeFileSync(partial, '{"pageCont');
  assert.deepEqual(take("t"), []);
  assert.ok(fs.existsSync(partial), "left for the next pass");
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(partial, old, old);
  assert.deepEqual(take("t"), [null]);
  assert.ok(!fs.existsSync(partial));
});

test("an event that lands in the clock tick of a pass that found nothing is still taken", () => {
  fs.mkdirSync(eventsDir(), { recursive: true });
  const tick = Math.floor(Date.now() / 1000); // a coarse clock: the folder's mtime doesn't move
  fs.utimesSync(eventsDir(), tick, tick);
  assert.deepEqual(take("r"), []);
  posted("r", { n: 1 });
  fs.utimesSync(eventsDir(), tick, tick);
  assert.deepEqual(take("r"), [{ n: 1 }]);
});

test("the watch applies events as they land, until it's told to stop", async () => {
  const seen: unknown[] = [];
  let until = Date.now() + 60_000;
  watch("w", async () => void seen.push(...take("w")), () => until);
  await new Promise((r) => setTimeout(r, 200)); // macOS's watch starts a moment after it's made
  posted("w", { n: 1 });
  for (let i = 0; i < 100 && !seen.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, [{ n: 1 }]);
  until = 0;
});

test("passes for a title run one at a time, whoever asks, and one that fails doesn't stop the next", async () => {
  const seen: string[] = [];
  const pass = (name: string, fail = false) => async () => {
    seen.push(`${name} starts`);
    await new Promise((r) => setTimeout(r, 20));
    seen.push(`${name} ends`);
    if (fail) throw new Error(name);
  };
  const runs = [inTurn("q", pass("a", true)), inTurn("q", pass("b")), inTurn("other", pass("c"))];
  await Promise.allSettled(runs);
  await assert.rejects(runs[0], /a/);
  assert.deepEqual(seen.filter((x) => !x.startsWith("c")), ["a starts", "a ends", "b starts", "b ends"]);
  assert.ok(seen.indexOf("c starts") < seen.indexOf("a ends"), "another title's pass doesn't wait");
});

test("embedded JSON can't end a script or start markup", () => {
  const text = embed({ x: "</script><script>alert(1)</script>&\u2028" });
  assert.ok(!/[<>&\u2028]/.test(text));
  assert.deepEqual(JSON.parse(text), { x: "</script><script>alert(1)</script>&\u2028" });
});

test("the pages' key is the one install keeps; with none, the refusal says how to set it", () => {
  const file = pageKeyFile(process.env.STORAGE_DIR!);
  assert.throws(() => pageKey(), (e: Error) => e instanceof Told && e.message.includes("install --page-key"));
  writeAtomic(file, "brx-1\n");
  assert.equal(pageKey(), "brx-1");
});

test("a public file is written where AnythingLLM serves it", () => {
  writePublic("library-lean/x.json", "{}");
  assert.equal(fs.readFileSync(path.join(publicDir(), "library-lean", "x.json"), "utf8"), "{}");
});

test("a public file that can't be written, moved or read is told by its code: the error names no path, so no token", () => {
  const token = "c2VjcmV0dG9rZW5zZWNyZXR0b2tlbg";
  writePublic(`vault-lean/${token}.html`, "page");
  const f = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
  const was = { renameSync: f.renameSync, readFileSync: f.readFileSync };
  const fail = (code: string) => (...args: unknown[]) => {
    throw Object.assign(new Error(`${code}: refused, '${args.join("' -> '")}'`), { code });
  };
  try {
    f.renameSync = fail("EACCES");
    assert.throws(() => writePublic(`vault-lean/${token}.html`, "new page"), (e: Error & { code?: string }) => e.message === "couldn't write a vault-lean page (EACCES)" && e.code === "EACCES");
    assert.throws(() => renamePublic(`vault-lean/${token}.html`, `vault-lean/${token}x.html`), (e: Error) => e.message === "couldn't move a vault-lean page (EACCES)");
    f.readFileSync = fail("EIO");
    assert.throws(() => readPublic(`library-lean/${token}.json`), (e: Error) => e.message === "couldn't read a library-lean page (EIO)" && !e.message.includes(token));
  } finally {
    Object.assign(f, was);
  }
  assert.equal(readPublic(`vault-lean/${token}.html`), "page", "as it was");
  assert.equal(readPublic(`vault-lean/${token}-keys.json`), null, "none is none");
});

test("a public file's path can't leave the public folder", () => {
  const vault = path.join(process.env.STORAGE_DIR!, "vault-lean", "vault.json");
  writeAtomic(vault, "{}");
  const out = /isn't in AnythingLLM's public folder/;
  assert.throws(() => removePublic("library-lean/s-/../../../storage/vault-lean/vault.json"), out);
  assert.throws(() => removePublic(vault), out, "nor an absolute path");
  assert.throws(() => writePublic("../storage/vault-lean/vault.json", "gone"), out);
  assert.throws(() => listPublic(".."), out);
  assert.throws(() => writePublic("elsewhere/x.html", "a page the fence wouldn't keep the agent from"), /isn't in one of the pages' folders \(vault-lean, library-lean, browser-lean, apps-lean\)/);
  assert.equal(fs.readFileSync(vault, "utf8"), "{}", "the file outside is as it was");
  removePublic("library-lean/x.json");
  assert.ok(!fs.existsSync(path.join(publicDir(), "library-lean", "x.json")), "one inside goes");
  assert.deepEqual(listPublic("library-lean/"), []);
});
