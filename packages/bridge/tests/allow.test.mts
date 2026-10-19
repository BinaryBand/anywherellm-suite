import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { absentRules, defaultList, parseRules, route, show } from "../src/allow.mts";

// The default list the parts agree on (contract/default-allow.txt).
const DEFAULT_FILE = fs.readFileSync(fileURLToPath(new URL("../../../contract/default-allow.txt", import.meta.url)), "utf8");
const CLIENT_ALLOW = defaultList(DEFAULT_FILE);

const passes = (allow: string, method: string, path: string, query = ""): string => route(parseRules(allow), method, path, query);

test("a rule is a method and a path prefix", () => {
  assert.deepEqual(parseRules("GET /scheduled-jobs, /workspaces ,post /system/custom-models,").map(show), [
    "GET /scheduled-jobs",
    "/workspaces",
    "POST /system/custom-models",
  ]);
  assert.deepEqual(parseRules(""), []);
});

test("a bad rule is refused by name", () => {
  for (const text of ["scheduled-jobs", "/", "FETCH /x", "GET", "GET /a/../b", "GET //"]) {
    assert.throws(() => parseRules(text), /BRIDGE_ALLOW/, text);
  }
});

test("a prefix matches whole segments and the method", () => {
  assert.equal(passes("GET /workspaces", "GET", "workspaces/home/memories"), "/workspaces/home/memories");
  for (const [method, path] of [["GET", "workspaces-old"], ["GET", "workspace"], ["POST", "workspaces"]]) {
    assert.throws(() => passes("GET /workspaces", method, path), { status: 403 }, `${method} ${path}`);
  }
});

test("a rule with no method allows each of the four", () => {
  for (const method of ["GET", "POST", "PUT", "DELETE"]) assert.equal(passes("/memories", method, "memories/3"), "/memories/3");
  assert.throws(() => passes("/memories", "PATCH", "memories/3"), { status: 403 });
});

test("the client routes pass what AnywhereLLM Lite calls and no more", () => {
  const allowed = [
    ["GET", "workspaces/home/memories"], ["POST", "workspaces/home/memories"], ["PUT", "memories/3"], ["DELETE", "memories/3"],
    ["POST", "memories/3/promote"], ["POST", "memories/3/demote/home"], ["GET", "admin/system-preferences-for"],
    ["POST", "admin/system-preferences"], ["GET", "scheduled-jobs"], ["GET", "scheduled-jobs/1/runs"], ["POST", "scheduled-jobs/new"],
    ["PUT", "scheduled-jobs/1"], ["DELETE", "scheduled-jobs/1"], ["POST", "scheduled-jobs/1/trigger"], ["GET", "workspaces"],
    ["GET", "workspace/home/threads"], ["GET", "workspace/home/thread/abc/chats"], ["POST", "workspace/home/thread/new"],
    ["POST", "workspace/home/thread/abc/update"], ["DELETE", "workspace/home/thread/abc"],
    ["DELETE", "workspace/home/thread/abc/delete-edited-chats"],
  ];
  for (const [method, path] of allowed) assert.doesNotThrow(() => passes(CLIENT_ALLOW, method, path), `${method} ${path}`);
  const refused = [
    ["GET", "system/api-keys"], ["POST", "system/update-env"], ["POST", "admin/system-preferences-for"], ["GET", "admin/users"],
    ["DELETE", "workspace/home"], ["POST", "workspace/home/update"], ["POST", "workspace/home/reset-vector-db"],
    ["DELETE", "workspace/home/delete-chats"], ["DELETE", "workspace/home/thread-bulk-delete"], ["POST", "workspace/home/stream-chat"],
    ["POST", "workspace/home/thread/abc/stream-chat"], ["GET", "workspace/home/thread/abc"],
  ];
  for (const [method, path] of refused) assert.throws(() => passes(CLIENT_ALLOW, method, path), { status: 403 }, `${method} ${path}`);
});

test("nothing passes without a rule", () => {
  assert.throws(() => passes("", "GET", "scheduled-jobs"), { status: 403 });
});

