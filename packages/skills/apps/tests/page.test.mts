import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import vm from "node:vm";
import { pageKeyFile } from "#shared/anythingllm";
import { Told } from "#shared/errors";
import { call, definitionFor, publicDir, storage } from "./harness.mts";
import { pageUrl, publish, refresh, render, stateOf, unpublish } from "../src/page.ts";
import { apply } from "../src/patch.ts";
import * as parts from "../src/parts.ts";
import * as store from "../src/store.ts";

const listPage = () => parts.compose(parts.template("column"), "item-list");
const groceries = (items: unknown[] = [{ text: "Eggs", done: true }, { text: "</script><b>", done: false }]) => ({
  name: "groceries", changed: "2026-10-13T12:00:00Z", line: 4, seen: ["a"], ...definitionFor("list", { title: "Groceries" }), page: listPage(), data: { items },
});

test("a page is rendered with this skill's stand-in for a server", () => {
  const html = render({ ...groceries(), secret: "s3cret" }, "home", "brx-test")!;
  const lean = JSON.parse(html.match(/<script id="apps-lean" type="application\/json">(.*?)<\/script>/)![1]);
  assert.deepEqual([lean.workspace, lean.app, lean.secret, lean.key, lean.line, lean.seen], ["home", "groceries", "s3cret", "brx-test", 4, ["a"]]);
  assert.equal(lean.base, undefined, "the page needs no address of AnythingLLM's: it posts and reads relative to its own");
  assert.equal(lean.data.items[1].text, "</script><b>");
  assert.ok(html.includes("App.start(AppsLean.app())"));
  const outside = html.replace(/<script[^>]*>[\s\S]*?<\/script>|<style>[\s\S]*?<\/style>/g, "");
  assert.ok(!outside.includes('src="app.js"') && !outside.includes('href="app.css"'), "every library is inline");
  assert.ok(html.indexOf("var AppsLean") < html.indexOf("const App = (() =>"), "the stand-in comes before the runtime");
  // The app's data, the stand-in, the patch library, app.js, motion.js, the template's script and
  // item-list's: no inlined text ends a script early.
  assert.equal(html.split("</script>").length - 1, 7);
  assert.equal(render({ ...groceries(), page: undefined }, "home", "k"), null, "an app with no page has none to render");
});

test("a page is published at one random address, rewritten and removed", async () => {
  await store.create("home", "shop", definitionFor("list", { title: "Shop" }));
  await store.writeFile("home", "shop", "page.html", listPage());
  const token = await publish(store.read("home", "shop"), "home");
  assert.equal(token, store.read("home", "shop").pageToken);
  assert.equal(pageUrl(token, "https://owen.example:3001/"), `https://owen.example:3001/apps-lean/${token}.html`);
  assert.equal(pageUrl(token, null), `/apps-lean/${token}.html`, "relative without AnythingLLM's address");
  const file = path.join(publicDir, "apps-lean", `${token}.html`);
  assert.ok(!fs.existsSync(path.join(publicDir, "_apps")), "no font beside it: pages use the system's own");
  await store.change("home", "shop", { patch: [{ op: "add", path: "/items/-", value: { text: "Tea", done: false } }] });
  await refresh("home", "shop");
  assert.match(fs.readFileSync(file, "utf8"), /"text":"Tea"/);
  assert.equal(await publish(store.read("home", "shop"), "home"), token, "the address stays");
  unpublish(store.read("home", "shop"));
  assert.ok(!fs.existsSync(file));
});

test("where the public folder can't be written there is no address", async () => {
  const blocker = path.join(storage, "blocker");
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(blocker, "");
  const was = process.env.ANYTHINGLLM_PUBLIC_DIR;
  process.env.ANYTHINGLLM_PUBLIC_DIR = path.join(blocker, "public");
  try {
    await store.create("home", "nowhere", { ...definitionFor("list", { title: "Nowhere" }), page: listPage() });
    assert.equal(await publish(store.read("home", "nowhere"), "home"), null);
    assert.equal(store.read("home", "nowhere").pageToken, undefined);
  } finally {
    process.env.ANYTHINGLLM_PUBLIC_DIR = was;
  }
});

