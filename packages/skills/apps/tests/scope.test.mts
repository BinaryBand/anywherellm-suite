import assert from "node:assert/strict";
import { test } from "node:test";
import { scopeOf } from "../src/scope.ts";

const invoked = (invocation: Record<string, unknown>) => ({ super: { handlerProps: { invocation } } });

test("a call's workspace comes from AnythingLLM's invocation", () => {
  assert.deepEqual(scopeOf(invoked({ workspace: { slug: "home" } })), { workspace: "home", job: false });
  assert.deepEqual(scopeOf({}), { workspace: "_jobs", job: true }, "a scheduled job has no workspace");
});
