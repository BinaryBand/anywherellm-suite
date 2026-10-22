// The apps manager: its page and state in the public folder, its path in the links file, the store
// steps it calls (retitle, take back, put back, restore) and the events its page posts.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { linksFile } from "#shared/page-links";
import { postEvent, setLinksHidden } from "#shared/test-helpers";
import { call, definitionFor, publicDir, reset, root, skillDir, storage } from "./harness.mts";
import { compose, template } from "../src/parts.ts";
import * as store from "../src/store.ts";

const MANAGER = /^manager-[\w-]{24}\.html$/;
const pub = () => path.join(publicDir, "apps-lean");
const names = () => JSON.parse(fs.readFileSync(path.join(root, ".manager.json"), "utf8"));
const state = () => JSON.parse(fs.readFileSync(path.join(pub(), `manager-${names().token}.json`), "utf8"));
const links = () => JSON.parse(fs.readFileSync(linksFile(storage), "utf8"));
/** What the manager's page posts: its event with the manager's secret, unless `secret` says another. */
const manage = (event: Record<string, unknown>, secret = names().secret) => postEvent(storage, "apps-lean-manage", { apps_lean_manage: 1, secret, ...event });
/** A page an app can have, made from the parts. */
const listPage = () => compose(template("column"), "item-list");
/** A chat call that takes what the manager posted first, as any call does. */
const settled = () => call("home", { action: "list" });

beforeEach(async () => {
  reset();
  setLinksHidden(storage, false);
  fs.rmSync(linksFile(storage), { force: true });
  await store.create("home", "groceries", { ...definitionFor("list", { title: "Groceries" }), data: { items: [] } });
  await store.change("home", "groceries", { patch: [{ op: "add", path: "/items/-", value: { text: "Eggs", done: false } }], ev: "add", fields: { text: "Eggs" } });
});

test("a chat call makes the manager beside the apps' pages, keeps its path as apps, and list gives its link", async () => {
  const listed = await settled();
  const files = fs.readdirSync(pub());
  const page = files.find((f) => MANAGER.test(f))!;
  assert.ok(page, files.join(", "));
  assert.equal(links().apps, `/apps-lean/${page}`);
  assert.ok(listed.endsWith(`The user manages every workspace's apps, and the trash, at /apps-lean/${page}`), listed);
  const html = fs.readFileSync(path.join(pub(), page), "utf8");
  assert.ok(html.includes(`"token":"manager-${names().token}"`) && html.includes('"key":"brx-test"'), "the page reads its state and posts with the pages' key");
  assert.ok(!html.includes("/*CONFIG*/null"));
  const shown = state().workspaces;
  assert.deepEqual(shown.map((w: any) => [w.workspace, w.apps.map((a: any) => [a.name, a.title, a.summary])]), [["home", [["groceries", "Groceries", "1 of 1 left"]]]]);
  assert.deepEqual(shown[0].apps[0].changes.map((c: any) => [c.ev, c.text, c.by]), [["add", "Eggs", "agent"]]);
  assert.ok(!JSON.stringify(state()).includes(store.read("home", "groceries").secret), "no app's secret");
});

test("with the links kept from the agent, the manager is still made and kept in the links file, and list says where the user opens it", async () => {
  setLinksHidden(storage, true);
  const listed = await settled();
  assert.match(links().apps, /^\/apps-lean\/manager-[\w-]{24}\.html$/);
  assert.ok(!listed.includes("manager-"), listed);
  assert.match(listed, /on the apps manager, in AnywhereLLM Lite/);
});

test("rename changes the title only, and keeps the old one among the earlier versions", async () => {
  await settled();
  manage({ ev: "rename", workspace: "home", app: "groceries", title: "Shopping list" });
  const listed = await settled();
  const app = store.read("home", "groceries");
  assert.deepEqual([app.name, app.title], ["groceries", "Shopping list"]);
  assert.equal(app.versions.at(-1).file, "app.json");
  assert.match(app.versions.at(-1).before, /"title": "Groceries"/);
  assert.match(state().result.title, /^renamed Groceries to Shopping list$/);
  assert.match(listed, /apps manager since the last call[^\n]*\n- renamed Groceries to Shopping list\n/, "the agent is told, at its next chat call");
});