test("with no key for the pages, page says how to set one, and a page already there still keeps up", async () => {
  await store.create("home", "keyless", { ...definitionFor("list", { title: "Keyless" }), page: listPage() });
  const token = (await publish(store.read("home", "keyless"), "home"))!;
  const { version } = store.read("home", "keyless");
  const keyFile = pageKeyFile(storage);
  const key = fs.readFileSync(keyFile, "utf8");
  fs.rmSync(keyFile);
  try {
    await store.change("home", "keyless", { patch: [{ op: "add", path: "/items/-", value: { text: "Tea", done: false } }] });
    await assert.rejects(publish(store.read("home", "keyless"), "home"), (e: Error) => e instanceof Told && e.message.includes("install --page-key"));
    const state = JSON.parse(fs.readFileSync(path.join(publicDir, "apps-lean", `${token}.json`), "utf8"));
    assert.deepEqual([state.data.items.at(-1).text, state.version], ["Tea", version], "the change shows, and the page doesn't reload");
    assert.match(await call("home", { action: "page", name: "keyless" }), /^Apps: the skills' pages have no key to post with/);
  } finally {
    fs.writeFileSync(keyFile, key);
  }
});

const browsers: (() => void)[] = [];
afterEach(() => browsers.splice(0).forEach((close) => close()));

/** Runs a rendered page's scripts (the stand-in, the patch library and app.js) against a small stand-in for a browser,
 *  with `served` as what reading the page's state file gives. */
function browser(html: string, { stored = null, served = () => "{}", typing = false }: { stored?: unknown; served?: () => string; typing?: boolean } = {}) {
  const lean = html.match(/<script id="apps-lean" type="application\/json">(.*?)<\/script>/)![1];
  const scripts = parts.scriptsOf(html);
  const posted: any[] = [];
  const storage = { v: (stored ? JSON.stringify(stored) : null) as string | null, getItem() { return this.v; }, setItem(_k: string, v: string) { this.v = v; } };
  const urls: string[] = [];
  const fetch = async (url: string, opts: any) => {
    if (url === "/apps-lean/p.json") return new Response(served());
    urls.push(url);
    posted.push(JSON.parse(JSON.parse(opts.body).textContent));
    return new Response("{}", { status: 200 });
  };
  let open = true;
  const seen = { reloads: 0, bars: [] as string[] };
  const element = () => ({ style: {}, dataset: {}, textContent: "", setAttribute() {}, addEventListener() {}, append(child: any) { this.textContent += child.textContent ?? ""; } });
  const ctx: any = {
    console, JSON, Response, Promise, Object, Math, Date, Array, Error, URLSearchParams,
    // Fast, and none once closed, so the runtime's sync loop stops with the test.
    setTimeout: (fn: () => void, ms: number) => (open ? setTimeout(fn, Math.min(ms, 20)) : 0), clearTimeout,
    localStorage: storage,
    location: { protocol: "https:", href: "https://x/apps-lean/p.html", pathname: "/apps-lean/p.html", search: "", reload: () => void seen.reloads++ },
    document: {
      getElementById: (id: string) => (id === "apps-lean" ? { textContent: lean } : null), addEventListener() {}, removeEventListener() {}, visibilityState: "visible", hidden: false,
      activeElement: typing ? { tagName: "INPUT" } : null, createElement: element, readyState: "complete", body: { append: (el: any) => void (el.textContent && seen.bars.push(el.textContent)) },
    },
    fetch, addEventListener() {},
  };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  // The stand-in, then app.js; the app is started as the template does, with what changed seen.
  vm.runInContext(scripts[0] + "\n" + scripts[1] + "\n" + scripts[2].replace("const App =", "var App ="), ctx);
  vm.runInContext("var changes = []; App.start(AppsLean.app()); App.onchange((d) => changes.push(JSON.parse(JSON.stringify(d))));", ctx);
  const close = () => void (open = false);
  browsers.push(close);
  return { ctx, posted, storage, close, urls, seen };
}
/** A value from inside the stand-in browser, as plain JSON. */
const value = (ctx: any, expr: string) => JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, ctx));
const settle = (ms = 120) => new Promise((go) => setTimeout(go, ms));

