import assert from "node:assert/strict";
import { test } from "node:test";
import { SAMPLES } from "./harness.mts";
import { file, HEADER } from "../src/parts.ts";
import { problems, schemaProblems, withDefaults } from "../src/schema.ts";

/** The components static/ holds, by file name. */
const components = (): string[] => Object.keys(STATIC_FILES).filter((f) => f.startsWith("parts/components/")).map((f) => f.slice("parts/components/".length));

test("every starter's data satisfies its schema, which uses known keywords only", () => {
  for (const [name, s] of Object.entries(SAMPLES)) {
    assert.deepEqual(schemaProblems(s.schema), [], name);
    assert.deepEqual(problems(s.data, s.schema), [], name);
  }
});

test("problems name the path and what is wrong", () => {
  const schema = SAMPLES.list.schema;
  assert.deepEqual(problems({ items: [{ text: "", done: "no" }] }, schema), ["/items/0/text: shorter than 1", "/items/0/done: should be boolean, not string"]);
  assert.deepEqual(problems({}, schema), ["/: needs items"]);
  assert.deepEqual(problems(3, { type: "integer", maximum: 2 }), ["/: above 2"]);
  assert.deepEqual(problems(2.5, { type: "integer" }), ["/: should be integer, not number"]);
});

test("an unknown keyword is reported where it is", () => {
  assert.deepEqual(schemaProblems({ type: "object", properties: { a: { oneOf: [] } } }), ["/properties/a/oneOf: not a keyword apps check; use type, properties, required, items, enum, minimum and the like"]);
});

test("an object's keys are counted against minProperties and maxProperties", () => {
  const schema = { type: "object", minProperties: 1, maxProperties: 2 };
  assert.deepEqual(problems({}, schema), ["/: fewer than 1 keys"]);
  assert.deepEqual(problems({ a: 1, b: 2 }, schema), []);
  assert.deepEqual(problems({ a: 1, b: 2, c: 3 }, schema), ["/: more than 2 keys"]);
  assert.deepEqual(schemaProblems(schema), []);
});

test("every schema the components carry is one this checker knows every keyword of", () => {
  for (const name of components()) {
    const head = HEADER.exec(file(`parts/components/${name}`))!;
    const { schema } = JSON.parse(head[1]);
    if (schema) assert.deepEqual(schemaProblems(schema), [], name);
  }
});

test("first data gets a zero for each required key it lacks, where the zero is allowed", () => {
  const schema = { type: "object", required: ["items", "goal", "name"], properties: { goal: { type: "integer", minimum: 1 }, name: { type: "string" },
    items: { type: "array", items: { type: "object", required: ["text", "done"], properties: { text: { type: "string" }, done: { type: "boolean" } } } } } };
  assert.deepEqual(withDefaults({ items: [{ text: "Eggs" }, { text: "Milk", done: true }] }, schema), {
    value: { items: [{ text: "Eggs", done: false }, { text: "Milk", done: true }] }, filled: ["items/[]/done"] });
  assert.deepEqual(withDefaults({}, schema), { value: { items: [] }, filled: ["items"] }, "a string, and a number whose zero breaks its minimum, stay for the schema check");
});

test("uniqueItems compares values, not their text: key order is no difference, and a string is not the list it spells", () => {
  const unique = { type: "array", uniqueItems: true };
  assert.deepEqual(problems([1, 2, 3], unique), []);
  assert.equal(problems([1, 2, 1], unique).length, 1);
  assert.equal(problems([{ a: 1, b: 2 }, { b: 2, a: 1 }], unique).length, 1);
  assert.deepEqual(problems([{ a: 1 }, { a: 2 }], unique), []);
  assert.deepEqual(problems(["[1]", [1]], unique), []);
  assert.deepEqual(problems([1, "1"], unique), []);
});

test("a keyword whose value the check can't use is said, at any depth", () => {
  assert.deepEqual(
    schemaProblems({ type: "object", required: "items", properties: { a: { type: 3, pattern: "(" }, b: { type: "array", items: { minItems: "2", enum: 1 } } } }),
    ["/required: a list of key names", "/properties/a/type: a type's name, or a list of them", "/properties/a/pattern: a regular expression that compiles", "/properties/b/items/minItems: a number", "/properties/b/items/enum: a list of the values allowed"],
  );
  assert.deepEqual(schemaProblems({ type: ["string", "null"], pattern: "^a", required: [], enum: [1], minimum: 0 }), []);
});
