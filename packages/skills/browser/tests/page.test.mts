// The tab's page against what the skill writes and applies: drift between static/pages/tab.html and
// page.ts shows here, not on the user's phone.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { call, post, site, skillDir, tabState } from "./harness.mts";

const pageSource = () => fs.readFileSync(path.join(skillDir, "static", "pages", "tab.html"), "utf8");
const handled = fs.readFileSync(path.join(skillDir, "src", "page.ts"), "utf8");
const takeover = fs.readFileSync(path.join(skillDir, "src", "takeover.ts"), "utf8").match(/const EVENTS = [^\n]*/)![0];

test("every event the page posts is one the skill applies", () => {
  const posted = [...pageSource().matchAll(/post\("([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(posted)].sort(), ["give", "nav", "need-answer", "need-cancel", "offer", "scroll", "size", "take", "tap", "type"]);
  for (const ev of posted) assert.ok(handled.includes(`"${ev}"`) || takeover.includes(`"${ev}"`), ev);
});

test("every field the page reads from its state is one the skill writes", async () => {
  site("https://form.example/", { title: "Form", fields: { e1: { type: "text", name: "User" }, e2: { type: "password", name: "Password" } } });
  const opts = { workspace: "drift" };
  await call({ action: "open", url: "https://form.example/" }, opts);
  await call({ action: "login", user_ref: "e1", pass_ref: "e2" }, opts);
  post({ ev: "need-answer", user: "u", sealed: "not sealed" }, opts);
  await call({ action: "read" }, opts);
  const state = tabState("drift");
  const html = pageSource();
  for (const [, field] of html.matchAll(/\bst\.([a-z_]+)/g)) assert.ok(field in state, `st.${field}`);
  assert.ok(state.need, "a need that couldn't be met stays");
  for (const [, field] of html.matchAll(/\bneed\.([a-zA-Z_]+)/g)) assert.ok(field in state.need, `need.${field}`);
  // contract/browser-tab.md lists the state's fields and the need's, for clients: the same as written
  const contract = fs.readFileSync(path.join(skillDir, "..", "..", "..", "contract", "browser-tab.md"), "utf8");
  const listed = (heading: string): string[] => {
    const at = contract.indexOf(`\n${heading}\n`);
    assert.ok(at >= 0, `the contract has a section ${heading}`);
    const body = contract.slice(at + heading.length + 2).split(/\n#/)[0]; // up to the next heading
    return [...body.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]).sort();
  };
  assert.deepEqual(listed("## The state, `<token>.json`"), Object.keys(state).sort(), "the state's fields in the contract");
  assert.deepEqual(listed("### `need`"), Object.keys(state.need).sort(), "the need's fields in the contract");
});
