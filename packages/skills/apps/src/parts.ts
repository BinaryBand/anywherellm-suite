// The page parts this skill owns, from its static/ folder (inlined at build, or the user's own
// versions under apps-lean/.static/): templates (a whole page.html with <!--slot--> and
// <!--scripts--> where parts go), components (markup, then a <script>, for the slot and the
// scripts), figures (a drawing in parts.js, by kind), the guide's topics and the libraries a page
// names. Each part starts with a header, <!--part {json} --> or /*part {json} */: its name and
// line, and for a component the data, schema and events it needs. Starters are this skill's own:
// each names a template and the components it holds (starters.json), and its schema, first data
// and page are made from those parts, so a starter follows the parts as they change.

import vm from "node:vm";
import { Worker } from "node:worker_threads";
import { staticFiles, type StaticFiles } from "#shared/static";
import { overrides } from "./dirs.ts";
import type { Json } from "./patch.ts";

const KINDS: Record<string, [string, string]> = {
  templates: ["template", "Templates, for create:"],
  components: ["component", "Components (guide topic for the code):"],
  figures: ["figure", "Figures (data, drawn by parts.js):"],
};
const HEADER = /^(?:<!--part|\/\*part)\n([\s\S]*?)\n(?:-->|\*\/)\n/;
const SLOT = "<!--slot-->";
const SCRIPTS = "<!--scripts-->";
export const DEFAULT_TEMPLATE = "column";
export const PLACEHOLDER = "/*APP*/null";
export const tag = (name: string): string => (name.endsWith(".js") ? `<script src="${name}"></script>` : `<link rel="stylesheet" href="${name}">`);
export const RUNTIME_TAG = tag("app.js");

/** app.json's keys; the data is changed with do. */
export const DEFINITION = ["title", "about", "rules", "schema", "card", "icon", "jobs"];
/** Topic names that mean another: the libraries by their file names. */
const ALIASES: Record<string, string> = { "app.js": "runtime", "app.css": "styles", icon: "icons" };

