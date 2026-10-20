// A workspace's apps on disk. One app is one JSON file, <root>/<workspace>/<name>.json: what
// app.json holds (title, about, rules, schema, card, icon), its page.html (built from the parts),
// its data, its line (how many changes it has had), when it was made and last changed, its newest
// changes, each with the data as it was before, so undo can step back, and its earlier app.json and
// page.html, so undo with a file can. Every write goes to a temporary file renamed over the app, so an app is
// never half written, and every read-change-write holds the app's lock (#shared/atomic), since a
// scheduled job runs in a process of its own.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { locked, readJson, writeAtomic } from "#shared/atomic";
import { newSecret } from "#shared/pages";
import { Told } from "#shared/errors";
import { root } from "./dirs.ts";
import { apply, PatchError, type Json } from "./patch.ts";
import { DEFINITION, definitionOf, pageProblems } from "./parts.ts";
import { problems, schemaProblems } from "./schema.ts";

/** A mistake in what the agent asked for, said back to it in words. */
export class AppError extends Told {}

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const WORKSPACE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;
export const KEEP = 20;
/** How many earlier versions of app.json and page.html an app keeps, together, for undo. */
export const VERSIONS = 10;
/** How many page events an app remembers by id, so one sent twice applies once. */
const SEEN = 100;
/** How many changes a page sent that were refused an app remembers, with why, for its page. */
const REFUSED = 20;
const TITLE_MAX = 80;
const CARD_KEYS = new Set(["summary", "lines", "items", "text", "done", "where"]);
const FILES = ["app.json", "page.html"];

const now = (): string => new Date().toISOString().replace(/\.\d+Z$/, "Z");

function folder(workspace: string): string {
  if (!WORKSPACE.test(workspace)) throw new AppError(`not a workspace: ${JSON.stringify(workspace)}`);
  return path.join(root(), workspace);
}

/** Why `name` can't be an app's name, or null. */
const nameProblem = (name: unknown): string | null => (typeof name === "string" && NAME.test(name) ? null : "an app's name is 1-63 lowercase letters, digits and hyphens, such as groceries");

function fileOf(workspace: string, name: unknown): string {
  const why = nameProblem(name);
  if (why) throw new AppError(why);
  return path.join(folder(workspace), `${name}.json`);
}

/** Runs `fn` holding the app's lock: one change to an app at a time, in any process. */
const withLock = <T,>(workspace: string, name: unknown, fn: () => T): Promise<T> => locked(`${fileOf(workspace, name)}.lock`, `the app ${name}`, fn);

// For the owner alone: an app holds its page's secret.
const save = (workspace: string, app: Json): void => writeAtomic(fileOf(workspace, app.name), JSON.stringify(app, null, 1) + "\n", 0o600);

export function read(workspace: string, name: unknown): Json {
  return readJson(fileOf(workspace, name), () => {
    throw new AppError(`this workspace has no app named ${name}; list shows its apps`);
  });
}

/** Reads the app, changes it with `fn` and saves the `next` app `fn` answers, all under the app's lock;
 *  a `next` that is the app itself is saved for none. Answers the saved app and the more `fn` answered
 *  besides. With `pageFirst`, for a change that may write page.html, `fn` is tried first on the app as
 *  it is, outside the lock, so the page it writes is checked (the slow part) before the lock is taken,
 *  and found checked under it; `fn` must change nothing but what it answers. */
export async function updateWith<R extends object>(workspace: string, name: unknown, fn: (app: Json) => Promise<{ next: Json } & R>, pageFirst = false): Promise<{ app: Json } & R> {
  if (pageFirst)
    try {
      await fn(read(workspace, name));
    } catch {} // said by the try under the lock
  return withLock(workspace, name, async () => {
    const app = read(workspace, name);
    const { next, ...rest } = await fn(app);
    if (next !== app) save(workspace, next);
    return { app: next, ...rest } as { app: Json } & R;
  });
}

/** updateWith for `fn` that answers just the next app: the saved app. */
const update = async (workspace: string, name: unknown, fn: (app: Json) => Json | Promise<Json>, pageFirst = false): Promise<Json> =>
  (await updateWith(workspace, name, async (app) => ({ next: await fn(app) }), pageFirst)).app;

const isSeen = (app: Json, id: string | undefined): boolean => !!id && (app.seen || []).includes(id);
/** `app` remembering the page event `id` as seen, so one sent twice applies once; with `why`, as
 *  refused too, so its page stops showing it and can say so. An event with no id, or seen already, is
 *  left as it is. */
