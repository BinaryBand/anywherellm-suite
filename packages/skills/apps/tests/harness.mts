// What the apps tests share: AnythingLLM's storage, public folder standing in,
// the skill's static files as the build inlines them (for the tests that import a module from src),
// the built handler.js called as AnythingLLM's agent calls it, what a page posts, written as
// AnythingLLM's collector writes it, and sample apps as an agent would create them.

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { pageKeyFile } from "#shared/anythingllm";
import { writeAtomic } from "#shared/atomic";
import { eventsDir as eventsDirOf } from "#shared/pages";
import { postEvent } from "#shared/test-helpers";
import { staticFiles } from "../../../build.mjs";

const require = createRequire(import.meta.url);
export const testsDir = path.dirname(fileURLToPath(import.meta.url));
export const skillDir = path.join(testsDir, "..");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "apps-lean-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
export const storage = path.join(tmp, "storage");
export const publicDir = path.join(tmp, "public");
export const root = path.join(storage, "apps-lean");
export const eventsDir = eventsDirOf(storage);
process.env.STORAGE_DIR = storage;
process.env.ANYTHINGLLM_PUBLIC_DIR = publicDir;
writeAtomic(pageKeyFile(storage), "brx-test\n"); // the pages' key, as `install --page-key` keeps it

// The static/ folder as build.mjs inlines it, for the modules a test imports from src.
(globalThis as unknown as { STATIC_FILES: Record<string, string> }).STATIC_FILES = staticFiles(path.join(skillDir, "static"), "apps");

const bundle = path.join(skillDir, "build", "apps-lean", "handler.js");
export type Handler = (this: unknown, args: Record<string, unknown>) => Promise<string>;
/** The built handler, loaded afresh as AnythingLLM loads it for each agent run. */
export const handler = (): Handler => {
  delete require.cache[bundle];
  return require(bundle).runtime.handler;
};

/** An agent's `this` for a call made from the workspace `slug`, with the skill's settings. */
export const inWorkspace = (slug: string, runtimeArgs: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({
  super: { handlerProps: { invocation: { workspace: { slug } } } },
  runtimeArgs,
  ...extra,
});

/** Calls the skill from the workspace `slug`, as AnythingLLM's agent would. */
export const call = (slug: string, params: Record<string, unknown>, runtimeArgs: Record<string, string> = {}): Promise<string> =>
  handler().call(inWorkspace(slug, runtimeArgs), params);

/** An event document as AnythingLLM's raw-text upload writes it (#shared/test-helpers postEvent):
 *  `event` as the page posts it, or `raw` as the text. */
export const post = (event: Record<string, unknown>, raw: string | null = null): void => postEvent(storage, "apps-lean-event", { apps_lean_event: 1, ...event }, raw ?? undefined);

/** What a page posts for `app`: its event with the app's secret, as the page has it. */
export const from = (workspace: string, app: string, event: Record<string, unknown>): void =>
  post({ workspace, app, secret: JSON.parse(fs.readFileSync(path.join(root, workspace, `${app}.json`), "utf8")).secret, ...event });

/** Forgets every app, page and event between tests. */
export function reset(): void {
  for (const dir of [root, path.join(storage, "documents"), publicDir]) fs.rmSync(dir, { recursive: true, force: true });
}

/** A plan long enough for create without a starter, as an agent would write one. */
export const PLAN = "Keeps the items and whether each is done. Needs nothing from outside. No time logic. One device. Nothing to test by hand.";

// Sample apps: a list, a habit tracker and a calendar, each app.json's keys with its first data.
export const SAMPLES: Record<string, Record<string, any>> = {
  list: {
    title: "List",
    about: "A list of things to do or get, each ticked off when done.",
    rules: ["One item per thing: {text, done}.", "Tick an item rather than removing it, unless the user asks to remove it."],
    schema: {
      type: "object",
      required: ["items"],
      properties: {
        items: { type: "array", items: { type: "object", required: ["text", "done"], properties: { text: { type: "string", minLength: 1 }, done: { type: "boolean" } } } },
      },
    },
    card: { items: "/items" },
    data: { items: [] },
  },
  tracker: {
    title: "Habits",
    about: "Daily habits, each with a target and the amount done on each day.",
    rules: ["Up to five habits.", "days maps a date (YYYY-MM-DD, the user's own day) to the amount done that day."],
    schema: {
      type: "object",
      required: ["habits"],
      properties: {
        habits: {
          type: "array",
          maxItems: 5,
          items: {
            type: "object",
            required: ["id", "name", "target", "days"],
            properties: {
              id: { type: "string", pattern: "^[a-z0-9-]+$" },
              name: { type: "string", minLength: 1 },
              target: { type: "number", exclusiveMinimum: 0 },
              unit: { type: "string" },
              days: { type: "object", additionalProperties: { type: "number", minimum: 0 } },
            },
          },
        },
      },
    },
    card: { items: "/habits", text: "name", summary: "{/habits/length} habits" },
    data: { habits: [] },
  },
  calendar: {
    title: "Calendar",
    about: "Events on dates, each with an optional time.",
    rules: ["Keep events in date order.", "date is YYYY-MM-DD and time HH:MM, in the user's own zone."],
    schema: {
      type: "object",
      required: ["events"],
      properties: {
        events: {
          type: "array",
          items: {
            type: "object",
            required: ["date", "title"],
            properties: {
              date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
              time: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
              title: { type: "string", minLength: 1 },
            },
          },
        },
      },
    },
    card: { items: "/events", text: "title", summary: "{/events/length} events" },
    data: { events: [] },
  },
};

/** The definition and data an app starts with. */
export function definitionFor(sample = "list", { title }: { title?: string } = {}): Record<string, any> {
  const base = SAMPLES[sample];
  if (!base) throw new Error(`sample is one of ${Object.keys(SAMPLES).join(", ")}`);
  return { ...structuredClone(base), ...(title ? { title } : {}) };
}

/** Calls the skill as a scheduled job does: AnythingLLM gives it no workspace. */
export const asJob = (params: Record<string, unknown>): Promise<string> => handler().call({ super: { handlerProps: { invocation: { workspace: null } } }, runtimeArgs: {} }, params);
