// The Library page's names when the links are kept from the agent (#shared/page-links): names made
// before the switch went on, and so possibly given to the agent, are replaced once, after what
// waited under the old secret is applied; the page's path is kept in the links file either way.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { linksFile, readLinks } from "#shared/page-links";
import { call, hideLinks, library, pageState, post, publicDir, reset, storage } from "./harness.mts";

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

const vaultNames = (): { token: string; secret: string; hidden?: true } => JSON.parse(fs.readFileSync(path.join(storage, "vault-lean", "vault-page.json"), "utf8"));

test("every call settles the names, one that shows no page too, for a chat and for a job: the old links are dead at once, both pages", async () => {
  for (const via of [(args: Record<string, unknown>) => call(args), (args: Record<string, unknown>) => call(args, null)]) {
    reset();
    await call({ action: "library" }); // both pages, made with the switch off
    const was = names();
    const vaultWas = vaultNames();
    assert.equal(was.hidden, undefined);
    hideLinks(true);
    await via({ action: "guide" }); // shows no page
    const now = names();
    assert.notEqual(now.token, was.token, "the Library page was replaced by a call that shows no page");
    assert.equal(now.hidden, true);
    assert.ok(!fs.existsSync(pub(`${was.token}.html`)) && !fs.existsSync(pub(`${was.token}.json`)), "the old Library page is gone");
    assert.ok(fs.existsSync(pub(`${now.token}.html`)), "and the new one is there, so the link kept is a page");
    assert.notEqual(vaultNames().token, vaultWas.token, "the Vault was replaced by the same call");
    assert.equal(vaultNames().hidden, true);
    assert.ok(!fs.existsSync(path.join(publicDir, "vault-lean", `${vaultWas.token}.html`)), "the old Vault page is gone");
    const links = readLinks();
    assert.equal(links.library, `/library-lean/${now.token}.html`);
    assert.equal(links.vault, `/vault-lean/${vaultNames().token}.html`);
    assert.match(String(links.rotated?.library), /^\d{4}-\d\d-\d\dT/, "this page's rotation is recorded");
    assert.match(String(links.rotated?.vault), /^\d{4}-\d\d-\d\dT/, "and the other's, on its own");
    const kept = names().token;
    await via({ action: "guide" });
    assert.equal(names().token, kept, "once");
  }
});

test("the page's folder keeps nothing from an earlier token: a crash or a late writer's files are removed at the next call, and other files stay", async () => {
  hideLinks(true);
  await call({ action: "library" });
  const { token } = names();
  const stale = ["Zm9vYmFyYmF6cXV4MTIzNDU2", "b2xkb2xkb2xkb2xkb2xkb2xk"];
  for (const s of stale) for (const ext of ["html", "json"]) fs.writeFileSync(pub(`${s}.${ext}`), "old");
  fs.writeFileSync(pub("reach-abc123.txt"), "a reach check's file");
  await job({ action: "guide" });
  for (const s of stale) assert.ok(!fs.existsSync(pub(`${s}.html`)) && !fs.existsSync(pub(`${s}.json`)), `${s} is gone`);
  assert.ok(fs.existsSync(pub(`${token}.html`)) && fs.existsSync(pub(`${token}.json`)), "the current page stays");
  assert.ok(fs.existsSync(pub("reach-abc123.txt")), "a reach check's file is not the page's");
  // And a show, which writes the page, does the same.
  fs.writeFileSync(pub(`${stale[0]}.html`), "old again");
  await call({ action: "library" });
  assert.ok(!fs.existsSync(pub(`${stale[0]}.html`)));
});