/** `obj`'s app.json keys, those it has. */
export const definitionOf = (obj: Json): Json => Object.fromEntries(DEFINITION.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

interface Part {
  name: string;
  kind: string;
  line: string;
  header: Json;
  body: string;
  text: string;
}

// Read once per load of the skill: AnythingLLM loads handler.js afresh for each agent run, so a
// file tuned under .static/ is read at the next run.
let files: StaticFiles | null = null;
const statics = (): StaticFiles => (files ??= staticFiles(STATIC_FILES, overrides()));

/** A static file's text; throws naming it when there's none (a part the build left out). */
export function file(name: string): string {
  const found = statics().get(name);
  if (!found) throw new Error(`the skill has no ${name}`);
  return found.text;
}

/** A template's page: its own <main> in the shell every template shares (templates/shell.html,
 *  which has no header, so it is no part). A header's `cover` asks the viewport to reach under a
 *  phone's notch, and `untitled` leaves out the h1 the page's title goes into. */
const inShell = (header: Json, main: string): string =>
  file("parts/templates/shell.html")
    .replace("@VIEWPORT@", () => (header.cover ? ",viewport-fit=cover" : ""))
    .replace("@TITLE@", () => (header.untitled ? "" : '$("title").textContent = '))
    .replace("@MAIN@\n", () => main);

let byName: Record<string, Part> | null = null;
/** Every part, by name, read once per load. */
export function parts(): Record<string, Part> {
  if (byName) return byName;
  const found: Record<string, Part> = {};
  for (const folder of Object.keys(KINDS)) {
    for (const name of statics().list(`parts/${folder}/`)) {
      const text = file(`parts/${folder}/${name}`);
      const head = HEADER.exec(text);
      if (!head) continue;
      const header = JSON.parse(head[1]);
      const kind = KINDS[folder][0];
      const body = kind === "template" ? inShell(header, text.slice(head[0].length)) : text.slice(head[0].length);
      found[header.name] = { name: header.name, kind, line: header.line, header, body, text: head[0] + body };
    }
  }
  return (byName = found);
}

let startersRead: Record<string, Json> | null = null;
/** starters.json: each starter's line, title, template, parts, about, rules, card, its data over
 *  the parts' own, and any script of its own. */
export const starters = (): Record<string, Json> => (startersRead ??= JSON.parse(file("starters.json")));

/** The starter `name` means: its own name, or one of its aliases (a model asks for a "pomodoro");
 *  undefined when it means none. */
export function starterNamed(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const all = starters();
  return all[name] ? name : Object.keys(all).find((s) => (all[s].aliases || []).includes(name));
}

/** The index the agent reads: the starters, then each part's name and line, by kind. */
function index(): string {
  const all = Object.values(parts());
  const made = ["Starters, for create with starter (a working app and page in one call; adjust it after):", ...Object.entries(starters()).map(([name, s]) => `${name} - ${s.line}`)];
  return [...made, ...Object.values(KINDS).flatMap(([kind, head]) => [head, ...all.filter((p) => p.kind === kind).map((p) => `${p.name} - ${p.line}`)])].join("\n") + "\n";
}

/** What a guide topic gives for a part: its file, or for a figure how to place one. */
function shown(part: Part): string {
  if (part.kind !== "figure") return part.text;
  const spec = JSON.stringify(part.header.data || { kind: part.name });
  return `${part.name}: ${part.line}\n<figure class="fig" data-figure='${spec}'></figure>\n${tag("parts.js")}\nOr from data: Parts.figure(spec) gives the element.\n`;
}

/** How a page's script talks to its data: app.js's own reference, the comment it opens with, and
 *  what this edition does differently. */
function runtime(): string {
  const source = file("app.js");
  const head = source.slice(0, source.indexOf('"use strict"')).split("\n").map((l) => l.replace(/^\/\/ ?/, "")).join("\n").trim();
  return `${head}

In this edition (apps-lean), the page has no server of its own: a change is saved to AnythingLLM and reaches the app as it lands; changes from elsewhere (another device, the agent) show within a few seconds while the page is open. App.log(since) gives the newest 20 changes only.
`;
}

/** A starter as the guide shows it: what create makes from it, without the page. */
function starterTopic(name: string): string {
  const { line, template: from, parts: used, definition, data } = recipe(name)!;
  return `${name} starter: ${line}
create with {"action": "create", "name": "...", "title": "...", "starter": "${name}"}: the ${from} template with ${partsText(used)}, working as it is. data replaces the keys it names; text (app.json) replaces about, rules, card or schema.
app.json: ${JSON.stringify(definition)}
data: ${JSON.stringify(data)}
`;
}

export const topicNames = (): string[] => statics().list("topics/").filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));

/** One topic's text, or null when there's no such topic. */
function topicText(topic: string): string | null {
  if (topic === "runtime") return runtime();
  // What each class and element looks like: nothing shows the agent the page in a browser; the
  // stylesheet itself is the only way to know that .done strikes text through.
  if (topic === "styles") return file("app.css");
  // The design rules name icons, but this edition has no icon set.
  if (topic === "icons") return "This edition has no icon set: leave icon out of app.json.\n";
  if (topic === "check")
    return "This edition has no browser check: nothing loads the page before the user sees it. Read page.html once against the design rules (guide design) and the finish topic (guide finish) instead, and test what you can by reasoning through the page's script.\n";
  if (topicNames().includes(topic)) return file(`topics/${topic}.md`);
  if (starters()[topic]) return starterTopic(topic);
  const part = parts()[topic];
  return part ? shown(part) : null;
}

/** The guide: the index and the design rules without a topic; else each topic `query` names
 *  (several at once: "counter, date-grid"), with the runtime after any component, since a
 *  component's script is written against it. */
