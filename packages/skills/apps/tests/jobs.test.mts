import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { asJob, call, from, root } from "./harness.mts";
import * as store from "../src/store.ts";

const add = (text: string) => JSON.stringify([{ op: "add", path: "/items/-", value: { text, done: false } }]);

test("a chat can't name a workspace: it works on its own", async () => {
  await call("home", { action: "create", name: "shop", title: "Shop", starter: "checklist" });
  assert.match(await call("work", { action: "list", workspace: "home" }), /^Apps: workspace is for a scheduled job/);
});

test("a job works in its own workspace as a chat would, but deletes nothing", async () => {
  assert.match(await asJob({ action: "create", name: "digest", title: "Digest", starter: "checklist" }), /^Made the app digest/);
  assert.match(await asJob({ action: "do", name: "digest", ev: "add", patch: add("Item") }), /^Done: add on digest\./);
  assert.equal(store.read("_jobs", "digest").history.at(-1).by, "job");
  assert.match(await asJob({ action: "delete", name: "digest" }), /^Apps: a scheduled job can't delete:/);
  assert.ok(store.read("_jobs", "digest"));
});

test("a job naming a workspace may list and read there, and do only on an app the user let take it", async () => {
  assert.match(await asJob({ action: "list", workspace: "home" }), /- shop: /);
  assert.match(await asJob({ action: "read", workspace: "home", name: "shop" }), /^shop's app\.json/);
  assert.match(await asJob({ action: "do", workspace: "home", name: "shop", ev: "add", patch: add("Milk") }), /^Apps: shop doesn't take changes from scheduled jobs: the user lets it from a chat/);
  for (const action of ["create", "edit", "undo", "page", "delete"])
    assert.match(await asJob({ action, workspace: "home", name: "shop", file: "page.html", text: "x" }), action === "delete" ? /can't delete:/ : /in a workspace it names, a scheduled job may list, do, read, guide, not /, action);
  // The user lets it, from a chat.
  assert.match(await call("home", { action: "edit", name: "shop", file: "app.json", find: '"card": {', text: '"jobs": true,\n  "card": {' }), /^Changed shop's app\.json\./);
  assert.match(await asJob({ action: "do", workspace: "home", name: "shop", ev: "add", patch: add("Milk") }), /^Done: add on shop\./);
  const app = store.read("home", "shop");
  assert.deepEqual([app.data.items.at(-1).text, app.history.at(-1).by], ["Milk", "job"]);
  assert.match(await asJob({ action: "do", workspace: "nowhere", name: "shop", patch: add("x") }), /^Apps: this workspace has no app named shop/);
  assert.match(await asJob({ action: "list", workspace: "../etc" }), /^Apps: not a workspace/);
});

test("what pages did is told to a chat, never to a job", async () => {
  from("home", "shop", { id: "p1", ev: "add", fields: { text: "Jam" }, patch: [{ op: "add", path: "/items/-", value: { text: "Jam", done: false } }] });
  assert.doesNotMatch(await asJob({ action: "read", workspace: "home", name: "shop" }), /Changes made on app pages/);
  assert.match(await call("home", { action: "list" }), /^Changes made on app pages and the apps manager since the last call[^\n]*\n- add Jam on shop\n/);
});

const DAY = 24 * 60 * 60 * 1000;
const trashDir = () => path.join(root, ".trash");
/** A file in the trash as if its app was deleted `daysAgo` days ago. */
const trashed = (daysAgo: number, name: string) => {
  fs.mkdirSync(trashDir(), { recursive: true });
  fs.writeFileSync(path.join(trashDir(), `${String(Date.now() - daysAgo * DAY).padStart(13, "0")}-home-${name}.json`), "{}");
};
const emptyTrash = () => fs.rmSync(trashDir(), { recursive: true, force: true });

test("delete moves the app to the trash", async () => {
  emptyTrash();
  await call("home", { action: "create", name: "gone", title: "Gone", starter: "checklist" });
  assert.match(await call("home", { action: "delete", name: "gone" }), /^Deleted the app gone, its changes and its page\. It stays in the trash 30 days, and the user restores it from there on the apps manager/);
  assert.deepEqual(fs.readdirSync(trashDir()).map((f) => f.replace(/^\d{13}-home-/, "")), ["gone.json"]);
  assert.ok(!store.list("home").some((a) => a.name === "gone"));
});

test("deleting more apps than the trash used to keep pushes none out", async () => {
  emptyTrash();
  for (let i = 0; i < 25; i++) {
    await call("home", { action: "create", name: `churn-${i}`, title: "Churn", starter: "checklist" });
    await call("home", { action: "delete", name: `churn-${i}` });
  }
  assert.equal(fs.readdirSync(trashDir()).length, 25, "every one deleted within the 30 days is still there");
});

test("an app is swept from the trash once it's past 30 days, the oldest first, and not before", async () => {
  emptyTrash();
  trashed(31, "old");
  trashed(29, "recent");
  await call("home", { action: "create", name: "now", title: "Now", starter: "checklist" });
  await call("home", { action: "delete", name: "now" });
  assert.deepEqual(fs.readdirSync(trashDir()).map((f) => f.replace(/^\d{13}-home-/, "")).sort(), ["now.json", "recent.json"], "the 31-day-old one went, the 29-day-old one stayed");
});

test("a trash full of apps within their 30 days refuses a delete and keeps the app", async () => {
  emptyTrash();
  for (let i = 0; i < store.TRASH_MAX; i++) trashed(1 + (i % 20), `held-${i}`);
  await call("home", { action: "create", name: "keep", title: "Keep", starter: "checklist" });
  assert.match(await call("home", { action: "delete", name: "keep" }), /^Apps: the trash is full: it holds 100 deleted apps, each kept 30 days, so keep stays; the oldest leaves the trash on \d{4}-\d\d-\d\d\./);
  assert.equal(fs.readdirSync(trashDir()).length, store.TRASH_MAX, "none was dropped");
  assert.ok(store.list("home").some((a) => a.name === "keep"), "the app is still there");
  fs.rmSync(path.join(trashDir(), fs.readdirSync(trashDir()).find((f) => f.endsWith("-home-held-0.json"))!));
  trashed(31, "stale");
  assert.equal(fs.readdirSync(trashDir()).length, store.TRASH_MAX, "still full, but one of them is past its days");
  assert.match(await call("home", { action: "delete", name: "keep" }), /^Deleted the app keep/, "a place frees once one is past its days");
  const names = fs.readdirSync(trashDir()).map((f) => f.replace(/^\d{13}-home-/, ""));
  assert.equal(names.length, store.TRASH_MAX, "the stale one went, the new one came");
  assert.ok(names.includes("keep.json") && !names.includes("stale.json"));
  emptyTrash();
});