function remember(app: Json, id: string | undefined, why?: string): Json {
  if (!id || isSeen(app, id)) return app;
  return { ...app, seen: [...(app.seen || []), id].slice(-SEEN), ...(why === undefined ? {} : { refused: [...(app.refused || []), { id, why }].slice(-REFUSED) }) };
}

// The page check parses a page's scripts, which is slow next to a lock that should be held for
// milliseconds: the newest pages' problems are kept, by a hash of their text, so a page checked
// before its app's lock is taken (update's pageFirst) is found checked under it.
const PAGES_KEPT = 8;
const checkedPages = new Map<string, string[]>();
async function problemsOfPage(page: unknown): Promise<string[]> {
  if (typeof page !== "string") return pageProblems(page);
  const key = crypto.createHash("sha256").update(page).digest("base64url");
  let found = checkedPages.get(key);
  if (!found) {
    checkedPages.set(key, (found = await pageProblems(page)));
    for (const old of [...checkedPages.keys()].slice(0, -PAGES_KEPT)) checkedPages.delete(old);
  }
  return found;
}

/** Why the definition can't hold `data`: every problem, empty when it can. The data is checked
 *  whenever the schema itself can be read, whatever else is wrong; the page only when `page`, as
 *  when it's new or changed (the check parses its scripts, which is the slow part). */
async function definitionProblems(app: Json, page: boolean): Promise<string[]> {
  const out: string[] = [];
  if (typeof app.title !== "string" || !app.title.trim() || app.title.length > TITLE_MAX) out.push(`title: 1-${TITLE_MAX} characters`);
  if (app.about !== undefined && typeof app.about !== "string") out.push("about: a sentence");
  if (!Array.isArray(app.rules) || app.rules.some((r: unknown) => typeof r !== "string")) out.push("rules: a list of sentences");
  const schema = app.schema && typeof app.schema === "object" && !Array.isArray(app.schema) ? schemaProblems(app.schema) : null;
  if (!schema) out.push("schema: a JSON Schema object");
  else out.push(...schema.map((p) => `schema${p}`));
  if (!app.card || typeof app.card !== "object" || Array.isArray(app.card)) out.push("card: an object of summary, lines, items, text, done and where");
  else {
    for (const k of Object.keys(app.card)) if (!CARD_KEYS.has(k)) out.push(`card.${k}: not a card key (summary, lines, items, text, done, where)`);
    for (const k of ["summary", "lines"]) {
      const bad = typeof app.card[k] === "string" ? [...app.card[k].matchAll(/\{([^{}]*)\}/g)].map((m: RegExpMatchArray) => m[1]).filter((p: string) => !p.startsWith("/") || /\s/.test(p)) : [];
      if (bad.length) out.push(`card.${k}: {${bad[0]}} is not a pointer into the data; a card says {/items/length} or {/count}, one value each, and works out nothing`);
    }
    if (app.card.items !== undefined && (typeof app.card.items !== "string" || !app.card.items.startsWith("/"))) out.push("card.items: a pointer to a list, such as /items");
  }
  if (app.icon !== undefined && typeof app.icon !== "string") out.push("icon: a name");
  if (app.jobs !== undefined && typeof app.jobs !== "boolean") out.push("jobs: true lets a scheduled job change the data with do");
  if (page && app.page !== undefined) out.push(...(await problemsOfPage(app.page)));
  if (schema && !schema.length) out.push(...problems(app.data, app.schema).map((p) => `data ${p}`));
  return out;
}

/** `app`, unless it or `earlier` has a problem: then all of them, in one error. */
async function checked(app: Json, earlier: string[] = [], what = "saved", page = true): Promise<Json> {
  const found = [...earlier, ...(await definitionProblems(app, page))];
  if (found.length) throw new AppError(`the app can't be ${what}:\n- ${found.join("\n- ")}`);
  return app;
}

/** This workspace's apps, the newest change first. */
export function list(workspace: string): Json[] {
  const dir = folder(workspace);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch {
        return { name: f.slice(0, -5), title: f.slice(0, -5), broken: true, changed: "" };
      }
    })
    .sort((a, b) => (b.changed || "").localeCompare(a.changed || ""));
}

/** A name for an app called `title` that this workspace doesn't have yet: "Lisbon packing!" is
 *  lisbon-packing, then lisbon-packing-2. A model often leaves the name out. */