export function guide(query?: string): string {
  if (!query) return index() + "\n" + file("topics/design.md");
  const asked = [...new Set(String(query).split(/[\s,]+/).filter(Boolean).map((t) => ALIASES[t] || starterNamed(t) || t))];
  const found = asked.map((t) => [t, topicText(t)] as const);
  const missing = found.filter(([, text]) => text === null).map(([t]) => JSON.stringify(t));
  const known = `runtime, styles, icons, check, ${topicNames().join(", ")}, a starter's or a part's name`;
  // A model asks in sentences ("plant care tracker with due dates"): the index is the answer.
  if (missing.length === found.length) return `No topic is named in ${JSON.stringify(String(query).slice(0, 80))}; ask for a topic by its name, several at once. The index:\n${index()}`;
  const wantsRuntime = !asked.includes("runtime") && asked.some((t) => parts()[t]?.kind === "component");
  const texts = [...found.filter(([, text]) => text !== null), ...(wantsRuntime ? [["runtime", runtime()] as const] : [])] as (readonly [string, string])[];
  const out = texts.length === 1 ? texts[0][1] : texts.map(([t, text]) => `== ${t} ==\n${text}`).join("\n");
  return missing.length ? `${out}\nNo topic ${missing.join(" or ")}: ${known}.\n` : out;
}

/** The template called `name`'s page. */
export function template(name = DEFAULT_TEMPLATE): string {
  const found = parts()[name];
  if (!found || found.kind !== "template")
    throw new Error(`template must be one of: ${Object.values(parts()).filter((p) => p.kind === "template").map((p) => p.name).join(", ")}; or give starter, one of: ${Object.keys(starters()).join(", ")}`);
  return found.body;
}

/** A component's markup and its script. */
function split(name: string): { markup: string; script: string } {
  const part = parts()[name];
  if (!part || part.kind !== "component") throw new Error(`no component ${name}`);
  // A component of markup alone (one in .static, say) has no script to place.
  const at = part.body.indexOf("<script>");
  if (at < 0) return { markup: part.body.trim(), script: "" };
  return { markup: part.body.slice(0, at).trim(), script: part.body.slice(at).trim() };
}

/** `page` with `markup` at the slot and `script` at the scripts, each kept for what follows. */
const place = (page: string, markup: string, script: string): string => page.replace(SLOT, () => markup + "\n" + SLOT).replace(SCRIPTS, () => (script ? script + "\n" : "") + SCRIPTS);

/** `page` with a component's markup at the slot and its script at the scripts. */
export function compose(page: string, name: string): string {
  const { markup, script } = split(name);
  return place(page, markup, script);
}

/** A parts entry: a component's name, or a group of them repeated for each item of a list. */
export type Entry = string | { each: string; parts: string[] };

/** The component names in a parts entry. */
const namesIn = (entry: Entry): string[] => (typeof entry === "string" ? [entry] : entry.parts);
/** How a parts list reads in a reply. */
export const partsText = (used: Entry[]): string => used.map((e) => (typeof e === "string" ? e : `${e.parts.join(" and ")} for each of ${e.each}`)).join(", ");

/** The schema `names` components ask for, merged, and their first data. */
function mergedOf(names: string[]): { schema: Json; data: Json } {
  const schema: Json = { type: "object", required: [], properties: {} };
  const data: Json = {};
  for (const name of names) {
    const { header } = parts()[name];
    schema.required.push(...(header.schema?.required || []));
    Object.assign(schema.properties, header.schema?.properties);
    Object.assign(data, header.data);
  }
  return { schema, data };
}

/** The schema a parts list asks for, and its first data: a group's components merged into the
 *  items of its list, each item named, the list empty at first. */
function merged(used: Entry[]): { schema: Json; data: Json } {
  const top = mergedOf(used.filter((e): e is string => typeof e === "string"));
  for (const group of used.filter((e) => typeof e !== "string")) {
    const { schema: item } = mergedOf(group.parts);
    item.required.unshift("name");
    item.properties = { name: { type: "string", minLength: 1, maxLength: 80 }, ...item.properties };
    top.schema.required.push(group.each);
    top.schema.properties[group.each] = { type: "array", maxItems: 100, items: item };
    top.data[group.each] = [];
  }
  return top;
}

