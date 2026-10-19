import assert from "node:assert/strict";
import { test } from "node:test";
import "./harness.mts";
import vm from "node:vm";
import * as parts from "../src/parts.ts";

const column = parts.template("column");
/** The column template with `markup` at its slot and `script` at its scripts. */
const bare = (markup: string, script?: string) => column.replace("<!--slot-->", markup).replace("<!--scripts-->", script ? `<script>${script}</script>` : "");

test("a page from a template and its components has no problems", async () => {
  assert.deepEqual(await parts.pageProblems(parts.compose(column, "counter")), []);
});

test("an element id given twice is refused, and one a script builds into markup is not counted", async () => {
  assert.deepEqual(await parts.pageProblems(bare('<p id="a"></p><p id="b"></p><p id="a"></p>')), ['page.html gives the id "a" to more than one element: an id is one element\'s']);
  assert.deepEqual(await parts.pageProblems(bare('<p id="a"></p>', 'document.body.insertAdjacentHTML("beforeend", \'<p id="a"></p>\');')), []);
});

test("$(id) of an element the markup never gives is refused", async () => {
  assert.deepEqual(await parts.pageProblems(bare('<p id="here"></p>', '$("here").hidden = true; $("gone").hidden = true;')), ['page.html\'s scripts look up $("gone"), but no element has id="gone"']);
});

test("$(id) is not judged where a script makes elements with ids, or $ isn't getElementById", async () => {
  assert.deepEqual(await parts.pageProblems(bare("", 'document.body.append(el("p", { id: "made" })); $("made").hidden = true;')), []);
  assert.deepEqual(await parts.pageProblems(bare("", 'const made = el("p", {}); made.setAttribute("id", "late"); document.body.append(made); $("late").hidden = true;')), []);
  const own = parts.template("column").replace("const $ = (id) => document.getElementById(id);", 'const $ = (css) => document.querySelector(css);').replace("<!--scripts-->", '<script>$("#title").hidden = true;</script>');
  assert.deepEqual((await parts.pageProblems(own)).filter((p) => p.includes("look up $(")), []);
});

test("a component's script twice is refused", async () => {
  const twice = parts.compose(parts.compose(column, "counter"), "counter");
  assert.deepEqual(await parts.pageProblems(twice), ["page.html has the script for counter more than once: each component's script goes in once"]);
});

