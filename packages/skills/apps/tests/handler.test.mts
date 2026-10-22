import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { call, from, handler, inWorkspace, PLAN, publicDir, SAMPLES } from "./harness.mts";
import * as store from "../src/store.ts";

/** app.json for a list, as the agent writes it after reading the item-list part. */
const LIST = (() => { const { data, title, ...json } = SAMPLES.list; return JSON.stringify(json); })();
const make = (slug: string, name: string, title: string, data: unknown = { items: [] }) => call(slug, { action: "create", plan: PLAN, name, title, template: "column", text: LIST, data });

test("the agent creates an app from a template, changes it and shows it, with its card", async () => {
  assert.match(await call("home", { action: "list" }), /^This workspace has no apps yet\.\n\nTo make one: if a starter fits \(checklist, journal/);
  assert.match(await make("home", "groceries", "Groceries"), /^Made the app groceries: Groceries, from the column template, which holds no components yet: put each one's markup at <!--slot-->/);
  const patch = JSON.stringify([{ op: "add", path: "/items/-", value: { text: "Eggs", done: false } }]);
  assert.match(await call("home", { action: "do", name: "groceries", ev: "add", patch }), /Done: add on groceries\.\n\nPut the card below in your reply exactly as given, with no label or heading\.\n\| \| \*\*\[Groceries\]\(\/apps-lean\/[\w-]+\.html\)\*\* · 1 of 1 left \|\n\|---\|---\|\n\| ☐ \| Eggs \|/);
  assert.match(await call("home", { action: "read", name: "groceries" }), /Data: \{"items":\[\{"text":"Eggs","done":false\}\]\}/);
  assert.match(await call("home", { action: "list" }), /^This workspace's apps \(change one that fits rather than making another\):\n- groceries: \*\*\[Groceries\]\(\/apps-lean\/[\w-]+\.html\)\*\* · 1 of 1 left\n\nTo make one: /);
  assert.match(await call("home", { action: "undo", name: "groceries" }), /Took back add/);
});

test("app.json and page.html are read, written and edited", async () => {
  const json = await call("home", { action: "read", name: "groceries", file: "app.json" });
  assert.match(json, /^groceries's app\.json[^\n]*\n\{\n  "title": "Groceries"/);
  const page = await call("home", { action: "read", name: "groceries", file: "page.html" });
  assert.match(page, /<!--slot-->/);
  assert.match(await call("home", { action: "edit", name: "groceries", file: "page.html", find: "--accent-h:272", text: "--accent-h:140" }), /^Changed groceries's page\.html\./);
  assert.match(await call("home", { action: "read", name: "groceries", file: "page.html" }), /--accent-h:140/);
  assert.match(await call("home", { action: "edit", name: "groceries", file: "page.html", text: "<p>bare</p>" }), /^Apps: the app can't be saved:\n- page\.html must load the runtime/, "edit with no find writes the whole file");
  assert.match(await call("home", { action: "read", name: "groceries", file: "icon.svg" }), /^Apps: file is app\.json or page\.html/);
});

test("the guide is this edition's notes, then the parts and design rules; topics give one part", async () => {
  const bare = await call("home", { action: "guide" });
  assert.match(bare, /^# Apps \(lean\)/);
  assert.match(bare, /Templates, for create:\ncolumn - lists, logs, notes; the default/);
  assert.match(bare, /Making a page:/);
  assert.match(await call("home", { action: "guide", query: "item-list" }), /^== item-list ==\n<!--part\n\{"name":"item-list"[\s\S]*\n== runtime ==\n/);
  assert.match(await call("home", { action: "guide", query: "finish" }), /Before showing the app/);
  assert.match(await call("home", { action: "guide", query: "nope" }), /^No topic is named in "nope"; ask for a topic by its name, several at once\. The index:\nStarters/);
  const runtime = await call("home", { action: "guide", query: "runtime" });
  assert.match(runtime, /^app\.js: an app page's way to its data/);
  assert.match(runtime, /App\.patch\(ops, event\)/);
  assert.match(runtime, /In this edition \(apps-lean\)/);
  assert.match(await call("home", { action: "guide", query: "check" }), /^This edition has no browser check/);
  assert.match(await call("home", { action: "guide", query: "styles" }), /^\/\* app\.css: every app page's styles/);
  assert.match(await call("home", { action: "read", name: "groceries", file: "app.js" }), /^Apps: app\.js isn't one of the app's files[^\n]*guide runtime/);
});

test("another workspace sees none of them, and mistakes come back as words", async () => {
  assert.match(await call("work", { action: "list" }), /^This workspace has no apps yet\./);
  assert.match(await call("work", { action: "read", name: "groceries" }), /^Apps: this workspace has no app named groceries/);
  assert.match(await call("home", { action: "do", name: "groceries", patch: "not json" }), /^Apps: patch must be JSON/);
  assert.match(await call("home", { action: "fly" }), /^Apps: action is one of/);
  assert.match(await call("home", { action: "create", plan: PLAN, name: "x", template: "zoo", text: LIST, data: { items: [] } }), /^Apps: the app can't be made:\n- template must be one of: column, dashboard[^\n]*; or give starter, one of: checklist/);
  assert.match(await call("home", { action: "create", plan: PLAN, name: "x", text: JSON.stringify({ about: "x", nope: 1 }) }), /^Apps: the app can't be made:\n- app\.json holds title, about/);
});

test("delete takes the app out at once, whatever chat it comes from", async () => {
  await make("home", "temp", "List");
  assert.match(await call("home", { action: "delete", name: "temp" }), /^Deleted the app temp, its changes and its page\. It stays in the trash 30 days/);
  assert.equal((await call("home", { action: "list" })).includes("- temp:"), false);
});

test("page gives the page's link, relative until AnythingLLM's address is set", async () => {
  const page = await call("home", { action: "page", name: "groceries" });
  assert.match(page, /^Groceries's page is at \/apps-lean\/[\w-]+\.html\. [^\n]*the user sets AnythingLLM's address in Agent Skills, under Apps, as ANYTHINGLLM_URL\./, "a relative link, and how to get one for a phone");
  assert.doesNotMatch(await call("home", { action: "page", name: "groceries" }, { ANYTHINGLLM_URL: "http://x:3001" }), /ANYTHINGLLM_URL/);
});

test("a starter makes a working app and page in one call, with the user's data over its own", async () => {
  const reply = await call("home", { action: "create", name: "focus", title: "Focus", starter: "focus-timer", data: { minutes: 50 } });
  assert.match(reply, /^Made the app focus: Focus, from the focus-timer starter: the focus template with timer, entry-form, working as it is\. It's ready: give the user the card/);
  assert.match(reply, /\napp\.json:\n\{\n  "title": "Focus"/);
  assert.doesNotMatch(reply, /page\.html:|<!doctype html>|Before showing the app/, "a starter is finished as made: no page to rewrite, no checks to make");
  assert.match(reply, /\*\*\[Focus\]\(\/apps-lean\/[\w-]+\.html\)\*\* · 50-minute timer · 0 sessions/);
  const shown = await call("home", { action: "read", name: "focus" });
  assert.match(shown, /Data: \{"minutes":50,"started":null,"entries":\[\]\}/);
  // A starter named as a template is taken as the starter.
  assert.match(await call("home", { action: "create", name: "deck", template: "flashcards", data: { cards: [{ front: "tack", back: "thanks", seen: 0, right: 0 }] } }), /^Made the app deck: Flashcards, from the flashcards starter/);
  assert.match(await call("home", { action: "create", name: "y", starter: "pomodoro" }), /^Made the app y: Focus timer, from the focus-timer starter/, "a starter answers to its aliases");
  assert.match(await call("home", { action: "create", name: "z", template: "habit" }), /^Made the app z: Habits, from the habits starter/);
  assert.match(await call("home", { action: "create", name: "w", starter: "zeppelin" }), /^Apps: the app can't be made:\n- starter must be one of: checklist, journal, tracker, habits, focus-timer, flashcards, explainer/);
});

test("a refused create lists every problem at once", async () => {
  const text = JSON.stringify({ about: 3, rules: [], schema: { type: "object", properties: { n: { type: "integer" } } }, card: { nope: 1 }, extra: true });
  const reply = await call("home", { action: "create", plan: PLAN, name: "Bad Name", template: "zoo", text, data: { n: "one" } });
  const problems = reply.split("\n- ").slice(1);
  assert.deepEqual(problems.map((p: string) => p.split(":")[0].split(" ")[0]), ["app.json", "template", "an", "about", "card.nope", "data"]);
});

test("a refused write of app.json lists every problem at once, the data's too", async () => {
  await make("home", "listed", "Listed", { items: [{ text: "Eggs", done: false }] });
  const json = { title: "Listed", rules: [], schema: { type: "object", properties: { items: { type: "string" } } }, card: { bad: 1 }, data: {} };
  const reply = await call("home", { action: "edit", name: "listed", file: "app.json", text: JSON.stringify(json) });
  assert.match(reply, /^Apps: the app can't be saved:\n- app\.json holds [^\n]*not data\n- card\.bad: not a card key[^\n]*\n- data \/items: should be string, not array$/);
});

test("guide gives several topics in one answer, with the runtime after a component", async () => {
  const both = await call("home", { action: "guide", query: "timer, entry-form" });
  assert.deepEqual([...both.matchAll(/^== (\S+) ==$/gm)].map((m) => m[1]), ["timer", "entry-form", "runtime"]);
  assert.match(await call("home", { action: "guide", query: "item-list runtime" }), /^== item-list ==[\s\S]*== runtime ==[\s\S]*In this edition/);
  assert.equal((await call("home", { action: "guide", query: "runtime, timer" })).match(/In this edition/g)!.length, 1, "the runtime once");
  assert.equal((await call("home", { action: "guide", query: "runtime app.js" })).match(/In this edition/g)!.length, 1, "a library by its file name is its topic");
  assert.match(await call("home", { action: "guide", query: "counter, nope" }), /\nNo topic "nope": runtime, styles/);
  assert.match(await call("home", { action: "guide", query: "icons" }), /^This edition has no icon set: leave icon out of app\.json\./);
  assert.match(await call("home", { action: "guide", query: "focus-timer" }), /^focus-timer starter: [^\n]*\ncreate with \{"action": "create"[^\n]*"starter": "focus-timer"\}/);
  assert.match(await call("home", { action: "guide" }), /Starters, for create with starter[^\n]*\nchecklist - /);
});

test("undo takes back the newest change, to a file or the data, and read lists the earlier files", async () => {
  await make("home", "pages", "Pages");
  await call("home", { action: "do", name: "pages", ev: "add", patch: [{ op: "add", path: "/items/-", value: { text: "Eggs", done: false } }] });
  await call("home", { action: "edit", name: "pages", file: "page.html", find: "--accent-h:272", text: "--accent-h:140" });
  assert.match(await call("home", { action: "read", name: "pages" }), /\nEarlier files \(undo with file takes back the newest change to one\):\n- \S+ page\.html\n/);
  assert.doesNotMatch(await call("home", { action: "read", name: "pages" }), /<!doctype/, "read without file leaves the page out");
  assert.match(await call("home", { action: "undo", name: "pages" }), /^Put back pages's page\.html as it was before its change at \S+\./);
  assert.match(await call("home", { action: "read", name: "pages", file: "page.html" }), /--accent-h:272/);
  assert.match(await call("home", { action: "undo", name: "pages" }), /^Took back add/, "then the data's change");
  assert.match(await call("home", { action: "undo", name: "pages", file: "app.json" }), /^Apps: [^\n]*no change to app\.json left to take back/);
});

test("create composes any components into a template, with their schemas merged and their first data", async () => {
  const reply = await call("home", { action: "create", plan: PLAN, name: "water", title: "Water", template: "dashboard", parts: ["counter", "date-grid"], data: { target: 6 } });
  assert.match(reply, /^Made the app water: Water, from the dashboard template with counter, date-grid: composed, their schemas merged and their first data in\./);
  assert.match(reply, /data-part="counter"[\s\S]*data-part="date-grid"/);
  assert.match(await call("home", { action: "read", name: "water" }), /"required":\["count","target","days"\][\s\S]*Data: \{"count":3,"target":6,"days":\{\}\}/);
  // Named as text too, as a model may send them, and text adds what the parts don't give.
  const text = JSON.stringify({ about: "Glasses today.", card: { summary: "{/count} of {/target}" } });
  assert.match(await call("home", { action: "create", plan: PLAN, name: "tea", template: "column", parts: "counter, date-grid", text }), /\*\*\[tea\]\(\/apps-lean\/[\w-]+\.html\)\*\* · 3 of 8/);
  const refused = await call("home", { action: "create", plan: PLAN, name: "odd", template: "zoo", parts: ["timer", "nope", "timer", "fanout"] });
  assert.deepEqual(refused.split("\n- ").slice(1).map((p: string) => p.split(" ").slice(0, 3).join(" ")), ["template must be", "parts are components,", "a page holds", "schema: a JSON"]);
  assert.match(refused, /not nope, fanout\n- a page holds each component once, not timer twice/);
});

test("a group of components repeats for each item of a list, named, its schema the items'", async () => {
  const parts = [{ each: "habits", parts: ["counter", "date-grid"] }, "stat"];
  const reply = await call("home", { action: "create", plan: PLAN, name: "daily", title: "Daily", template: "column", parts, data: { items: [], habits: [{ name: "Water", count: 0, target: 8, days: {} }] } });
  assert.match(reply, /from the column template with counter and date-grid for each of habits, stat: composed/);
  assert.match(reply, /<div class="stack" data-each="\/habits"><template>\n<section class="stack">\n<h2 data-text="name"><\/h2>\n<div class="card stack center" data-part="counter">/);
  assert.equal(reply.match(/App\.mount\("counter"/g)!.length, 1);
  const json = JSON.parse((await call("home", { action: "read", name: "daily", file: "app.json" })).split("\n").slice(1).join("\n"));
  assert.deepEqual(json.schema.properties.habits.items.required, ["name", "count", "target", "days"]);
  assert.match(await call("home", { action: "do", name: "daily", ev: "step", patch: [{ op: "replace", path: "/habits/0/count", value: 9 }] }), /^Done: step/);
  assert.match(await call("home", { action: "do", name: "daily", patch: [{ op: "add", path: "/habits/-", value: { name: "Read" } }] }), /needs count/);
  const refused = await call("home", { action: "create", plan: PLAN, name: "odd2", template: "column", parts: [{ each: "Bad list", parts: ["timer", "counter", "counter"] }] });
  assert.match(refused, /each Bad list item holds each component once, not counter twice\n- each names a list in the data, such as habits, not "Bad list"\n- timer can't repeat for each item/);
  assert.match(await call("home", { action: "create", name: "my-habits", starter: "habit", data: { habits: [{ name: "Water", count: 0, target: 8, days: {} }] } }), /^Made the app my-habits: Habits, from the habits starter: the column template with counter and date-grid for each of habits/);
});

test("an edit that leaves a script unparsed or a part with no mount is refused, the page kept", async () => {
  await call("home", { action: "create", name: "kept-habits", starter: "habits" });
  const reply = await call("home", { action: "edit", name: "kept-habits", file: "page.html", find: 'App.mount("counter", ({ at, q }) => {', text: "" });
  assert.match(reply, /^Apps: the app can't be saved:\n- page\.html's script 2 of 3 doesn't parse: Illegal return statement at: return \(\) => \{\n- page\.html holds data-part counter with no App\.mount script for it$/);
  assert.match(await call("home", { action: "read", name: "kept-habits", file: "page.html" }), /App\.mount\("counter"/);
});

// From driving the skill through AnythingLLM's own agent: what a model sends on its first try.
test("create takes what a model sends first: no name, a starter meaning none, items missing a tick", async () => {
  assert.match(await call("first", { action: "create", starter: "journal", title: "Gratitude Journal" }), /^Made the app gratitude-journal: Gratitude Journal, from the journal starter/);
  assert.match(await call("first", { action: "create", starter: "journal", title: "Gratitude Journal" }), /^Made the app gratitude-journal-2:/, "a name the workspace has gets a number");
  const items = JSON.stringify({ items: [{ text: "Passport" }, { text: "Charger" }] });
  const made = await call("first", { action: "create", name: "packing", starter: "list", title: "Packing", data: items });
  assert.match(made, /^Made the app packing[\s\S]*\nFilled in what the data left out: items\/\[\]\/done, with false, 0 or \[\]\./);
  assert.match(made, /\| ☐ \| Passport \|\n\| ☐ \| Charger \|/);
  const cards = JSON.stringify({ cards: [{ front: "att vara", back: "to be" }] });
  assert.match(await call("first", { action: "create", name: "verbs", starter: "flashcards", data: cards }), /left out: cards\/\[\]\/seen, cards\/\[\]\/right/);
  assert.match(await call("first", { action: "create", plan: PLAN, name: "tip", starter: "blank", template: "column", parts: ["stat"] }), /^Made the app tip: tip, from the column template with stat/);
});

test("guide asked in a sentence answers with the index, and a starter's alias names its topic", async () => {
  assert.match(await call("home", { action: "guide", query: "plant care with due dates" }), /^No topic is named in "plant care with due dates"; ask for a topic by its name, several at once\. The index:\nStarters, for create/);
  assert.match(await call("home", { action: "guide", query: "list" }), /^checklist starter: /);
});

test("a page that looks up an element by id through q, or calls a function no script declares, is refused", async () => {
  await call("home", { action: "create", name: "lookups", starter: "checklist" });
  const byId = await call("home", { action: "edit", name: "lookups", file: "page.html", find: "<!--scripts-->", text: '<script>App.mount("item-list", ({ q }) => () => q("cats").replaceChildren());</script>\n<!--scripts-->' });
  assert.match(byId, /q\("cats"\), but no element has data-ref="cats": q finds an element by its data-ref, never its id/);
  const undeclared = await call("home", { action: "edit", name: "lookups", file: "page.html", find: "<!--scripts-->", text: "<script>App.onchange(draw);\ndraw();</script>\n<!--scripts-->" });
  assert.match(undeclared, /page\.html uses draw, which no script declares \(script \d+, line 1\): the page stops there/);
  const browser = await call("home", { action: "edit", name: "lookups", file: "page.html", find: "<!--scripts-->", text: '<script>new IntersectionObserver(() => {}); requestAnimationFrame(() => {}); localStorage.getItem("k");</script>\n<!--scripts-->' });
  assert.match(browser, /^Changed lookups's page\.html\./, "the browser's own globals are not undeclared");
});

test("a page with colours of its own is kept, with advice, unless a rule keeps the user's choice", async () => {
  await call("home", { action: "create", name: "board", starter: "checklist" });
  const white = await call("home", { action: "edit", name: "board", file: "page.html", find: "</style>", text: ".card{background:#fff;border-color:var(--line, #ddd)}</style>" });
  assert.match(white, /^Changed board's page\.html\.\npage\.html sets colours of its own \(#fff\), which one of the light and dark themes won't read/);
  await call("home", { action: "edit", name: "board", file: "app.json", find: '"rules": [', text: '"rules": ["[accent] The cards are white: the user asked.", ' });
  assert.doesNotMatch(await call("home", { action: "read", name: "board", file: "page.html" }), /^$/);
  assert.match(await call("home", { action: "edit", name: "board", file: "page.html", find: "#fff", text: "#fefefe" }), /^Changed board's page\.html\.\n\nPut the card/);
});

test("create takes list items sent as bare text, and one rule as a sentence", async () => {
  const made = await call("second", { action: "create", name: "packing", starter: "checklist", data: JSON.stringify({ items: ["Passport", "Charger"] }) });
  assert.match(made, /left out: items\/\[\] as \{text\}, items\/\[\]\/done/);
  assert.match(made, /\| ☐ \| Passport \|\n\| ☐ \| Charger \|/);
  const text = JSON.stringify({ about: "A tip.", rules: "Round up.", schema: { type: "object" }, card: {} });
  assert.match(await call("second", { action: "create", plan: PLAN, name: "tip", template: "column", text }), /^Made the app tip/);
  assert.match(await call("second", { action: "read", name: "tip", file: "app.json" }), /"rules": \[\n\s+"Round up\."\n\s+\]/);
});

test("a card that reads something other than a pointer is refused in words, never a crash", async () => {
  await call("second", { action: "create", name: "budget", starter: "journal" });
  const reply = await call("second", { action: "edit", name: "budget", file: "app.json", find: '"card": {', text: '"card": {"lines": "{/expenses/category} total {sum of amounts}", ' });
  assert.match(reply, /^Apps: the app can't be saved:\n- card\.lines: \{sum of amounts\} is not a pointer into the data/);
});

test("create without a starter needs a plan, which the app keeps and read shows", async () => {
  const text = JSON.stringify({ about: "A list.", rules: [], schema: { type: "object" }, card: {} });
  const bare = { action: "create", name: "planless", template: "column", text, data: {} };
  const refused = await call("plans", bare);
  assert.match(refused, /^Apps: the app can't be made:\n- plan: 40-600 characters on how you'll build this, covering what the app keeps; data it needs from outside[^\n]*web skills[^\n]*nothing runs while the page is closed[^\n]*more than one device[^\n]*no browser check/);
  for (const plan of ["Too short.", "x".repeat(601)]) assert.match(await call("plans", { ...bare, plan }), /^Apps: the app can't be made:\n- plan: 40-600/);
  assert.match(await call("plans", { ...bare, template: "zoo", plan: PLAN }), /\n- template must be one of[^\n]*$/, "a plan does not hide the other problems");
  const both = await call("plans", { ...bare, template: "zoo" });
  assert.match(both, /- template must be one of[^\n]*\n- plan: 40-600/, "the other problems and the plan come back in one answer");
  assert.match(await call("plans", { action: "read", name: "planless" }), /no app named planless/, "a refused create makes nothing");

  assert.match(await call("plans", { ...bare, plan: `  ${PLAN}  ` }), /^Made the app planless/);
  const plan = `Plan: ${PLAN}`;
  assert.ok((await call("plans", { action: "read", name: "planless" })).includes(`\n${plan}\n`), "read shows the plan, trimmed");
  await call("plans", { action: "edit", name: "planless", file: "page.html", text: "<!doctype html><title>x</title>" });
  await call("plans", { action: "edit", name: "planless", file: "app.json", find: '"about": "A list."', text: '"about": "A longer list."' });
  await call("plans", { action: "undo", name: "planless" });
  assert.ok((await call("plans", { action: "read", name: "planless" })).includes(`\n${plan}\n`), "edit and undo keep the plan");
  assert.doesNotMatch(await call("plans", { action: "read", name: "planless", file: "app.json" }), /"plan"/, "the plan is not part of app.json");
  assert.match(await call("plans", { action: "create", name: "inside", template: "column", plan: PLAN, text: JSON.stringify({ about: "x", plan: PLAN }) }), /app\.json holds title, about[^\n]*not [^\n]*plan/);
});

test("a starter needs no plan, and its alias or a starter-named template none either", async () => {
  assert.match(await call("plans", { action: "create", name: "s1", starter: "checklist" }), /^Made the app s1/);
  assert.match(await call("plans", { action: "create", name: "s2", starter: "pomodoro" }), /^Made the app s2/);
  assert.match(await call("plans", { action: "create", name: "s3", template: "habit" }), /^Made the app s3/);
  assert.doesNotMatch(await call("plans", { action: "read", name: "s1" }), /\nPlan: /);
  assert.match(await call("plans", { action: "create", name: "s5", starter: "checklist", plan: PLAN }), /^Made the app s5/);
  assert.ok((await call("plans", { action: "read", name: "s5" })).includes(`\nPlan: ${PLAN}\n`), "a plan sent with a starter is kept too");
  assert.match(await call("plans", { action: "create", name: "s6", starter: "checklist", plan: "x".repeat(900) }), /^Made the app s6/, "a long plan with a starter is cut, not refused");
  assert.match(await call("plans", { action: "create", name: "s4", starter: "blank", template: "column", parts: ["stat"] }), /^Apps: the app can't be made:\n- plan: 40-600/, "blank means no starter, so a plan");
});

test("a card's title links to the app's page: under AnythingLLM's address when it's set, else relative", async () => {
  const self = { ...inWorkspace("links"), runtimeArgs: { ANYTHINGLLM_URL: "http://x:3001/" } };
  await call("links", { action: "create", name: "linked", title: "Linked", starter: "checklist" });
  await store.mark("links", "linked", { pageToken: "tok" });
  const link = "**[Linked](http://x:3001/apps-lean/tok.html)**";
  const read = await handler().call(self, { action: "read", name: "linked" });
  assert.ok(read.includes(`exactly as given, with no label or heading.\n${link}`), read);
  assert.ok((await handler().call(self, { action: "list" })).includes(`- linked: ${link}`), "list links too");
  assert.ok((await handler().call(self, { action: "do", name: "linked", ev: "add", patch: JSON.stringify([{ op: "add", path: "/items/-", value: { text: "Eggs", done: false } }]) })).includes(`| | ${link} · 1 of 1 left |`));
  assert.match(await call("links", { action: "read", name: "linked" }), /\*\*\[Linked\]\(\/apps-lean\/tok\.html\)\*\*/, "relative without the address, which AnythingLLM's own chat opens");
});

test("the old names show, write, revert and open are gone, and the actions are listed", async () => {
  for (const action of ["show", "write", "revert", "open"]) assert.match(await call("home", { action, name: "groceries" }), /^Apps: action is one of list, create, do, read, page, undo, edit, delete, guide$/, action);
});

test("every page a call touches is written, and they share one key for pages", async () => {
  const base = { ANYTHINGLLM_URL: "http://x:3001" };
  for (const name of ["one", "two"]) {
    await call("keys", { action: "create", name, title: name, starter: "checklist" });
    await store.mark("keys", name, { pageToken: `tok-${name}` });
  }
  from("keys", "two", { id: "e1", ev: "add", patch: [{ op: "add", path: "/items/-", value: { text: "Jam", done: false } }] });
  const patch = JSON.stringify([{ op: "add", path: "/items/-", value: { text: "Eggs", done: false } }]);
  await call("keys", { action: "do", name: "one", ev: "add", patch }, base);
  const page = (name: string) => fs.readFileSync(path.join(publicDir, "apps-lean", `tok-${name}.html`), "utf8");
  assert.match(page("one"), /"text":"Eggs"/);
  assert.match(page("two"), /"text":"Jam"/, "an app changed by its page is written again too");
  const keyOf = (name: string) => /"key":"([^"]+)"/.exec(page(name))![1];
  assert.equal(keyOf("one"), keyOf("two"), "one key for every page");
});

test("a parameter given as null is one left out", async () => {
  await make("home", "nulls", "Nulls");
  assert.match(await call("home", { action: "do", name: "nulls", ev: "add", patch: [{ op: "add", path: "/items/-", value: { text: "Eggs", done: false } }], workspace: null }), /^Done: add on nulls\./);
  assert.match(await call("home", { action: "undo", name: "nulls", file: null }), /^Took back add/);
});
