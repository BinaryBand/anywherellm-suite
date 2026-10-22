// Apps: small things a user keeps in a workspace (a list, habits, a calendar, anything with a JSON
// shape), kept by this skill alone inside AnythingLLM's storage, with no server of its own. Each
// call works on the workspace AnythingLLM invoked it from and answers text for the agent, with the
// app's card in Markdown to put in its reply.

import { Told } from "#shared/errors";
import { card, headline } from "./card.ts";
import type { HandlerContext } from "./host.ts";
import * as manager from "./manager.ts";
import { caughtUp, keepWatching, news, pageUrl, publish, refresh, unpublish, upgrade } from "./page.ts";
import type { Json } from "./patch.ts";
import * as parts from "./parts.ts";
import { withDefaults } from "./schema.ts";
import { scopeOf, type Scope } from "./scope.ts";
import * as store from "./store.ts";
import { AppError } from "./store.ts";

type Args = Record<string, Json>;
type Action = (scope: Scope, p: Args, self: HandlerContext) => string | Promise<string>;

const NO_STARTER = ["blank", "custom", "none", "empty"];
const RECENT = 5;

/** A value the model may have sent as JSON text, read as JSON. */
function asJson(value: Json, what: string): Json {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new AppError(`${what} must be JSON`);
  }
}

/** The address the user's browser reaches AnythingLLM at, from the skill's settings. */
function baseOf(self: HandlerContext): string | null {
  const base = String(self?.runtimeArgs?.ANYTHINGLLM_URL || "").trim();
  return /^https?:\/\/[^\s/]+/.test(base) ? base : null;
}

// A sentence leads into the card rather than a label: a model copies a label line ("Card:") into
// its reply along with the card.
const cardBlock = (app: Json, url: string | null): string[] => ["", "Put the card below in your reply exactly as given, with no label or heading.", ...card(app, url)];
/** The address of an app's page once it has one: under AnythingLLM's address when it's set, else
 *  relative, which AnythingLLM's own chat opens. */
const urlOf = (self: HandlerContext, app: Json): string | null => pageUrl(app.pageToken, baseOf(self));
const cardOf = (self: HandlerContext, app: Json): string[] => cardBlock(app, urlOf(self, app));

/** What the agent should still fix about an app's page, as lines; none when nothing. */
const advice = (app: Json): string[] => [parts.colourNote(app.page, app.rules)].filter(Boolean);

/** How to make a new app, which list answers with, since the agent lists first. */
const MAKING = (): string[] => [
  `To make one: if a starter fits (${Object.keys(parts.starters()).join(", ")}), create with starter, title and the user's first data: a whole app, ready to give them.`,
  "Otherwise guide, then guide once with every part you'll use, then create with a template, the parts, text (app.json: about, rules, card) and a plan, and fit it with edit.",
  "Make one app; a second only if the user asks.",
];

const PLAN_MIN = 40;
const PLAN_MAX = 600;
/** What a plan covers, which a create without a starter is refused with when it has none: the
 *  things an agent building from scratch overlooks, since nothing else makes it stop. */
const PLAN_NEEDS =
  `plan: ${PLAN_MIN}-${PLAN_MAX} characters on how you'll build this, covering what the app keeps; data it needs from outside (a word list, rules) and how you'll get it: with the workspace's web skills first if it has them, or by the page fetching it, rather than from memory; ` +
  "how time works (nothing runs while the page is closed: something daily is worked out from the date in the page); whether it is used on more than one device (each open page shows the others' changes within seconds); " +
  "logic you can't run here (there is no browser check) and how you checked it by hand; and anything to tell the user";

const changeLine = (h: Json): string => `- ${h.t} ${h.ev}${h.fields ? ` ${JSON.stringify(h.fields)}` : ""}`;