export function freeName(workspace: string, title: unknown): string {
  const base =
    String(title || "app").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56).replace(/-+$/, "") || "app";
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!fs.existsSync(fileOf(workspace, name))) return name;
  }
}

/** A new app: `definition` is app.json's keys and `data`, its first data; `page` its page.html.
 *  `earlier` are problems the caller found, reported with the app's own. */
export async function create(workspace: string, name: unknown, definition: Json, earlier: string[] = []): Promise<Json> {
  const make = async () => {
    const found = [...earlier];
    const why = nameProblem(name);
    if (why) found.push(why);
    else if (fs.existsSync(fileOf(workspace, name))) found.push(`this workspace already has an app named ${name}`);
    const t = now();
    const app = await checked({ name, rules: [], ...definition, line: 0, made: t, changed: t, history: [], secret: newSecret() }, found, "made");
    save(workspace, app);
    return app;
  };
  if (typeof definition.page === "string") await problemsOfPage(definition.page); // before the lock
  // A name that can't be one has no lock to take: its problem is said with the others.
  return nameProblem(name) ? make() : withLock(workspace, name, make);
}

/** One change to an app's data, as an action or a page sends it. */
export interface Change {
  patch: Json;
  ev?: string;
  fields?: Json;
  by?: string;
  id?: string;
  /** Refuse it unless the app takes changes from scheduled jobs (app.json's "jobs": true). */
  jobsOnly?: boolean;
}

/** `app` with `patch` applied to its data and checked against its schema, unsaved. `by` names who
 *  changed it (the agent unless said); a change with an `id` already seen is skipped, and the app
 *  itself comes back. */
function applyChange(app: Json, { patch, ev, fields, by, id }: Change): Json {
  if (isSeen(app, id)) return app;
  let data;
  try {
    data = apply(app.data, patch);
  } catch (e) {
    if (e instanceof PatchError) throw new AppError(`the change doesn't apply: ${e.message}. read gives the data as it is now`);
    throw e;
  }
  const found = problems(data, app.schema);
  if (found.length) throw new AppError(`the change breaks the app's schema:\n- ${found.join("\n- ")}`);
  const line = (app.line || 0) + 1;
  // Each change keeps the line it made: an undo also takes a line, so the newest changes' lines
  // can't be worked out from where they stand in the history.
  const entry = { n: line, t: now(), by: by || "agent", ev: ev || "change", ...(fields ? { fields } : {}), patch, before: app.data };
  const next = { ...app, data, line, changed: entry.t, history: [...(app.history || []), entry].slice(-KEEP) };
  return remember(next, id);
}

/** The app with `patch` applied to its data, checked against its schema and saved. */
export async function change(workspace: string, name: unknown, opts: Change): Promise<Json> {
  return update(workspace, name, (app) => {
    if (opts.jobsOnly && app.jobs !== true) throw new AppError(`${name} doesn't take changes from scheduled jobs: the user lets it from a chat, where its app.json gets "jobs": true`);
    return applyChange(app, opts);
  });
}

/** What became of one of several changes: made (`{}`), seen before, or refused with its error. */
export interface Answer {
  duplicate?: boolean;
  error?: Error;
}

/** `app` with several changes applied, in order, unsaved: one answer for each (the others still
 *  apply when one doesn't). Those past the first `most` are refused untried, so a flood can't push the
 *  app's changes out of its history. */
export function changesOn(first: Json, changes: Change[], most = Infinity): { next: Json; answers: Answer[] } {
  let app = first;
  const answers = changes.map((opts, i): Answer => {
    try {
      if (i >= most) throw new AppError(`more than ${most} changes at once`);
      const next = applyChange(app, opts);
      if (next === app) return { duplicate: true };
      app = next;
      return {};
    } catch (error) {
      app = remember(app, opts.id, (error as Error).message.split("\n")[0]);
      return { error: error as Error };
    }
  });
  return { next: app, answers };
}

/** `app` with its newest data change taken back, checked: the data as it was may no longer fit the
 *  schema (app.json changed since). */
async function undoOn(app: Json): Promise<{ next: Json; undone: Json }> {
  const history: Json[] = app.history || [];
  const undone = history.at(-1);
  if (!undone) throw new AppError(`${app.name} has no change left to undo`);
  const next = { ...app, data: undone.before, line: (app.line || 0) + 1, changed: now(), history: history.slice(0, -1) };
  return { next: await checked(next, [], "undone", false), undone };
}

