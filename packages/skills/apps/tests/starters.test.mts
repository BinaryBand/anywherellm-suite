import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { call } from "./harness.mts";
import { clone } from "../src/patch.ts";
import * as parts from "../src/parts.ts";
import { problems } from "../src/schema.ts";
import * as store from "../src/store.ts";

const names = Object.keys(parts.starters());

test("list names every starter, and no starter shares a part's name", async () => {
  const answer = await call("home", { action: "list" });
  const listed = answer.match(/starter fits \(([^)]*)\)/)![1].split(", ");
  assert.deepEqual(listed, names);
  assert.deepEqual(names.filter((n) => parts.parts()[n]), []);
  const aliases: string[] = names.flatMap((n) => parts.starters()[n].aliases || []);
  assert.deepEqual(aliases.filter((a) => parts.parts()[a] || names.includes(a)), [], "an alias names no part or other starter");
  assert.equal(new Set(aliases).size, aliases.length, "each alias once");
});

for (const name of names) {
  test(`the ${name} starter is a page apps take, with data its schema accepts`, async () => {
    const s = parts.starter(name)!;
    assert.deepEqual(await parts.pageProblems(s.page), []);
    assert.ok(s.definition.schema.required.length, "the components ask for keys");
    assert.deepEqual(problems(s.data, s.definition.schema), []);
    assert.equal((await store.create("home", name, { ...s.definition, data: s.data, page: s.page }, undefined)).name, name, "the store takes it whole");
    // A group's components share its list's items; the page's own share the top.
    const keysOf = (names: string[]) => names.flatMap((p) => Object.keys(parts.parts()[p].header.schema?.properties || {}));
    for (const names of [s.parts.filter((e): e is string => typeof e === "string"), ...s.parts.filter((e) => typeof e !== "string").map((g) => g.parts)]) {
      const keys = keysOf(names);
      assert.equal(new Set(keys).size, keys.length, "no two parts keep the same key");
    }
  });
}

test("an open focus timer ends a countdown that's over once, and logs it with what the note says", () => {
  const script = parts.starters()["focus-timer"].script;
  const patches: any[] = [];
  const ticks: (() => void)[] = [];
  const started = new Date(Date.now() - 26 * 6e4).toISOString();
  const App: any = { data: { minutes: 25, started, entries: [] } };
  App.patch = (ops: unknown, event: unknown) => {
    patches.push(clone([ops, event]));
    App.data.started = null;
  };
  const note = { value: " Chapter 3 " };
  const document = { querySelector: (sel: string) => (sel === "[data-part=entry-form] [data-ref=text]" ? note : null) };
  vm.runInNewContext(script, { App, Date, document, setInterval: (fn: () => void) => ticks.push(fn) });
  ticks[0]();
  ticks[0]();
  assert.equal(patches.length, 1);
  const [ops, event] = patches[0];
  assert.deepEqual(event, { ev: "done", text: "Chapter 3" });
  assert.deepEqual(ops[0], { op: "test", path: "/started", value: started }, "guarded, so a run another tab ended isn't ended twice");
  assert.deepEqual(ops[2].value, { text: "Chapter 3", at: new Date(Date.parse(started) + 25 * 6e4).toISOString() });
  assert.equal(note.value, "");
});

test("a name that is an object's own property is no starter", async () => {
  for (const name of ["constructor", "toString", "__proto__"]) {
    assert.equal(parts.starterNamed(name), undefined);
    assert.match(await call("home", { action: "create", name: "plain", starter: name }), /starter must be one of: /);
  }
});