const ACTIONS = {
  list: async ({ workspace }, _p, self) => {
    const apps = store.list(workspace);
    const listed = apps.length
      ? ["This workspace's apps (change one that fits rather than making another):", ...apps.map((a) => (a.broken ? `- ${a.name}: can't be read` : `- ${a.name}: ${headline(a, urlOf(self, a))}`))]
      : ["This workspace has no apps yet."];
    const all = await manager.line(baseOf(self));
    return [...listed, "", ...MAKING(), ...(all ? ["", all] : [])].join("\n");
  },
  create: async ({ workspace }, p, self) => {
    // A starter (or a template named like one) makes a working app; else a template with the
    // components in parts composed in, their schemas merged and their first data; text (app.json)
    // adds to or replaces what those give. Every problem comes back at once, so one more call can
    // fix them all.
    const problems: string[] = [];
    const json = (value: Json, what: string) => {
      try {
        return asJson(value, what);
      } catch (e) {
        problems.push((e as Error).message);
        return undefined;
      }
    };
    const given = p.text;
    const { definition = {}, data: inText } = given === undefined ? {} : store.definitionFrom(given, problems, true);
    // A model reaches for "blank" or "custom" to mean no starter: a template and parts then.
    const starter = NO_STARTER.includes(String(p.starter).toLowerCase()) ? undefined : p.starter;
    const named = starter !== undefined ? (parts.starterNamed(starter) ?? starter) : parts.starterNamed(p.template);
    const used = typeof p.parts === "string" && !p.parts.trim().startsWith("[") ? p.parts.split(/[\s,]+/).filter(Boolean) : (json(p.parts, "parts") ?? []);
    let base: Json = null;
    if (named !== undefined) {
      base = parts.starter(named);
      if (!base) problems.push(`starter must be one of: ${Object.keys(parts.starters()).join(", ")}`);
    } else {
      if (given === undefined && !used.length) problems.push("create needs starter, or a template with parts (components), or text: app.json's about, rules, schema and card");
      try {
        const template = p.template || parts.DEFAULT_TEMPLATE;
        const made = parts.assemble(template, used);
        base = { template, parts: used, definition: used.length ? { schema: made.schema } : {}, data: made.data, page: made.page };
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    // Last, so the other problems read as they did; a starter is known to work and needs none.
    const chars = typeof p.plan === "string" ? [...p.plan.trim()] : [];
    if (named === undefined && (chars.length < PLAN_MIN || chars.length > PLAN_MAX)) problems.push(PLAN_NEEDS);
    const plan = chars.slice(0, PLAN_MAX).join("");
    const object = (v: Json) => v && typeof v === "object" && !Array.isArray(v);
    const sent = json(p.data, "data") ?? inText;
    const schema = definition.schema ?? base?.definition.schema;
    const { value: data, filled } = object(sent) ? withDefaults({ ...base?.data, ...sent }, schema) : { value: sent ?? base?.data, filled: [] as string[] };
    const name = p.name ?? store.freeName(workspace, p.title || definition.title || named);
    const made = await store.create(
      workspace,
      name,
      { card: {}, ...base?.definition, ...definition, title: p.title || definition.title || base?.definition.title || name, data, page: base?.page, ...(plan ? { plan } : {}) },
      problems,
    );
    const how =
      named !== undefined
        ? `from the ${named} starter: the ${base.template} template with ${parts.partsText(base.parts)}, working as it is.`
        : used.length
          ? `from the ${base.template} template with ${parts.partsText(used)}: composed, their schemas merged and their first data in.`
          : `from the ${base.template} template, which holds no components yet: put each one's markup at <!--slot--> and its script at <!--scripts-->.`;
    // The page goes up as the app is made, and is written again after every change, so its link can
    // go in the reply that makes the app; an agent left to call page for it may not.
    // With no key for the pages there's no page yet: page says why.
    const url = pageUrl(await publish(made, workspace).catch((e) => (e instanceof Told ? null : Promise.reject(e))), baseOf(self));
    const defaults = filled.length ? [`Filled in what the data left out: ${filled.join(", ")}, with false, 0 or [].`] : [];
    const at = url ? [`Its page is at ${url} and follows every change; the card's title opens it.`] : [];
    // A starter is finished as made: its reply leaves out the page, which only invites rewriting it, and
    // says to stop, since an agent told to fit an app goes on editing one that already works.
    if (named !== undefined)
      return [
        `Made the app ${made.name}: ${made.title}, ${how} It's ready: give the user the card and one sentence on what it does. Change it (do for the data, edit for page.html) only for something they asked that it doesn't do yet.`,
        ...defaults,
        ...at,
        "",
        "app.json:",
        store.definitionText(made),
        ...cardBlock(made, url),
      ].join("\n");
    return [
      `Made the app ${made.name}: ${made.title}, ${how} Fit it to what the user asked with edit (page.html, app.json) and do (the data)${url ? "." : ", then give them the page."}`,
      ...defaults,
      ...at,
      "",
      "app.json:",
      store.definitionText(made),
      "page.html:",
      made.page,
      "Before giving the user the page:",
      parts.guide("finish"),
      ...cardBlock(made, url),
    ].join("\n");
  },
  do: async ({ workspace, job, named }, p, self) => {
    const patch = asJson(p.patch, "patch");
    const fields = asJson(p.fields, "fields");
    const app = await store.change(workspace, p.name, { patch, ev: p.ev, fields, by: job ? "job" : undefined, jobsOnly: named });
    return [`Done: ${app.history[app.history.length - 1].ev} on ${app.name}.`, ...cardOf(self, app)].join("\n");
  },
  read: ({ workspace }, p, self) => {
    if (p.file) {
      const text = store.readFile(workspace, p.name, p.file);
      return text === null
        ? `${p.name} has no ${p.file} yet; write it from a template (guide).`
        : `${p.name}'s ${p.file} (change it with edit: a find and its text, or the whole file with no find):\n${text}`;
    }
    const app = store.read(workspace, p.name);
    const history: Json[] = app.history || [];
    return [
      `${app.name}'s app.json: ${JSON.stringify(parts.definitionOf(app))}`,
      `Line ${app.line || 0}, made ${app.made}, changed ${app.changed}${app.page ? "; read with file page.html gives the page" : "; it has no page.html yet"}.`,
      ...(app.plan ? [`Plan: ${app.plan}`] : []),
      `Data: ${JSON.stringify(app.data)}`,
      history.length ? `Newest changes (${history.length} kept; undo takes back the newest, to the data or a file):` : "No changes yet.",
      ...history.slice(-RECENT).reverse().map(changeLine),
      ...(app.versions?.length ? ["Earlier files (undo with file takes back the newest change to one):", ...app.versions.slice(-RECENT).reverse().map((v: Json) => `- ${v.t} ${v.file}`)] : []),
      ...cardOf(self, app),
    ].join("\n");
  },
  page: async ({ workspace }, p, self) => {
    const app = store.read(workspace, p.name);
    if (!app.page) return `${app.name} has no page.html yet: write one from a template and its components (guide), then try again.`;
    const url = pageUrl(await publish(app, workspace), baseOf(self));
    if (!url)
      return [
        `${app.title}'s page can't be published here: AnythingLLM's public folder can't be written (as in AnythingLLM Desktop). The app works from the chat with do; tell the user its page isn't available on this instance.`,
        ...cardOf(self, app),
      ].join("\n");
    const outside = baseOf(self) ? "" : " The link opens from AnythingLLM's own chat; for one that opens anywhere, such as a phone, the user sets AnythingLLM's address in Agent Skills, under Apps, as ANYTHINGLLM_URL.";
    return [
      `${app.title}'s page is at ${url}. It always shows the app as it is now, and saves taps back to AnythingLLM; they reach the app the next time any Apps action runs.${outside}`,
      ...cardBlock(app, url),
    ].join("\n");
  },
  undo: async ({ workspace }, p, self) => {
    const { app: next, undone, reverted }: Awaited<ReturnType<typeof store.undo>> = p.file ? await store.revert(workspace, p.name, p.file) : await store.undo(workspace, p.name);
    if (reverted) return [`Put back ${next.name}'s ${reverted.file} as it was before its change at ${reverted.t}.`, ...cardOf(self, next)].join("\n");
    return [`Took back ${undone.ev} (${undone.t}) on ${next.name}.`, ...cardOf(self, next)].join("\n");
  },
  edit: async ({ workspace }, p, self) => {
    const whole = p.find === undefined || p.find === "";
    const app = whole ? await store.writeFile(workspace, p.name, p.file, p.text) : await store.editFile(workspace, p.name, p.file, p.find, p.text);
    return [`${whole ? "Wrote" : "Changed"} ${app.name}'s ${p.file}.`, ...advice(app), ...cardOf(self, app)].join("\n");
  },
  delete: async ({ workspace }, p) => {
    const app = store.read(workspace, p.name);
    await store.remove(workspace, app.name);
    unpublish(app);
    return `Deleted the app ${app.name}, its changes and its page. It stays in the trash ${store.TRASH_DAYS} days, and the user restores it from there on the apps manager if they want it back.`;
  },
  guide: (_scope, p) => {
    const topic = String(p.query || "").trim();
    if (!topic) return parts.file("guide.md") + "\n" + parts.guide();
    try {
      return parts.guide(topic);
    } catch (e) {
      throw new AppError((e as Error).message);
    }
  },
} satisfies Record<string, Action>;

/** What each action is, for the rules around it:
 *  - job: what a scheduled job may do with it. A job's prompt is the user's, but what it reads on
 *    the way (a mail, a page) isn't, so in a workspace it names a job can only read, and change the
 *    data of an app that takes jobs; it can't make, rewrite, take back or delete an app there, or
 *    write a page's script. "own": only in its own workspace (_jobs); "named": in a workspace it
 *    names too; "app": there, only on an app whose app.json says "jobs": true; "never": not at all.
 *  - changes: it changes the app it names, whose page is written again after.
 *  - quiet: it reads no app, so what pages posted isn't taken first, nor what they did said. */
interface Rule {
  job: "own" | "named" | "app" | "never";
  changes?: true;
  quiet?: true;
}
const RULES: { [action in ActionName]: Rule } = {
  list: { job: "named" },
  create: { job: "own" },
  do: { job: "app", changes: true },
  read: { job: "named" },
  page: { job: "own" },
  undo: { job: "own", changes: true },
  edit: { job: "own", changes: true },
  delete: { job: "never" },
  guide: { job: "named", quiet: true },
};

/** The workspace a call works on: AnythingLLM's for a chat; for a scheduled job, which AnythingLLM
 *  gives none, its own (_jobs) or one it names, as RULES let it. Throws what it may not do. */
type ActionName = keyof typeof ACTIONS;
const isAction = (name: string): name is ActionName => Object.hasOwn(ACTIONS, name);
/** What a job may do in a workspace it names, in words, from RULES. */
const NAMED = Object.entries(RULES).filter(([, r]) => r.job === "named" || r.job === "app").map(([a]) => a).join(", ");

function scopeFor(self: HandlerContext, action: ActionName, p: Args): Scope {
  const scope = scopeOf(self);
  const named = typeof p.workspace === "string" && p.workspace.trim() ? p.workspace.trim() : null;
  if (!scope.job) {
    if (named) throw new AppError("workspace is for a scheduled job: a chat works on its own workspace's apps, so leave it out");
    return scope;
  }
  const { job } = RULES[action];
  if (job === "never") throw new AppError(`a scheduled job can't ${action}: the user does that from a chat`);
  if (!named) return scope;
  if (job === "own") throw new AppError(`in a workspace it names, a scheduled job may ${NAMED}, not ${action}: ask the user to do that from a chat`);
  // "app": the store checks the app takes jobs, in the same locked pass as the change.
  return { workspace: named, job: true, named: true };
}

async function run(self: HandlerContext, params: Args): Promise<string> {
  const action = String(params.action || "list");
  if (!isAction(action)) throw new AppError(`action is one of ${Object.keys(ACTIONS).join(", ")}`);
  const act: Action = ACTIONS[action];
  const rule = RULES[action];
  const scope = scopeFor(self, action, params);
  // Pages' changes are applied as they land, by a watch that lasts as long as AnythingLLM's process;
  // a call takes what's waiting first, so it reads every app as its pages left it.
  keepWatching();
  manager.keepWatching();
  if (!rule.quiet) {
    // What the manager and the pages posted, before upgrade writes the pages again.
    await manager.settle();
    await manager.caughtUp();
    await caughtUp();
    // A job's process ends within minutes and starts afresh each run: the chat's does this.
    if (!scope.job) await upgrade();
  }
  const reply = await act(scope, params, self);
  if (rule.changes && params.name) await refresh(scope.workspace, params.name);
  // The manager shows every app as it is now: a chat call makes it the first time, and its state is
  // written again after a call that may have changed an app (all but read and list).
  if (!rule.quiet) {
    if (!scope.job) await manager.show(baseOf(self));
    if (action !== "read" && action !== "list") manager.refresh();
  }
  // What pages did is said once, in the workspace's next chat call; a scheduled job is told none.
  const lines = rule.quiet || scope.job ? [] : await news(scope.workspace);
  return lines.length ? [...lines, "", reply].join("\n") : reply;
}

export const runtime = {
  handler: async function (this: HandlerContext, params: Args = {}): Promise<string> {
    try {
      // Models fill parameters they don't mean with null: one left out.
      return await run(this, Object.fromEntries(Object.entries(params || {}).filter(([, v]) => v !== null)));
    } catch (e) {
      if (e instanceof Told) return `Apps: ${e.message}`;
      this?.logger?.(`apps-lean: ${(e as Error)?.stack || e}`);
      return `Apps failed: ${(e as Error)?.message || e}`;
    }
  },
};