/** Whether `app`'s newest change is to one of its files rather than to its data. A file's change
 *  keeps the line the app was at, so it came after the data change that made that line. */
function fileIsNewest(app: Json): boolean {
  const data = (app.history || []).at(-1), file = (app.versions || []).at(-1);
  if (!file || !data) return !!file;
  return file.n >= data.n;
}

/** The app with its newest change taken back, to its data (`undone`) or to one of its files
 *  (`reverted`), decided under its lock. */
export const undo = (workspace: string, name: unknown): Promise<{ app: Json; undone?: Json; reverted?: Json }> =>
  updateWith(workspace, name, (app): Promise<{ next: Json; undone?: Json; reverted?: Json }> => (fileIsNewest(app) ? revertOn(app, app.versions.length - 1) : undoOn(app)), true);

/** app.json's text: the definition as app.json holds it. */
export const definitionText = (app: Json): string => JSON.stringify(definitionOf(app), null, 2) + "\n";

/** app.json read from `text` (its JSON text, or an object): `definition`, its app.json keys, and
 *  with `withData` its `data`. Each problem is added to `problems`; `definition` is missing when
 *  `text` isn't an object at all. */
export function definitionFrom(text: unknown, problems: string[], withData = false): { definition?: Json; data?: Json } {
  let value: Json = text;
  if (typeof text === "string") {
    try {
      value = JSON.parse(text);
    } catch (e) {
      problems.push(`app.json isn't JSON: ${(e as Error).message}`);
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    problems.push("app.json is an object");
    return {};
  }
  // A model sends one rule as a sentence rather than a list of one.
  if (typeof value.rules === "string") value = { ...value, rules: [value.rules] };
  const extra = Object.keys(value).filter((k) => !DEFINITION.includes(k) && !(withData && k === "data"));
  if (extra.length) problems.push(`app.json holds ${DEFINITION.join(", ")}; change the data with do, not ${extra.join(", ")}`);
  return { definition: definitionOf(value), ...(withData ? { data: value.data } : {}) };
}

/** The app's `file` as text: app.json, or page.html (null while it has none). */
const fileText = (app: Json, file: string): string | null => (file === "app.json" ? definitionText(app) : (app.page ?? null));

/** Refuses a `file` that isn't one of the app's own, to be read. */
function readableCheck(file: unknown): asserts file is string {
  if (["app.js", "app.css", "parts.js"].includes(file as string))
    throw new AppError(`${file} isn't one of the app's files: every page gets it inline. guide runtime explains App, guide styles is app.css, and guide <part> gives a part's code`);
  if (!FILES.includes(file as string)) throw new AppError(`file is ${FILES.join(" or ")}`);
}

/** One of the app's files as text: app.json, or page.html (null while it has none). */
export function readFile(workspace: string, name: unknown, file: unknown): string | null {
  readableCheck(file);
  return fileText(read(workspace, name), file);
}

/** `app` with one file replaced by `text` (null: no page.html), checked: app.json's keys, which its
 *  data must still fit, or page.html. */
async function withFile(app: Json, file: string, text: Json): Promise<Json> {
  const earlier: string[] = [];
  let next;
  if (file === "page.html") next = { ...app, page: text ?? undefined };
  else {
    const { definition } = definitionFrom(text, earlier);
    if (!definition) throw new AppError(earlier.join("; "));
    next = { ...Object.fromEntries(Object.entries(app).filter(([k]) => !DEFINITION.includes(k))), ...definition };
  }
  return checked({ ...next, changed: now() }, earlier, "saved", file === "page.html");
}

/** `app` with one file replaced, and the file as it was kept for undo when it changed. */
async function withVersion(app: Json, file: string, text: Json): Promise<Json> {
  const before = fileText(app, file);
  const next = await withFile(app, file, text);
  if (fileText(next, file) !== before) next.versions = [...(app.versions || []), { n: app.line || 0, t: next.changed, file, before }].slice(-VERSIONS);
  return next;
}

/** The app with one file replaced, and the file as it was kept for undo when it changed. */
export async function writeFile(workspace: string, name: unknown, file: unknown, text: Json): Promise<Json> {
  readableCheck(file);
  return update(workspace, name, (app) => withVersion(app, file, text), file === "page.html");
}

/** `app` with its version `at` (of app.json or page.html) put back, and that version. */
async function revertOn(app: Json, at: number): Promise<{ next: Json; reverted: Json }> {
  const versions: Json[] = app.versions;
  const reverted = versions[at];
  return { next: { ...(await withFile(app, reverted.file, reverted.before)), versions: [...versions.slice(0, at), ...versions.slice(at + 1)] }, reverted };
}

/** Where the newest change to `file` is in `app`'s versions; throws when there's none left. */
function versionIndex(app: Json, file: string): number {
  const at = (app.versions || []).map((v: Json) => v.file).lastIndexOf(file);
  if (at < 0) throw new AppError(`${app.name} has no change to ${file} left to take back`);
  return at;
}

/** The app with the newest change to `file` taken back, and that change. */
export async function revert(workspace: string, name: unknown, file: unknown): Promise<{ app: Json; reverted: Json }> {
  readableCheck(file);
  return updateWith(workspace, name, (app) => revertOn(app, versionIndex(app, file)), file === "page.html");
}

/** `app`'s `file` with `find`, found once, replaced with `text`; throws, with the file as it is, when
 *  it isn't found once. */
function edited(app: Json, file: string, find: unknown, text: unknown): string {
  const was = fileText(app, file);
  if (was === null) throw new AppError(`${app.name} has no ${file} yet: write it whole with edit`);
  if (typeof find !== "string" || !find) throw new AppError("edit needs find: text the file holds");
  const at = was.indexOf(find);
  // The file as it is comes with the refusal, so the next try needs no read first.
  if (at < 0) throw new AppError(`${file} doesn't hold that text. It is now:\n${was}`);
  if (was.indexOf(find, at + 1) >= 0) throw new AppError(`${file} holds that text more than once; give more of it, so it's found exactly once`);
  return was.slice(0, at) + String(text ?? "") + was.slice(at + find.length);
}

/** The app with `find` in one file replaced, once, with `text`. */
export async function editFile(workspace: string, name: unknown, file: unknown, find: unknown, text: unknown): Promise<Json> {
  readableCheck(file);
  return update(workspace, name, (app) => withVersion(app, file, edited(app, file, find, text)), file === "page.html");
}

/** The app with `fields` outside its data and history set, such as its page's token. */
export const mark = (workspace: string, name: unknown, fields: Json): Promise<Json> => update(workspace, name, (app) => ({ ...app, ...fields }));

/** The workspaces that have apps. */
export function workspaces(): string[] {
  try {
    return fs.readdirSync(root(), { withFileTypes: true }).filter((d) => d.isDirectory() && WORKSPACE.test(d.name)).map((d) => d.name);
  } catch {
    return [];
  }
}

/** How long a deleted app stays in the trash, from its deletion, and how many the trash holds. */
export const TRASH_DAYS = 30;
export const TRASH_MAX = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const trash = (): string => path.join(root(), ".trash");

/** When a trash file was deleted: its name starts with that, in ms (null for any other name). */
const deletedAt = (file: string): number | null => (/^\d{13}-/.test(file) ? Number(file.slice(0, 13)) : null);

/** Takes the app out of its workspace into the trash, where it stays TRASH_DAYS from now: a delete
 *  the user didn't mean can be put back by hand. Those past their days are swept first. A trash
 *  full of apps still within theirs refuses the delete, so deleting many apps can't push a real
 *  one out. */
export async function remove(workspace: string, name: unknown): Promise<void> {
  return withLock(workspace, name, () => {
    read(workspace, name);
    fs.mkdirSync(trash(), { recursive: true });
    return locked(`${trash()}.lock`, "the trash", () => {
      const now = Date.now();
      let held = fs.readdirSync(trash()).filter((f) => f.endsWith(".json")).sort();
      for (const f of held.filter((f) => (deletedAt(f) ?? now) < now - TRASH_DAYS * DAY_MS)) fs.rmSync(path.join(trash(), f), { force: true });
      held = held.filter((f) => fs.existsSync(path.join(trash(), f)));
      if (held.length >= TRASH_MAX) {
        const frees = deletedAt(held[0]);
        throw new AppError(
          `the trash is full: it holds ${held.length} deleted apps, each kept ${TRASH_DAYS} days, so ${name} stays${frees ? `; the oldest leaves the trash on ${new Date(frees + TRASH_DAYS * DAY_MS).toISOString().slice(0, 10)}` : ""}. The user can empty it by hand (apps-lean/.trash)`,
        );
      }
      // Named by when it was deleted, to the millisecond, so the trash's names sort oldest first.
      fs.renameSync(fileOf(workspace, name), path.join(trash(), `${String(now).padStart(13, "0")}-${workspace}-${name}.json`));
    });
  });
}