/** What occurs more than once in `list`, each once. */
const repeats = <T,>(list: T[]): T[] => [...new Set(list.filter((x, i) => list.indexOf(x) !== i))];

/** Why `used` can't be composed into a page: every problem, empty when it can. */
function partsProblems(used: unknown): string[] {
  const group = (e: Json) => e && typeof e === "object" && typeof e.each === "string" && Array.isArray(e.parts) && e.parts.every((n: unknown) => typeof n === "string");
  if (!Array.isArray(used) || !used.every((e) => typeof e === "string" || group(e)))
    return ['parts is a list of component names, or of groups repeated for each item of a list: {"each": "habits", "parts": ["counter", "date-grid"]}'];
  const entries = used as Entry[];
  const components = Object.values(parts()).filter((p) => p.kind === "component").map((p) => p.name);
  const out: string[] = [];
  const unknown = entries.flatMap(namesIn).filter((n) => !components.includes(n));
  if (unknown.length) out.push(`parts are components, one of: ${components.join(", ")}; not ${[...new Set(unknown)].join(", ")}`);
  const once = (names: string[], where: string) => {
    const twice = repeats(names);
    if (twice.length) out.push(`${where} holds each component once, not ${twice.join(", ")} twice`);
  };
  once(entries.filter((e): e is string => typeof e === "string"), "a page");
  for (const g of entries.filter((e) => typeof e !== "string")) {
    once(g.parts, `each ${g.each} item`);
    if (!/^[a-z][A-Za-z0-9_]{0,39}$/.test(g.each)) out.push(`each names a list in the data, such as habits, not ${JSON.stringify(g.each)}`);
    // A header's `single` marks one for the whole page, such as tabs, which switches its views.
    const single = g.parts.filter((n) => components.includes(n) && parts()[n].header.single);
    if (single.length) out.push(`${single.join(" and ")} can't repeat for each item`);
  }
  const lists = entries.filter((e) => typeof e !== "string").map((g) => g.each);
  if (new Set(lists).size < lists.length) out.push("each list repeats once");
  return out;
}

/** A page from the template `name` with the `used` components composed in, the schema they ask
 *  for and their first data. Throws naming every problem. */
export function assemble(name: string = DEFAULT_TEMPLATE, used: Json = []): { page: string; schema: Json; data: Json } {
  const found = partsProblems(used);
  let page = "";
  try {
    page = template(name);
  } catch (e) {
    found.unshift((e as Error).message);
  }
  if (found.length) throw new Error(found.join("\n- "));
  // A component's script goes in once, however many places hold it: it mounts them all.
  const scripted = new Set<string>();
  for (const entry of used as Entry[]) {
    const names = namesIn(entry);
    const markup = names.map((n) => split(n).markup).join("\n");
    const script = names.filter((n) => !scripted.has(n) && scripted.add(n)).map((n) => split(n).script).join("\n");
    page = place(
      page,
      typeof entry === "string" ? markup : `<div class="stack" data-each="/${entry.each}"><template>\n<section class="stack">\n<h2 data-text="name"></h2>\n${markup}\n</section>\n</template></div>`,
      script,
    );
  }
  return { page, ...merged(used) };
}

/** The starter called `name` without its page: its line, template and parts, its app.json
 *  (`definition`) with the schema its components ask for, and their first data under its own; null
 *  when there's no such starter. */
function recipe(name: string): { line: string; template: string; parts: Entry[]; definition: Json; data: Json; script?: string } | null {
  const own = starters()[starterNamed(name) ?? ""];
  if (!own) return null;
  const { schema, data } = merged(own.parts);
  return { line: own.line, template: own.template, parts: own.parts, definition: { ...definitionOf(own), schema }, data: { ...data, ...own.data }, script: own.script };
}