test("a path cannot climb out of its prefix", () => {
  for (const path of ["workspaces/../system/api-keys", "workspaces/./x", "workspaces//x", "workspaces\\x", ""]) {
    assert.throws(() => passes("/workspaces", "GET", path), { status: 400 }, JSON.stringify(path));
  }
});

test("the path goes upstream requoted, with its query", () => {
  assert.equal(passes("/workspaces", "POST", "workspaces/a?b/c", "x=1&y=%20"), "/workspaces/a%3Fb/c?x=1&y=%20");
  assert.equal(passes("/x", "GET", "x/it's(1)*!"), "/x/it%27s%281%29%2A%21"); // `!'()*` are encoded too
});

test("a query with control characters is refused", () => {
  assert.throws(() => passes("/x", "GET", "x", "a=1\r\nHost: y"), { status: 400 });
});

test("a star segment matches one segment and nothing else", () => {
  const rule = "POST /workspace/*/thread/*/update";
  assert.doesNotThrow(() => passes(rule, "POST", "workspace/home/thread/abc/update"));
  assert.doesNotThrow(() => passes(rule, "POST", "workspace/*/thread/*/update")); // a literal star is a segment
  for (const [method, path] of [
    ["POST", "workspace/thread/abc/update"], // one segment short
    ["POST", "workspace/home/thread/update"],
    ["POST", "workspace/home/other/abc/update"], // a literal segment still has to match
    ["GET", "workspace/home/thread/abc/update"],
  ]) {
    assert.throws(() => passes(rule, method, path), { status: 403 }, `${method} ${path}`);
  }
});

test("a star cannot be used to climb out", () => {
  for (const path of ["workspace/../thread/abc/update", "workspace/home/thread/../update"]) {
    assert.throws(() => passes("POST /workspace/*/thread/*/update", "POST", path), { status: 400 }, path);
  }
});

test("a star rule prints as written", () => {
  assert.deepEqual(parseRules("DELETE /workspace/*/thread/*").map(show), ["DELETE /workspace/*/thread/*"]);
});

test("the default list file is an entry a line, with comments", () => {
  assert.equal(defaultList("# why\n\n/workspaces\n  GET /scheduled-jobs  \n# more\nPOST /a/*/b, /c\n"), "/workspaces, GET /scheduled-jobs, POST /a/*/b, /c");
  assert.equal(defaultList("# nothing\n"), "");
  assert.throws(() => defaultList("/workspaces\nscheduled-jobs"), /BRIDGE_ALLOW/);
  assert.match(DEFAULT_FILE, /^# verified against AnythingLLM \d+\.\d+\.\d+$/m); // tools/routes reads and rewrites this line
});

test("a rule is absent when AnythingLLM declares no route under it", () => {
  const declared = [
    { method: "GET", segments: ["workspace", ":slug", "threads"] },
    { method: "POST", segments: ["workspace", ":slug", "thread", "new"] },
    { method: "GET", segments: ["scheduled-jobs", ":id", "runs"] },
  ];
  const absent = (text: string) => absentRules(parseRules(text), declared);
  assert.deepEqual(absent("GET /workspace/*/threads, POST /workspace/*/thread/new, /scheduled-jobs"), []);
  assert.deepEqual(absent("/workspace"), []); // any route under the prefix will do
  assert.deepEqual(absent("POST /workspace/*/threads"), ["POST /workspace/*/threads"]); // the method has to be one declared
  assert.deepEqual(absent("GET /workspace/*/thread/*/chats"), ["GET /workspace/*/thread/*/chats"]); // moved
  assert.deepEqual(absent("/workspaces"), ["/workspaces"]); // whole segments, so not /workspace
  assert.deepEqual(absent("GET /workspace/home/threads"), []); // a name where AnythingLLM has a :slug
  assert.deepEqual(absent("GET /scheduled-jobs/1/runs/2"), ["GET /scheduled-jobs/1/runs/2"]); // longer than any declared
});