test("a script that doesn't parse is said once, with its line", async () => {
  const broken = bare("", "return () => {");
  const found = await parts.pageProblems(broken);
  assert.equal(found.length, 1);
  assert.match(found[0], /^page\.html's script 2 of 2 doesn't parse: Illegal return statement at: return \(\) => \{$/);
});

test("the check's stand-ins reach nothing of the skill's: a page can't get at Node through them", async () => {
  const tries = [
    'App.set.constructor("return process")().env.APPS_ESCAPED = "set";',
    'console.log.constructor("return process")().env.APPS_ESCAPED = "log";',
    'App.data.constructor.constructor("return process")().env.APPS_ESCAPED = "proxy";',
    'this.constructor.constructor("return process")().env.APPS_ESCAPED = "global";',
    'App.mount("x", (part) => () => part.q.constructor("return process")().env.APPS_ESCAPED = "mount");',
  ];
  for (const code of tries) {
    await parts.pageProblems(bare('<div data-part="x"></div>', `${code}\nApp.mount("x", () => () => {});`));
    assert.equal(process.env.APPS_ESCAPED, undefined, code);
  }
});

test("a page that loops forever is stopped, in its script, a draw or an onchange, and the check goes on", async () => {
  const started = Date.now();
  for (const code of ["while (true) {}", 'App.mount("x", () => () => { for (;;) {} });', "App.onchange(() => { while (true) {} });", "Promise.resolve().then(() => { for (;;) {} });"]) {
    const found = await parts.pageProblems(bare('<div data-part="x"></div>', `${code}\nApp.mount("x", () => () => {});`));
    assert.deepEqual(found.filter((p) => !p.includes("more than once")), [], code);
  }
  assert.ok(Date.now() - started < 10_000, "each is stopped at its timeout");
  assert.deepEqual(await parts.pageProblems(bare("", "App.onchange(() => draw());")), ["page.html uses draw, which no script declares when it draws (script 2, line 1): the page stops there"], "the rest is still judged");
});

test("every component, alone in a page, passes the page check", async () => {
  for (const name of Object.values(parts.parts()).filter((p) => p.kind === "component").map((p) => p.name))
    assert.deepEqual(await parts.pageProblems(parts.assemble("column", [name]).page), [], name);
});

// The page check's stand-in DOM finds any ref, so it can't see a q() that finds nothing: q() looks
// inside the part's element, never at the element itself.
test("every ref a component's script asks q() for is inside its part", () => {
  for (const { name, body } of Object.values(parts.parts()).filter((p) => p.kind === "component")) {
    const script = parts.scriptsOf(body).join("\n");
    const markup = body.replace(/<script[\s\S]*?<\/script>/g, "");
    const root = new RegExp(`<[^>]*data-part="${name}"[^>]*>`).exec(markup);
    if (!root) continue;
    const inside = markup.slice(root.index + root[0].length);
    for (const [, ref] of script.matchAll(/\bq\("([\w-]+)"\)/g)) assert.ok(inside.includes(`data-ref="${ref}"`), `${name}: q("${ref}") finds nothing`);
  }
});

/** A figure drawn from `spec` by parts.js and its kinds, in a stand-in browser: the SVG it makes. */
function drawn(spec: Record<string, unknown>): string {
  const made: any[] = [];
  const document = { createElement: () => { const e: any = { dataset: {}, className: "", innerHTML: "" }; made.push(e); return e; }, querySelectorAll: () => [], addEventListener() {} };
  const ctx: any = { document, queueMicrotask: () => {}, setTimeout, console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(parts.libraries()["parts.js"], ctx);
  return vm.runInContext(`Parts.figure(${JSON.stringify(spec)}).innerHTML`, ctx);
}

test("bars draw one bar per item, scaled to the largest, the marked one filled, said in words", () => {
  const svg = drawn({ kind: "bars", items: [{ label: "May", value: 310 }, { label: "Jun", value: 155 }], mark: 0, unit: "£" });
  const bars = [...svg.matchAll(/<rect class="(f[is])" x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)"/g)].map((m) => [m[1], Math.round(Number(m[3]))]);
  assert.deepEqual(bars, [["fi", 120], ["fs", 60]]);
  assert.match(svg, /aria-label="May £310, Jun £155"/);
  assert.match(drawn({ kind: "bars", items: [] }), /aria-label="No values yet"/);
});

test("a gantt draws dated steps on lanes, with today and a milestone, and skips a step it can't date", () => {
  const svg = drawn({ kind: "gantt", items: [{ label: "Plan", start: "2026-11-03", end: "2026-11-09", done: true }, { label: "Fit", start: "2026-11-10", end: "2026-11-16" }, { label: "Bad", start: "soon", end: "later" }], today: "2026-11-10", milestone: { label: "Done", date: "2026-11-16" } });
  assert.equal([...svg.matchAll(/<rect class="f[is]"/g)].length, 2);
  assert.match(svg, /<rect class="fi"[^>]*\/><text class="ti" x="8"[^>]*>Fit/, "the done step filled, the next one not");
  assert.match(svg, />today</);
  assert.match(svg, />Done</);
  assert.match(svg, /aria-label="Plan 11-03 to 11-09, done; Fit 11-10 to 11-16"/);
});

test("a component of markup alone is placed with no script", () => {
  const all = parts.parts();
  all["bare-note"] = { name: "bare-note", kind: "component", line: "", header: {}, body: "<p data-part=\"bare-note\">Hi</p>\n", text: "" };
  try {
    const page = parts.compose(parts.template("column"), "bare-note");
    assert.ok(page.includes('<p data-part="bare-note">Hi</p>'));
    assert.equal(parts.scriptsOf(page).length, parts.scriptsOf(parts.template("column")).length);
  } finally {
    delete all["bare-note"];
  }
});