/** The starter called `name`, made whole: its recipe and its page, with the starter's own script
 *  after its components'; null when there's no such starter. */
export function starter(name: string): Omit<NonNullable<ReturnType<typeof recipe>>, "script"> & { page: string } | null {
  const found = recipe(name);
  if (!found) return null;
  const { script, ...made } = found;
  const { page } = assemble(made.template, made.parts);
  return { ...made, page: script ? page.replace(SCRIPTS, () => `<script>\n${script}\n</script>\n${SCRIPTS}`) : page };
}

let libs: Record<string, string> | null = null;
/** The libraries a page may name, as a page gets them inline: parts.js with every figure. Made once
 *  per load, as the parts are. */
export function libraries(): Record<string, string> {
  if (libs) return libs;
  const figures = Object.values(parts()).filter((p) => p.kind === "figure").map((p) => p.body);
  return (libs = { "app.js": file("app.js"), "app.css": file("app.css"), "parts.js": [file("parts.js"), ...figures].join("\n") });
}

// What a page may use without declaring it: the browser's own globals. A name starting with a
// capital (IntersectionObserver, HTMLElement) is taken as one too.
const BROWSER = new Set(
  (
    "window self globalThis document App Parts AppsLean localStorage sessionStorage location history navigator matchMedia " +
    "setTimeout setInterval clearTimeout clearInterval requestAnimationFrame cancelAnimationFrame requestIdleCallback queueMicrotask fetch alert confirm prompt " +
    "getComputedStyle innerWidth innerHeight outerWidth scrollX scrollY scrollTo scrollBy addEventListener removeEventListener dispatchEvent devicePixelRatio " +
    "crypto performance structuredClone atob btoa screen visualViewport speechSynthesis open close print focus blur getSelection origin isSecureContext name event"
  ).split(" "),
);

/** How long the page check lets one of a page's scripts, or one draw, run, and the whole check:
 *  a page that loops forever is stopped rather than holding AnythingLLM's process. */
const CHECK_MS = 500;
const CHECK_ALL_MS = 4000;