test("take back takes back the newest change only while it is the one the page showed", async () => {
  await settled();
  const n = store.read("home", "groceries").history.at(-1).n;
  await store.change("home", "groceries", { patch: [{ op: "add", path: "/items/-", value: { text: "Jam", done: false } }], ev: "add", fields: { text: "Jam" } });
  manage({ ev: "take-back", workspace: "home", app: "groceries", n, title: "Groceries" });
  await settled();
  assert.equal(store.read("home", "groceries").data.items.length, 2, "a newer change came in: nothing taken back");
  assert.match(state().result.error, /no longer Groceries's newest change/);
  manage({ ev: "take-back", workspace: "home", app: "groceries", n: store.read("home", "groceries").history.at(-1).n, title: "Groceries" });
  await settled();
  assert.deepEqual(store.read("home", "groceries").data.items.map((i: any) => i.text), ["Eggs"]);
  assert.equal(state().result.error, null);
});

test("put back restores an earlier file and keeps the one it replaced, so it can be put back in turn", async () => {
  await store.writeFile("home", "groceries", "page.html", listPage());
  const app = store.read("home", "groceries");
  const before = app.versions.at(-1);
  assert.equal(before.file, "page.html");
  await settled();
  manage({ ev: "put-back", workspace: "home", app: "groceries", file: "page.html", at: before.t, title: "Groceries" });
  await settled();
  const after = store.read("home", "groceries");
  assert.equal(after.page ?? null, before.before, "no page, as before it was written");
  assert.equal(after.versions.at(-1).before, listPage(), "the page it replaced is kept");
  manage({ ev: "put-back", workspace: "home", app: "groceries", file: "page.html", at: "2000-01-01T00:00:00Z", title: "Groceries" });
  await settled();
  assert.match(state().result.error, /keeps no page\.html from 2000/);
});

test("trash moves an app out, and restore brings it back with a new page, refused while its name is taken", async () => {
  await settled();
  const token = store.read("home", "groceries").pageToken;
  manage({ ev: "trash", workspace: "home", app: "groceries", title: "Groceries" });
  await settled();
  assert.throws(() => store.read("home", "groceries"), /no app named groceries/);
  const [held] = state().trash;
  assert.deepEqual([held.workspace, held.name, held.title], ["home", "groceries", "Groceries"]);
  assert.ok(Date.parse(held.until) > Date.now() + 29 * 86_400_000);

  await store.create("home", "groceries", { ...definitionFor("list", { title: "Another" }), data: { items: [] } });
  manage({ ev: "restore", id: held.id, title: "Groceries" });
  await settled();
  assert.match(state().result.error, /home already has an app named groceries: move that one to the trash first/);
  await store.remove("home", "groceries");

  manage({ ev: "restore", id: held.id, title: "Groceries" });
  await settled();
  const back = store.read("home", "groceries");
  assert.equal(back.title, "Groceries");
  assert.notEqual(back.pageToken ?? null, token ?? "none", "a new address, never the old one");
  assert.deepEqual(state().trash.map((x: any) => x.title), ["Another"]);
});

test("an event under another secret is dropped, and says nothing", async () => {
  await settled();
  manage({ ev: "rename", workspace: "home", app: "groceries", title: "Forged" }, "not-the-secret");
  await settled();
  assert.equal(store.read("home", "groceries").title, "Groceries");
  assert.equal(state().result, null);
});

test("a new link replaces the manager's address and its links-file path, and leaves the apps' own pages alone", async () => {
  await store.writeFile("home", "groceries", "page.html", listPage());
  await call("home", { action: "page", name: "groceries" });
  const appPage = `${store.read("home", "groceries").pageToken}.html`;
  const was = names().token;
  manage({ ev: "rotate" });
  await settled();
  const files = fs.readdirSync(pub());
  assert.notEqual(names().token, was);
  assert.equal(links().apps, `/apps-lean/manager-${names().token}.html`);
  assert.ok(links().rotated.apps);
  assert.ok(!files.some((f) => f.includes(was)), "the old address is gone");
  assert.ok(files.includes(appPage), "the app's page stays");
});

test("every event the page posts is one the skill applies, and every field it reads is one the state has", async () => {
  await store.writeFile("home", "groceries", "page.html", listPage()); // a change (beforeEach) and a version
  await store.create("home", "spare", { ...definitionFor("list", { title: "Spare" }), data: { items: [] } });
  await store.remove("home", "spare"); // something in the trash
  await settled();
  const html = fs.readFileSync(path.join(skillDir, "static", "pages", "manager.html"), "utf8");
  const source = fs.readFileSync(path.join(skillDir, "src", "manager.ts"), "utf8");
  const posted = [...html.matchAll(/post\("([\w-]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(posted)].sort(), ["put-back", "rename", "restore", "rotate", "take-back", "trash"]);
  for (const ev of posted) assert.ok(source.includes(`case "${ev}":`), ev);
  const s = state();
  const app = s.workspaces[0].apps[0];
  const shapes: Record<string, object> = { now: s, w: s.workspaces[0], a: app, app, x: s.trash[0], c: app.changes[0], v: app.versions[0] };
  for (const [, name, field] of html.matchAll(/\b(now|w|a|app|x|c|v)\.(\w+)/g)) assert.ok(Object.hasOwn(shapes[name], field), `${name}.${field}`);
});
