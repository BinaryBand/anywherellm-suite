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
  assert.match(await call("home", { action: "list" }), /^Changes made on app pages since the last call[^\n]*\n- add Jam on shop\n/);
});

test("delete keeps the app in the trash, the newest twenty", async () => {
  for (let i = 0; i < store.TRASH_KEPT + 2; i++) {
    await call("home", { action: "create", name: `gone-${i}`, title: "Gone", starter: "checklist" });
    assert.match(await call("home", { action: "delete", name: `gone-${i}` }), /^Deleted the app gone-\d+, its changes and its page\. It's kept in AnythingLLM's storage for now, under apps-lean\/\.trash/);
  }
  const trash = fs.readdirSync(path.join(root, ".trash"));
  assert.equal(trash.length, store.TRASH_KEPT);
  assert.deepEqual(trash.map((f) => f.replace(/^\d{13}-home-/, "")).sort(), Array.from({ length: store.TRASH_KEPT }, (_, i) => `gone-${i + 2}.json`).sort(), "the two deleted first went");
  assert.ok(!store.list("home").some((a) => a.name.startsWith("gone-")));
});