// The page check runs a page's scripts in a worker thread, in a vm context of the worker's own,
// against a stand-in browser made inside that context: a page reaches only objects of the
// context, never one of the skill's or AnythingLLM's, and a page that loops, in a script, a draw
// or a promise's callback, is stopped by vm's timeout or, failing that, by ending the worker.
// (A vm timeout that cuts into a microtask can break Node's async hooks, which ends the process;
// in a worker of its own it ends only the worker.) Node's vm is no security boundary, its docs
// say: this keeps the check from being a way into the skill or a way to hold the process, and
// nothing more: page.html is the model's own. `__anything()` is a stand-in for every browser
// object: any property, call or construction gives it back, it counts as 0 or "" and iterates as
// empty.
const CHECKER = String.raw`
const { workerData } = require("node:worker_threads");
const vm = require("node:vm");
const { scripts, browser, ms } = workerData;
const found = [];
try {
  const ctx = vm.createContext({}, { microtaskMode: "afterEvaluate", codeGeneration: { strings: false, wasm: false } });
  const inside = (code) => new vm.Script(code).runInContext(ctx, { timeout: ms });
  inside(${"`"}
    var __later = [];
    function __anything() {
      var p = new Proxy(function () {}, {
        get: function (_t, k) { return k === Symbol.toPrimitive ? function () { return 0; } : k === Symbol.iterator ? function* () {} : k === "then" ? undefined : k === "length" ? 0 : p; },
        apply: function () { return p; },
        construct: function () { return p; },
        set: function () { return true; },
      });
      return p;
    }
    var console = { log: function () {}, warn: function () {}, error: function () {}, info: function () {} };
    var App = {
      data: __anything(), title: "", line: 0, card: {}, start: function () { return __anything(); }, get: function () { return __anything(); },
      set: function () { return Promise.resolve(true); }, patch: function () { return Promise.resolve(true); }, log: function () { return Promise.resolve([]); },
      onchange: function (fn) { __later.push(fn); }, onstatus: function () {},
      mount: function (_name, fn) { __later.push(function () { var draw = fn({ root: __anything(), at: "", q: function () { return __anything(); } }); if (typeof draw === "function") draw(); }); },
    };
    var window = globalThis, self = globalThis;
  ${"`"});
  inside("for (const n of " + JSON.stringify(browser) + ") if (!(n in globalThis)) globalThis[n] = __anything();");
  const run = (fn, where) => {
    for (let tries = 0; tries < 20; tries++) {
      try {
        return fn();
      } catch (e) {
        const name = e && e.name === "ReferenceError" ? (/^(\S+) is not defined/.exec(e.message) || [])[1] : null;
        if (!name) return; // only an undeclared name is judged here; a timeout ends the try
        if (/^[A-Z$_]/.test(name)) { inside("globalThis[" + JSON.stringify(name) + "] = __anything();"); continue; } // a browser constructor the list lacks
        const line = /script(\d+):(\d+)/.exec(e.stack || "");
        found.push("page.html uses " + name + ", which no script declares" + where + (line ? " (script " + line[1] + ", line " + line[2] + ")" : "") + ": the page stops there");
        return;
      }
    }
  };
  scripts.forEach((code, i) => run(() => new vm.Script(code, { filename: "script" + (i + 1) }).runInContext(ctx, { timeout: ms }), ""));
  const later = Number(inside("__later.length"));
  for (let i = 0; i < later; i++) run(() => inside("__later[" + i + "]()"), " when it draws");
} finally {
  require("node:worker_threads").parentPort.postMessage([...new Set(found)]);
}
`;

/** Each name page.html's scripts use without declaring, found by running them once, in order,
 *  against a stand-in browser, the way a page loads: each component is mounted and drawn, and each
 *  onchange called. What a stand-in can't decide (a TypeError) isn't judged, nor a script or draw
 *  that runs too long, nor a check that doesn't end in time. The call waits for the worker; the
 *  process goes on meanwhile. */
function unknownNames(scripts: string[]): Promise<string[]> {
  const worker = new Worker(CHECKER, {
    eval: true,
    workerData: { scripts, browser: [...BROWSER], ms: CHECK_MS },
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
    stdout: true,
    stderr: true,
  });
  return new Promise<string[]>((resolve) => {
    const timer = setTimeout(() => resolve([]), CHECK_ALL_MS);
    const done = (found: string[]) => (clearTimeout(timer), resolve(found));
    worker.once("message", done);
    worker.once("error", () => done([]));
    worker.once("exit", () => done([]));
  }).finally(() => void worker.terminate());
}

/** Advice when page.html sets colours of its own (#fff, rgb(...)) outside a var() fallback: one of
 *  the two themes then can't be read, as a white card under light text in dark mode. Empty when
 *  there are none, or when app.json keeps a choice the user asked for, as a rule tagged with the
 *  advice it overrides ("[accent] ..."). */
export function colourNote(page: unknown, rules: Json = []): string {
  if (typeof page !== "string" || (rules || []).some((r: unknown) => /^\s*\[[a-z-]+\]/i.test(String(r)))) return "";
  const css = [...page.matchAll(/<style>([\s\S]*?)<\/style>|style="([^"]*)"/g)].map((m) => m[1] ?? m[2]).join("\n").replace(/var\([^()]*(\([^()]*\))?[^()]*\)/g, "");
  const found = [...new Set(css.match(/#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|oklch)\([^)]*\)|:\s*(white|black)\b/gi) || [])].map((c) => c.replace(/^:\s*/, ""));
  return found.length
    ? `page.html sets colours of its own (${found.slice(0, 4).join(", ")}), which one of the light and dark themes won't read: use var(--bg), var(--panel), var(--well), var(--line), var(--ink), var(--muted) and var(--accent). If the user asked for a colour, keep it and add a rule tagged [accent] saying so.`
    : "";
}

