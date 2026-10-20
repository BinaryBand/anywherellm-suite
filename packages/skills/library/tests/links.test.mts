// The Library page's names when the links are kept from the agent (#shared/page-links): names made
// before the switch went on, and so possibly given to the agent, are replaced once, after what
// waited under the old secret is applied; the page's path is kept in the links file either way.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { linksFile, readLinks } from "#shared/page-links";
import { call, hideLinks, library, pageState, post, publicDir, reset } from "./harness.mts";

test.beforeEach(reset);

const names = (): { token: string; secret: string; hidden?: true; needs: { label: string }[]; watchUntil: number; origin?: string } => JSON.parse(fs.readFileSync(path.join(library, "page.json"), "utf8"));
const pub = (file: string) => path.join(publicDir, "library-lean", file);
const job = (args: Record<string, unknown> = { action: "library" }) => call(args, null);

/** A page made with the switch off, as every page was before it existed: a need on it, a function
 *  waiting to be deleted by an event posted under its secret, and the retired `origin` field. */
async function oldPage() {
  await call({ action: "save", service: "ex", toolkit: { base_urls: ["https://api.example.com"] }, function: { name: "one", description: "One.", source: "async function main() { return 1; }" } });
  await call({ action: "save", service: "ex", function: { name: "two", description: "Two.", source: "async function main() { return 2; }" } });
  await call({ action: "secret", kind: "ssh", label: "pi" });
  const was = names();
  fs.writeFileSync(path.join(library, "page.json"), JSON.stringify({ ...was, origin: "https://old.example.com" }));
  return was;
}

test("names made before the switch are replaced once it is on: what waited under the old secret is applied first, the old files go, the needs stay", async () => {
  const was = await oldPage();
  assert.equal(was.hidden, undefined, "made with the switch off");
  post({ ev: "fn-delete", fn: "ex.one" }); // posted under the old secret, and nothing drains it for a job
  hideLinks(true);
  await job(); // the listing is made before the page is shown, so this call's own answer can't tell
  const now = names();
  assert.match(await job({ action: "library", service: "ex" }), /Functions:\n- ex\.two\(\)(?!.*ex\.one)/s, "the event was applied by that call: a job doesn't drain by itself");
  assert.notEqual(now.token, was.token);
  assert.notEqual(now.secret, was.secret);
  assert.equal(now.hidden, true);
  assert.deepEqual(now.needs.map((n) => n.label), ["pi"], "the needs are kept");
  assert.ok(!fs.existsSync(pub(`${was.token}.html`)) && !fs.existsSync(pub(`${was.token}.json`)), "the old page and its state are gone");
  assert.ok(fs.existsSync(pub(`${now.token}.html`)) && fs.existsSync(pub(`${now.token}.json`)));
  assert.deepEqual(pageState().needs, [{ label: "pi", site: "" }]);
  assert.equal(readLinks().library, `/library-lean/${now.token}.html`, "the links file has the new path");
  assert.equal(fs.statSync(linksFile()).mode & 0o777, 0o600);
});

test("a second call leaves the new names as they are", async () => {
  await oldPage();
  hideLinks(true);
  await job();
  const once = names();
  await job();
  await call({ action: "library" });
  assert.deepEqual(names(), { ...once, watchUntil: names().watchUntil }, "the same token and secret");
});

test("two calls at once end in one rotation", async () => {
  const was = await oldPage();
  hideLinks(true);
  // Every token page.json holds from now on: a second rotation would show a second new one.
  const seen = new Set<string>();
  const poll = setInterval(() => {
    try {
      seen.add(names().token);
    } catch {
      // between the rename and the read, or while it is written
    }
  }, 1);
  try {
    await Promise.all([job(), job()]);
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    clearInterval(poll);
  }
  seen.delete(was.token);
  assert.deepEqual([...seen], [names().token], "one new token was ever there");
  assert.notEqual(names().token, was.token);
});

test("on, off, on: off drops the mark without rotating, and the next on rotates again", async () => {
  const was = await oldPage();
  hideLinks(true);
  await job();
  const first = names();
  assert.notEqual(first.token, was.token);
  hideLinks(false);
  await job();
  const off = names();
  assert.equal(off.token, first.token, "off doesn't rotate");
  assert.equal(off.hidden, undefined, "the mark is gone, since the links go out again");
  hideLinks(true);
  await job();
  const second = names();
  assert.notEqual(second.token, first.token, "the links were out, so the names are replaced again");
  assert.equal(second.hidden, true);
});

test("with the switch off the path is kept without any rotation", async () => {
  await call({ action: "library" });
  const first = names();
  assert.equal(readLinks().library, `/library-lean/${first.token}.html`);
  await call({ action: "library" });
  await job();
  assert.equal(names().token, first.token);
  assert.equal(names().hidden, undefined);
});

test("a page made with the switch on is marked, and not replaced", async () => {
  hideLinks(true);
  await job();
  const first = names();
  assert.equal(first.hidden, true);
  await job();
  assert.equal(names().token, first.token);
});

test("a damaged links file is written again with the page's path", async () => {
  await call({ action: "library" });
  fs.writeFileSync(linksFile(), "{not json");
  fs.rmSync(path.join(publicDir, "library-lean", `${names().token}.html`), { force: true });
  await call({ action: "library" });
  assert.equal(readLinks().library, `/library-lean/${names().token}.html`);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(linksFile(), "utf8")));
});

test("the page's own rotate event follows the switch: the new names are marked when it is on", async () => {
  hideLinks(true);
  await call({ action: "library" });
  const first = names();
  post({ ev: "rotate" });
  await call({ action: "library" });
  const next = names();
  assert.notEqual(next.token, first.token);
  assert.equal(next.hidden, true);
  assert.equal(readLinks().library, `/library-lean/${next.token}.html`);
  assert.ok(!fs.existsSync(pub(`${first.token}.html`)));
});