test("while the links are kept from the agent an error that names a page's path doesn't carry its token back to the agent", async (t) => {
  if (process.getuid?.() === 0) return t.skip("a folder can't be made unwritable for root");
  hideLinks(true);
  await call({ action: "library" });
  const { token } = names();
  const dir = path.join(publicDir, "library-lean");
  fs.rmSync(pub(`${token}.html`)); // the next write has to make it again, in a folder that won't take it
  fs.chmodSync(dir, 0o500);
  try {
    const said = await call({ action: "library" });
    assert.match(said, /aren't available here/, said);
    assert.ok(!said.includes(token), `the token is in the answer: ${said}`);
    assert.ok(!/library-lean\/[\w-]{12,}/.test(said), said);
  } finally {
    fs.chmodSync(dir, 0o755);
  }
  hideLinks(false);
  fs.chmodSync(dir, 0o500);
  try {
    const open = await call({ action: "library" });
    assert.match(open, /aren't available here/, open);
    assert.ok(open.includes(names().token), "with the links given anyway, the text is as it was");
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

const SEAM = Symbol.for("anywherellm-suite.library-page.written");
const seamed = globalThis as unknown as Record<symbol, (() => void) | undefined>;
test.afterEach(() => void delete seamed[SEAM]);

test("with the switch off no call removes anything from either folder, a job's call included", async () => {
  await call({ action: "library" });
  const stray = ["library-lean", "vault-lean"].flatMap((dir) => ["Zm9vYmFyYmF6cXV4MTIzNDU2.html", "Zm9vYmFyYmF6cXV4MTIzNDU2.json"].map((f) => path.join(publicDir, dir, f)));
  for (const f of stray) fs.writeFileSync(f, "someone else's page");
  await job({ action: "guide" });
  await job();
  await call({ action: "library" });
  await call({ action: "guide" });
  for (const f of stray) assert.ok(fs.existsSync(f), `${path.basename(path.dirname(f))}/${path.basename(f)} was removed with the switch off`);
  assert.ok(!fs.existsSync(path.join(library, "page.json.lock")), "no lock left behind");
});

test("a call that can't settle the Vault still applies what the user did on the Library page", async () => {
  await call({ action: "save", service: "ex", toolkit: { base_urls: ["https://api.example.com"] }, function: { name: "one", description: "One.", source: "async function main() { return 1; }" } });
  await call({ action: "save", service: "ex", function: { name: "two", description: "Two.", source: "async function main() { return 2; }" } });
  hideLinks(true);
  await call({ action: "library" }); // the pages are made, marked
  fs.writeFileSync(path.join(storage, "vault-lean", "vault-page.json"), '{"token": "LEAKYTOKENVALUE123456", "secret": "LEAKYSECRETVALUE1234');
  post({ ev: "fn-delete", fn: "ex.one" });
  const listing = await call({ action: "library", service: "ex" });
  assert.match(listing, /Functions:\n- ex\.two\(\)(?!.*ex\.one)/s, "the event was applied although the Vault's names are damaged");
});

test("a page state written under a token a rotation has replaced is removed again, not left at an address the agent had", async () => {
  hideLinks(true);
  await call({ action: "library" });
  const old = names();
  // A rotation lands between the state being written and the look at the names, as another process's would.
  seamed[SEAM] = () => {
    delete seamed[SEAM];
    fs.writeFileSync(path.join(library, "page.json"), JSON.stringify({ ...names(), token: "bmV3dG9rZW5uZXd0b2tlbjEy", secret: "bmV3c2VjcmV0bmV3c2VjcmV0" }));
  };
  await call({ action: "save", service: "ex", toolkit: { base_urls: ["https://api.example.com"] }, function: { name: "one", description: "One.", source: "async function main() { return 1; }" } });
  await call({ action: "run", name: "ex.one" }); // a run's end writes the state again
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(names().token, "bmV3dG9rZW5uZXd0b2tlbjEy", "the seam's rotation happened");
  assert.ok(!fs.existsSync(pub(`${old.token}.json`)), "the old token's state is gone");
});

test("a writer that read the names before a rotation removes what it wrote and writes under the new ones", async () => {
  hideLinks(true);
  await call({ action: "library" });
  const old = names();
  fs.rmSync(pub(`${old.token}.html`)); // the next show writes the page again
  seamed[SEAM] = () => {
    delete seamed[SEAM];
    fs.writeFileSync(path.join(library, "page.json"), JSON.stringify({ ...names(), token: "bmV3dG9rZW5uZXd0b2tlbjEy", secret: "bmV3c2VjcmV0bmV3c2VjcmV0" }));
  };
  await call({ action: "library" });
  const now = names();
  assert.equal(now.token, "bmV3dG9rZW5uZXd0b2tlbjEy");
  assert.ok(!fs.existsSync(pub(`${old.token}.html`)) && !fs.existsSync(pub(`${old.token}.json`)), "nothing of the old token");
  assert.ok(fs.existsSync(pub(`${now.token}.html`)) && fs.existsSync(pub(`${now.token}.json`)), "the page is under the new token");
  assert.equal(readLinks().library, `/library-lean/${now.token}.html`, "the link kept is the new one, never the old");
});

test("when the pages' names can't be read to hide them, nothing of an error goes back to the agent", async (t) => {
  if (process.getuid?.() === 0) return t.skip("a folder can't be made unwritable for root");
  hideLinks(true);
  await call({ action: "library" });
  const dir = path.join(publicDir, "library-lean");
  const vaultNames = path.join(storage, "vault-lean", "vault-page.json");
  const good = fs.readFileSync(vaultNames, "utf8");
  fs.chmodSync(dir, 0o500); // an error that names a path is what the agent would get
  try {
    // A damaged Vault names file: reading it to hide its token fails, and its text is in the error.
    fs.writeFileSync(vaultNames, '{"token": "LEAKYTOKENVALUE123456", "secret": "LEAKYSECRETVALUE1234');
    const a = await call({ action: "library" });
    assert.match(a, /something went wrong with the pages: see the log/, a);
    assert.ok(!/LEAKY/.test(a) && !a.includes(names().token), a);
    // A damaged Library names file, the same.
    fs.writeFileSync(vaultNames, good);
    fs.writeFileSync(path.join(library, "page.json"), '{"token": "LEAKYTOKENVALUE123456", "secret": "LEAKYSECRETVALUE1234');
    const b = await call({ action: "library" });
    assert.ok(!/LEAKY/.test(b), b);
    assert.match(b, /something went wrong with the pages: see the log/, b);
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

test("both pages' secrets are hidden from an error text, not only the tokens", async () => {
  hideLinks(true);
  await call({ action: "library" });
  const vaultSecret = (JSON.parse(fs.readFileSync(path.join(storage, "vault-lean", "vault-page.json"), "utf8")) as { secret: string }).secret;
  const pageSecret = names().secret;
  // A failure inside the page's write whose message holds both secrets, as a damaged file's parse error can.
  seamed[SEAM] = () => {
    delete seamed[SEAM];
    throw new Error(`broke on ${vaultSecret} and ${pageSecret}`);
  };
  fs.rmSync(pub(`${names().token}.html`)); // the next show writes the page again, and meets the seam
  const said = await call({ action: "library" });
  assert.match(said, /aren't available here/, said);
  assert.ok(!said.includes(vaultSecret), `the Vault's secret is in the answer: ${said}`);
  assert.ok(!said.includes(pageSecret), `the Library page's secret is in the answer: ${said}`);
});
