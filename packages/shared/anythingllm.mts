// Where a skill finds AnythingLLM: its storage folder and its server folder. AnythingLLM's server
// code is not a public API: each skill types what it uses of it (its host.ts).

import fs from "node:fs";
import path from "node:path";

/** AnythingLLM's storage folder: STORAGE_DIR, which AnythingLLM sets, else the folder three above
 *  the bundled handler.js (storage/plugins/agent-skills/<hubId>); that fallback holds only for the
 *  bundle's location, so tests set STORAGE_DIR. */
export function storageDir(): string {
  if (process.env.STORAGE_DIR) return process.env.STORAGE_DIR;
  if (typeof __dirname !== "string") throw new Error("STORAGE_DIR isn't set");
  return path.resolve(__dirname, "..", "..", "..");
}

/** AnythingLLM's server folder: ANYTHINGLLM_SERVER_DIR, else the working directory AnythingLLM runs
 *  in (/app/server in its image). */
export const serverDir = (): string => process.env.ANYTHINGLLM_SERVER_DIR || process.cwd();

/** One value per process, made the first time: kept on globalThis, since AnythingLLM loads a
 *  skill's handler.js afresh for each agent run, and shared by every skill's bundled copy, and by
 *  every install of it while AnythingLLM runs. So a value whose shape changes needs a new key, or
 *  code that takes the old one over; a cache that can be made again belongs in perBuild. */
export function perProcess<T>(key: string, make: () => T): T {
  const g = globalThis as unknown as Record<symbol, T>;
  const at = Symbol.for(`anywherellm-suite.${key}`);
  if (!(at in g)) g[at] = make();
  return g[at];
}

/** One value per process and per build of the shared code (SHARED_STAMP, which build.mjs inlines):
 *  for a cache, which an install whose shared code changed makes afresh rather than read in an
 *  earlier build's shape. Not for what holds something live (a browser, a timer, a queue): that
 *  would be left running beside the new one. */
export const perBuild = <T,>(key: string, make: () => T): T => perProcess(`${key} ${typeof SHARED_STAMP === "string" ? SHARED_STAMP : "source"}`, make);

/** Runs `fn` after every earlier call with the same key in this process has finished. A key is
 *  kept only while calls with it are queued, so keys made from what the model names don't pile up. */
export function serial<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
  const queues = perProcess("serial", () => new Map<string, Promise<unknown>>());
  const run = (queues.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => queues.get(key) === tail && queues.delete(key));
  return run;
}

/** The suite's own folder in the storage: the pages' key. */
export const SUITE_DIR = "anywherellm-suite";

/** The browser-extension key the skills' pages post with, which install keeps in the storage
 *  (`install --page-key`): one the user made in AnythingLLM's Settings > Browser Extension. */
export const pageKeyFile = (storage: string): string => path.join(storage, SUITE_DIR, "page-key");

/** The pages' key, or "" when install was given none. */
export function readPageKey(storage: string): string {
  try {
    return fs.readFileSync(pageKeyFile(storage), "utf8").trim();
  } catch {
    return "";
  }
}

/** Where a skill's description (in its plugin.json, which AnythingLLM reads for each agent run)
 *  ends and what the skill holds now begins: the skill writes that part, so the model sees it on
 *  every turn, and install keeps it when it updates the skill. */
export const SAVED_NOW = "\n\nSaved now:";

/** What of `this` in a skill's handler tells where it was called from, and by whom. A chat in
 *  AnythingLLM's own web UI has the invocation's `uuid` and `thread_id`; one through its developer
 *  API has neither. */
export interface Invoked {
  super?: { handlerProps?: { invocation?: { workspace?: { slug?: string } | null; user_id?: number | null; uuid?: string | null; thread_id?: number | null } } };
}

/** The workspace a skill was called from, from AnythingLLM's invocation, never from what the model
 *  says; null for a call with none (a scheduled job's). */
export const workspaceOf = (self: Invoked | undefined): string | null => self?.super?.handlerProps?.invocation?.workspace?.slug || null;

/** AnythingLLM's address, as the user set it for a skill (its ANYTHINGLLM_URL setting), without a
 *  trailing slash; null when unset, and then a skill's page links are relative, which only
 *  AnythingLLM's own chat opens. */
export const baseUrlOf = (self: { runtimeArgs?: Record<string, string | undefined> } | undefined): string | null =>
  String(self?.runtimeArgs?.ANYTHINGLLM_URL ?? "").trim().replace(/\/+$/, "") || null;

/** The time a scheduled job has left, in the process AnythingLLM forks for each job's run
 *  (jobs/run-scheduled-job.js, which ends it at SCHEDULED_JOB_TIMEOUT_MS, 5 minutes by default), so
 *  the process's age is the job's; null in any other process. */
export function jobTimeLeft(): number | null {
  if (typeof process.send !== "function") return null;
  return (Number(process.env.SCHEDULED_JOB_TIMEOUT_MS) || 5 * 60 * 1000) - process.uptime() * 1000;
}