/** The text of each inline <script> in an HTML page, in order. */
export const scriptsOf = (html: string): string[] => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

/** The ids the markup of `page` gives its elements, scripts left out. */
const idsOf = (page: string): string[] => [...page.replace(/<script[\s\S]*?<\/script>/g, "").matchAll(/\sid=["']([^"']+)["']/g)].map((m) => m[1]);

/** Why `page` can't be an app's page.html: every problem, empty when it can. With no browser here
 *  to load the page, each inline script is parsed, and each part the markup holds must have its
 *  App.mount, which a script that doesn't parse or a lost script would leave blank. */
export async function pageProblems(page: unknown): Promise<string[]> {
  if (typeof page !== "string") return ["page.html must be HTML text"];
  const out: string[] = [];
  if (Buffer.byteLength(page) > 1 << 20) out.push("page.html is at most 1 MB");
  if (!page.includes(RUNTIME_TAG)) out.push(`page.html must load the runtime: ${RUNTIME_TAG}`);
  if (page.split(PLACEHOLDER).length !== 2) out.push(`page.html must start the app once: App.start(${PLACEHOLDER})`);
  const scripts = scriptsOf(page);
  let parses = true; // a script that doesn't parse can't be run
  scripts.forEach((code, i) => {
    try {
      new vm.Script(code, { filename: `script${i + 1}` });
    } catch (e) {
      parses = false;
      const err = e as Error;
      const line = code.split("\n")[(Number(/script\d+:(\d+)/.exec(err.stack ?? "")?.[1]) || 1) - 1]?.trim();
      out.push(`page.html's script ${i + 1} of ${scripts.length} doesn't parse: ${err.message}${line ? ` at: ${line}` : ""}`);
    }
  });
  const refs = new Set([...page.matchAll(/data-ref="([^"]+)"/g)].map((m) => m[1]));
  const asked = [...new Set(scripts.flatMap((code) => [...code.matchAll(/\bq\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1])))].filter((r) => !refs.has(r));
  if (asked.length)
    out.push(`page.html's scripts look up ${asked.map((r) => `q("${r}")`).join(", ")}, but no element has ${asked.map((r) => `data-ref="${r}"`).join(", ")}: q finds an element by its data-ref, never its id`);
  const ids = idsOf(page);
  const repeated = repeats(ids);
  if (repeated.length) out.push(`page.html gives the id ${repeated.map((id) => `"${id}"`).join(", ")} to more than one element: an id is one element's`);
  // $(id) finds an element by its id, so one the markup never gives is a lookup of nothing, unless
  // a script makes elements with ids of its own.
  const all = scripts.join("\n");
  if (/(?:const|let|var)\s+\$\s*=[^;\n]*getElementById/.test(all)) {
    const known = new Set(ids);
    const lost = [...new Set([...all.matchAll(/\$\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]))].filter((id) => !known.has(id));
    if (lost.length && !/\bid\s*[:=]|setAttribute\(\s*["']id["']/.test(all)) out.push(`page.html's scripts look up ${lost.map((id) => `$("${id}")`).join(", ")}, but no element has ${lost.map((id) => `id="${id}"`).join(", ")}`);
  }
  if (parses) out.push(...(await unknownNames(scripts)));
  const names = scripts.flatMap((code) => [...code.matchAll(/App\.mount\(\s*["']([^"']+)["']/g)].map((m) => m[1]));
  const twice = repeats(names);
  if (twice.length) out.push(`page.html has the script for ${twice.join(", ")} more than once: each component's script goes in once`);
  const mounted = new Set(names);
  const unmounted = [...new Set([...page.matchAll(/data-part="([^"]+)"/g)].map((m) => m[1]))].filter((n) => !mounted.has(n));
  if (unmounted.length) out.push(`page.html holds data-part ${unmounted.join(", ")} with no App.mount script for it`);
  return out;
}