test("the page runtime saves through the stand-in: a change becomes an AnythingLLM event", async () => {
  const html = render({ ...groceries([{ text: "Eggs", done: false }]), secret: "s1" }, "home", "brx-k")!;
  const { ctx, posted, storage, close, urls } = browser(html);
  const saved = await vm.runInContext(`App.patch([{op: "test", path: "/items/0/text", value: "Eggs"}, {op: "replace", path: "/items/0/done", value: true}], {ev: "tick", text: "Eggs"})`, ctx);
  await settle();
  assert.equal(saved, true);
  assert.deepEqual(posted.map((e) => [e.apps_lean_event, e.workspace, e.app, e.ev, e.fields]), [[1, "home", "groceries", "tick", { text: "Eggs" }]]);
  assert.deepEqual([urls[0], posted[0].secret], ["/api/browser-extension/upload-content", "s1"], "posted relative, with the app's secret");
  assert.equal(value(ctx, "App.data.items[0].done"), true);
  assert.deepEqual(JSON.parse(storage.v!).pending.map((e: any) => e.id), [posted[0].id], "kept until the app records it");
  close();
});

test("an open page keeps up from its state file: newer data under its unrecorded changes; recorded ones go", async () => {
  const first = groceries([{ text: "Eggs", done: false }, { text: "Jam", done: false }]);
  let served = JSON.stringify(stateOf(first));
  const { ctx, storage, close } = browser(render(first, "home", "brx-k")!, {
    served: () => served,
    stored: { pending: [{ id: "mine", patch: [{ op: "test", path: "/items/1/text", value: "Jam" }, { op: "replace", path: "/items/1/done", value: true }] }] },
  });
  assert.deepEqual(value(ctx, "App.data.items.map((i) => i.done)"), [false, true], "an unrecorded change shows over the page's data");
  // The agent adds Tea elsewhere, and the skill writes the state file again.
  served = JSON.stringify(stateOf({ ...first, line: 5, data: { items: [...first.data.items, { text: "Tea", done: false }] } }));
  await settle(300);
  assert.deepEqual(value(ctx, "App.data.items.map((i) => [i.text, i.done])"), [["Eggs", false], ["Jam", true], ["Tea", false]]);
  // Then the app records this page's change.
  served = JSON.stringify(stateOf({ ...first, line: 6, seen: ["a", "mine"], data: { items: [{ text: "Eggs", done: false }, { text: "Jam", done: true }, { text: "Tea", done: false }] } }));
  await settle(300);
  assert.deepEqual(JSON.parse(storage.v!).pending, []);
  assert.deepEqual(value(ctx, "App.data.items.map((i) => i.done)"), [false, true, false]);
  close();
});

test("a page whose parts changed reloads, unless the user is typing; a deleted app's page says so", async () => {
  const app = groceries([{ text: "Eggs", done: false }]);
  const newer = () => JSON.stringify({ ...stateOf(app), version: "newer" });
  const idle = browser(render(app, "home", "brx-k")!, { served: newer });
  await settle(200);
  assert.ok(idle.seen.reloads >= 1);
  idle.close();
  const busy = browser(render(app, "home", "brx-k")!, { served: newer, typing: true });
  await settle(200);
  assert.equal(busy.seen.reloads, 0, "not while the user is typing");
  assert.deepEqual(busy.seen.bars, ["This app's page changed.Reload"]);
  busy.close();
  const deleted = browser(render(app, "home", "brx-k")!, { served: () => JSON.stringify({ gone: true }) });
  await settle(200);
  assert.deepEqual(deleted.seen.bars, ["This app was deleted."]);
  deleted.close();
});

test("publishing writes the page's state beside it, and deleting leaves a note that it's gone", async () => {
  await store.create("home", "stated", { ...definitionFor("list", { title: "Stated" }), page: listPage() });
  const token = (await publish(store.read("home", "stated"), "home"))!;
  const state = JSON.parse(fs.readFileSync(path.join(publicDir, "apps-lean", `${token}.json`), "utf8"));
  assert.deepEqual(Object.keys(state).sort(), ["data", "line", "refused", "seen", "version"], "never the secret, the plan or the history");
  unpublish(store.read("home", "stated"));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(publicDir, "apps-lean", `${token}.json`), "utf8")), { gone: true });
});

