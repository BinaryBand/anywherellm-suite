import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { definitionFor, root } from "./harness.mts";
import * as store from "../src/store.ts";

const add = (text: string) => [{ op: "add", path: "/items/-", value: { text, done: false } }];

test("an app is made, changed, undone and kept apart by workspace", async () => {
  await store.create("home", "groceries", definitionFor("list", { title: "Groceries" }));
  await store.change("home", "groceries", { patch: add("Eggs"), ev: "add" });
  const app = await store.change("home", "groceries", { patch: add("Milk"), ev: "add" });
  assert.deepEqual(app.data.items.map((i: any) => i.text), ["Eggs", "Milk"]);
  assert.equal(app.history.length, 2);
  const { app: back, undone } = await store.undo("home", "groceries");
  assert.equal(undone?.ev, "add");
  assert.deepEqual(back.data.items.map((i: any) => i.text), ["Eggs"]);
  assert.deepEqual(store.list("work"), []);
  assert.throws(() => store.read("work", "groceries"), /no app named groceries/);
});

test("a change that breaks the schema or doesn't apply is refused and saves nothing", async () => {
  await store.create("home", "chores", definitionFor("list", { title: "Chores" }));
  await assert.rejects(store.change("home", "chores", { patch: [{ op: "add", path: "/items/-", value: { text: "" } }] }), /breaks the app's schema/);
  await assert.rejects(store.change("home", "chores", { patch: [{ op: "remove", path: "/items/4" }] }), /doesn't apply/);
  assert.equal(store.read("home", "chores").history.length, 0);
});

test("only the newest changes are kept, and undo stops when none are left", async () => {
  await store.create("home", "many", definitionFor("list", { title: "Many" }));
  for (let i = 0; i < store.KEEP + 5; i++) await store.change("home", "many", { patch: add(`n${i}`) });
  assert.equal(store.read("home", "many").history.length, store.KEEP);
  for (let i = 0; i < store.KEEP; i++) await store.undo("home", "many");
  assert.equal(store.read("home", "many").data.items.length, 5);
  await assert.rejects(store.undo("home", "many"), /no change left/);
});

test("names, workspaces, duplicates and definitions are checked", async () => {
  await assert.rejects(store.create("home", "Bad Name", definitionFor("list")), /lowercase/);
  assert.throws(() => store.list("../etc"), /not a workspace/);
  await assert.rejects(store.create("home", "groceries", definitionFor("list")), /already has/);
  await assert.rejects(store.create("home", "odd", { title: "Odd", rules: [], schema: { oneOf: [] }, card: {}, data: {} }), /schema\/oneOf/);
  await assert.rejects(store.writeFile("home", "groceries", "app.json", JSON.stringify({ data: {} })), /change the data with do/);
  await assert.rejects(store.writeFile("home", "groceries", "app.json", JSON.stringify({ title: "Food", rules: [], schema: { type: "array" }, card: {} })), /data \/: should be array/);
  const json = JSON.parse(store.readFile("home", "groceries", "app.json")!);
  assert.equal((await store.writeFile("home", "groceries", "app.json", JSON.stringify({ ...json, title: "Food" }))).title, "Food");
  await assert.rejects(store.writeFile("home", "groceries", "page.html", "<p>no runtime</p>"), /must load the runtime/);
});

test("delete removes the app", async () => {
  await store.create("home", "gone", definitionFor("calendar"));
  await store.remove("home", "gone");
  assert.ok(!store.list("home").some((a) => a.name === "gone"));
});

test("a file in the workspace's folder that isn't an app's, such as a lock or a dotfile, isn't listed", async () => {
  const before = store.list("home").length;
  const { writeAtomic } = await import("#shared/atomic");
  const { root } = await import("../src/dirs.ts");
  writeAtomic(`${root()}/home/.news.json`, "[]");
  assert.equal(store.list("home").length, before);
});

test("edit replaces text found exactly once, and changes advance the line", async () => {
  const page = '<script src="app.js"></script><script>App.start(/*APP*/null)</script><b>x</b><b>x</b>';
  await store.create("home", "edited", { ...definitionFor("list", { title: "Edited" }), page });
  await assert.rejects(store.editFile("home", "edited", "page.html", "<b>x</b>", "y"), /more than once/);
  await assert.rejects(store.editFile("home", "edited", "page.html", "nope", "y"), /doesn't hold that text\. It is now:\n<script src="app\.js"><\/script>/);
  await assert.rejects(store.editFile("home", "edited", "app.js", "a", "b"), /isn't one of the app's files/);
  assert.match((await store.editFile("home", "edited", "page.html", "<b>x</b><b>x</b>", "<b>y</b>")).page, /<b>y<\/b>$/);
  assert.equal(store.read("home", "edited").line, 0);
  await store.change("home", "edited", { patch: [{ op: "add", path: "/items/-", value: { text: "a", done: false } }] });
  await store.undo("home", "edited");
  assert.equal(store.read("home", "edited").line, 2);
});

test("write and edit keep each file as it was, and revert puts back the newest change, one at a time", async () => {
  const page = (b: number) => `<script src="app.js"></script><script>App.start(/*APP*/null)</script><b>${b}</b>`;
  await store.create("home", "kept", { ...definitionFor("list", { title: "Kept" }), page: page(1) });
  await store.writeFile("home", "kept", "page.html", page(2));
  await store.editFile("home", "kept", "page.html", "<b>2</b>", "<b>3</b>");
  await store.writeFile("home", "kept", "app.json", JSON.stringify({ ...JSON.parse(store.readFile("home", "kept", "app.json")!), title: "Kept well" }));
  await store.writeFile("home", "kept", "page.html", page(3));
  assert.deepEqual(store.read("home", "kept").versions.map((v: any) => v.file), ["page.html", "page.html", "app.json"], "a write that changes nothing keeps no version");

  // undo takes back the newest change, here to either file; revert, the newest to the file named.
  const { app, reverted } = await store.undo("home", "kept");
  assert.equal(reverted?.file, "app.json");
  assert.equal(app.title, "Kept");
  assert.equal((await store.revert("home", "kept", "page.html")).app.page, page(2));
  assert.equal((await store.revert("home", "kept", "page.html")).app.page, page(1));
  await assert.rejects(store.revert("home", "kept", "page.html"), /no change to page\.html left to take back/);
  await assert.rejects(store.revert("home", "kept", "icon.svg"), /file is app\.json or page\.html/);
});

test("an app keeps its last ten versions, and a revert its data no longer fits is refused", async () => {
  await store.create("home", "many-pages", definitionFor("list", { title: "Many" }));
  for (let i = 0; i < 12; i++) await store.writeFile("home", "many-pages", "page.html", `<script src="app.js"></script><script>App.start(/*APP*/null)</script>${i}`);
  assert.equal(store.read("home", "many-pages").versions.length, store.VERSIONS);

  const json = JSON.parse(store.readFile("home", "many-pages", "app.json")!);
  await store.writeFile("home", "many-pages", "app.json", JSON.stringify({ ...json, schema: { type: "object" } }));
  await store.change("home", "many-pages", { patch: [{ op: "add", path: "/extra", value: 1 }, { op: "remove", path: "/items" }] });
  await assert.rejects(store.revert("home", "many-pages", "app.json"), /the app can't be saved:\n- data \/: needs items/);
  assert.equal(store.read("home", "many-pages").versions.at(-1).file, "app.json", "kept for a revert once the data fits");
});

test("changesOn makes the changes one after another, as change does", async () => {
  const make = (name: string) => store.create("home", name, { ...definitionFor("list", { title: name }), data: { items: [] } });
  await make("many-a");
  await make("many-b");
  const add = (text: string, id?: string) => ({ ev: "add", id, by: "page", patch: [{ op: "add", path: "/items/-", value: { text, done: false } }] });
  const bad = { patch: [{ op: "add", path: "/items/-", value: { text: "" } }] };
  const list = [add("Eggs", "x1"), bad, add("Jam", "x2"), add("Eggs", "x1")];
  const { next: a, answers } = store.changesOn(store.read("home", "many-a"), list);
  assert.deepEqual(answers.map((a) => (a.error ? "error" : a.duplicate ? "duplicate" : "made")), ["made", "error", "made", "duplicate"]);
  for (const opts of [list[0], list[2]]) await store.change("home", "many-b", opts);
  const b = store.read("home", "many-b");
  for (const key of ["data", "line", "seen"]) assert.deepEqual(a[key], b[key], key);
  assert.deepEqual(a.history.map((h: any) => h.patch), b.history.map((h: any) => h.patch));
});

test("two changes to one app at once both land: each waits for the other's lock", async () => {
  await store.create("home", "busy", definitionFor("list", { title: "Busy" }));
  await Promise.all(["a", "b", "c", "d"].map((t) => store.change("home", "busy", { patch: add(t) })));
  assert.deepEqual(store.read("home", "busy").data.items.map((i: any) => i.text).sort(), ["a", "b", "c", "d"]);
});

test("each change keeps the line it made, so an undo between changes leaves their lines right", async () => {
  await store.create("home", "lines", definitionFor("list", { title: "Lines" }));
  await store.change("home", "lines", { patch: add("a") });
  await store.change("home", "lines", { patch: add("b") });
  await store.undo("home", "lines");
  await store.change("home", "lines", { patch: add("c") });
  const app = store.read("home", "lines");
  assert.deepEqual([app.line, app.history.map((h: any) => h.n)], [4, [1, 4]], "line 2 was taken back by the undo at line 3");
});

test("undo takes back the newest change, data or file, told apart by the line each was made at", async () => {
  await store.create("home", "close", definitionFor("list", { title: "Close" }));
  const page = (b: number) => `<script src="app.js"></script><script>App.start(/*APP*/null)</script><b>${b}</b>`;
  await store.change("home", "close", { patch: add("Eggs"), ev: "add" });
  await store.writeFile("home", "close", "page.html", page(1));
  const { reverted } = await store.undo("home", "close");
  assert.equal(reverted?.file, "page.html", "the file's change came after the data's, however close");
  const { undone } = await store.undo("home", "close");
  assert.equal(undone?.ev, "add");
  await assert.rejects(store.undo("home", "close"), /no change left/);
});

test("undo refuses data its app.json no longer fits, and an app with no history has nothing to undo", async () => {
  await store.create("home", "narrowed", definitionFor("list", { title: "Narrowed" }));
  await store.change("home", "narrowed", { patch: [{ op: "add", path: "/extra", value: 1 }] });
  const json = JSON.parse(store.readFile("home", "narrowed", "app.json")!);
  await store.writeFile("home", "narrowed", "app.json", JSON.stringify({ ...json, schema: { ...json.schema, required: [...(json.schema.required || []), "extra"] } }));
  // The app.json change is kept no longer, so undo reaches the data's.
  const file = `${root}/home/narrowed.json`;
  const { versions, ...kept } = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify(kept));
  await assert.rejects(store.undo("home", "narrowed"), /the app can't be undone:\n- data \/: needs extra/);
  assert.equal(store.read("home", "narrowed").data.extra, 1, "nothing was changed");

  const { history, ...rest } = kept;
  fs.writeFileSync(file, JSON.stringify(rest));
  await assert.rejects(store.undo("home", "narrowed"), /no change left/);
});

test("a page is checked before its app's lock is taken, and a change made meanwhile is kept", async () => {
  await store.create("home", "slow-check", definitionFor("list", { title: "Slow" }));
  // The check never runs a page's scripts, so one that never ends doesn't hold the write.
  const start = Date.now();
  const writing = store.writeFile("home", "slow-check", "page.html", `<script src="app.js"></script><script>App.start(/*APP*/null)</script><script>for (;;) {}</script>`);
  await store.change("home", "slow-check", { patch: add("Eggs") });
  const app = await writing;
  assert.ok(Date.now() - start < 1000, `the write and the change took ${Date.now() - start} ms`);
  assert.deepEqual(store.read("home", "slow-check").data.items.map((i: any) => i.text), ["Eggs"], "the write kept the change made meanwhile");
  assert.ok(app);
});
