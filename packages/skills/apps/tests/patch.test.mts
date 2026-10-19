import assert from "node:assert/strict";
import { test } from "node:test";
import { apply, get, PatchError } from "../src/patch.ts";

test("add, replace, remove, move, copy and test apply in order to a copy", () => {
  const doc = { items: [{ text: "a", done: false }] };
  const out = apply(doc, [
    { op: "add", path: "/items/-", value: { text: "b", done: false } },
    { op: "test", path: "/items/1/text", value: "b" },
    { op: "replace", path: "/items/1/done", value: true },
    { op: "copy", from: "/items/0", path: "/first" },
    { op: "move", from: "/first", path: "/kept" },
    { op: "remove", path: "/items/0" },
  ]);
  assert.deepEqual(out, { items: [{ text: "b", done: true }], kept: { text: "a", done: false } });
  assert.deepEqual(doc, { items: [{ text: "a", done: false }] });
});

test("a failed test or a missing place throws and names it", () => {
  assert.throws(() => apply({ a: 1 }, [{ op: "test", path: "/a", value: 2 }]), /test \/a: Test operation failed/);
  assert.throws(() => apply({ a: [] }, [{ op: "remove", path: "/a/0" }]), PatchError);
  assert.throws(() => apply({}, [{ op: "replace", path: "/x", value: 1 }]), /replace \/x: .*does not exist/);
  assert.throws(() => apply({}, [{ op: "jump", path: "/x" }]), /not one of operations/);
});

test("pointers unescape ~1 and ~0", () => {
  assert.equal(get({ "a/b": { "c~d": 1 } }, "/a~1b/c~0d"), 1);
});

test("what no patch may do is refused, and the patch itself is left as it was", () => {
  assert.throws(() => apply({ a: 1 }, [{ op: "remove", path: "" }]), /whole document/);
  assert.throws(() => apply({ a: { b: 1 } }, [{ op: "move", from: "/a", path: "/a/c" }]), /into itself/);
  const patch = [{ op: "add", path: "/a", value: { n: [] } }, { op: "add", path: "/a/n/-", value: 1 }];
  assert.deepEqual(apply({}, patch), { a: { n: [1] } });
  assert.deepEqual(patch[0].value, { n: [] }, "a later operation doesn't change an earlier one's value");
});