test("App.log gives the newest changes the page was written with, at once", async () => {
  const app = {
    ...groceries([{ text: "Eggs", done: true }]),
    line: 7,
    history: [
      { n: 6, t: "2026-10-13T12:00:00Z", by: "agent", ev: "add", fields: { text: "Eggs" }, patch: [{ op: "add", path: "/items/-", value: { text: "Eggs", done: false } }], before: { items: [] } },
      { n: 7, t: "2026-10-13T12:01:00Z", by: "page", ev: "tick", fields: { text: "Eggs" }, patch: [{ op: "replace", path: "/items/0/done", value: true }], before: { items: [{ text: "Eggs", done: false }] } },
    ],
  };
  const { ctx } = browser(render(app, "home", "brx-k")!);
  const lines = await vm.runInContext("App.log(6).then((l) => JSON.stringify(l))", ctx);
  assert.deepEqual(JSON.parse(lines), [{ n: 7, t: "2026-10-13T12:01:00Z", by: "page", ev: "tick", text: "Eggs", patch: [{ op: "replace", path: "/items/0/done", value: true }] }]);
  // A page's fields can't say it was the agent's, or at another line.
  (app.history[1] as any).fields = { text: "Eggs", by: "agent", n: 99, ev: "add" };
  const own = browser(render(app, "home", "brx-k")!);
  const [line] = JSON.parse(await vm.runInContext("App.log(6).then((l) => JSON.stringify(l))", own.ctx));
  assert.deepEqual([line.n, line.by, line.ev], [7, "page", "tick"]);
});

test("a change the app refused leaves the page, with why, though the app's line stays", async () => {
  const first = groceries([{ text: "Eggs", done: false }]);
  let served = JSON.stringify(stateOf(first));
  const { ctx, storage, seen, close } = browser(render(first, "home", "brx-k")!, {
    served: () => served,
    stored: { pending: [{ id: "mine", patch: [{ op: "replace", path: "/items/0/done", value: true }] }] },
  });
  assert.deepEqual(value(ctx, "App.data.items.map((i) => i.done)"), [true]);
  served = JSON.stringify(stateOf({ ...first, seen: ["mine"], refused: [{ id: "mine", why: "it breaks the app's schema" }] }));
  await settle(300);
  assert.deepEqual(JSON.parse(storage.v!).pending, []);
  assert.deepEqual(value(ctx, "App.data.items.map((i) => i.done)"), [false]);
  assert.deepEqual(seen.bars, ["A change wasn't saved: it breaks the app's schema"]);
  close();
});

test("the page patches with one engine, and it agrees with the skill's patch.ts", () => {
  const { ctx, close } = browser(render(groceries([]), "home", "brx-k")!);
  const doc = { items: [{ text: "Eggs", done: false }, { text: "Jam", done: true }], meta: { tags: ["a", "b"], "a/b": 1, "m~n": 2 } };
  const cases = [
    [{ op: "add", path: "/items/-", value: { text: "Tea", done: false } }],
    [{ op: "add", path: "/items/0", value: { text: "First", done: false } }],
    [{ op: "replace", path: "/items/1/done", value: false }],
    [{ op: "remove", path: "/items/0" }],
    [{ op: "move", from: "/items/0", path: "/items/1" }],
    [{ op: "copy", from: "/items/0", path: "/items/-" }],
    [{ op: "test", path: "/items/0/text", value: "Eggs" }, { op: "replace", path: "/items/0/done", value: true }],
    [{ op: "test", path: "/items/0", value: { done: false, text: "Eggs" } }],
    [{ op: "replace", path: "/meta/a~1b", value: 5 }, { op: "replace", path: "/meta/m~0n", value: 6 }],
    [{ op: "add", path: "/meta/tags/1", value: "x" }],
    [{ op: "replace", path: "", value: { items: [] } }],
    // Each of these is refused, by both.
    [{ op: "test", path: "/items/0/text", value: "Milk" }],
    [{ op: "remove", path: "/items/2" }],
    [{ op: "remove", path: "/items/01" }],
    [{ op: "add", path: "/items/3", value: 1 }],
    [{ op: "replace", path: "/nope", value: 1 }],
    [{ op: "move", from: "/items", path: "/items/0/inside" }],
    [{ op: "frobnicate", path: "/items" }],
    [{ op: "add", path: "/items/-" }],
    [{ op: "replace", path: "/items/0/done" }],
  ];
  for (const patch of cases) {
    const here = (() => {
      try {
        return { value: apply(doc, patch) };
      } catch {
        return { refused: true };
      }
    })();
    const there = JSON.parse(
      vm.runInContext(`(() => { try { return JSON.stringify({ value: App.apply(${JSON.stringify(doc)}, ${JSON.stringify(patch)}) }); } catch (e) { return JSON.stringify({ refused: true }); } })()`, ctx),
    );
    assert.deepEqual(there, here, JSON.stringify(patch));
  }
  close();
});
