// Where a skill finds AnythingLLM: its storage folder, and its server's own modules, which a skill
// requires by a path built at run time (so esbuild leaves them alone). AnythingLLM's server code is
// not a public API: each skill types what it uses of it (its host.ts).

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** AnythingLLM's storage folder: STORAGE_DIR, which AnythingLLM sets, else the folder three above
 *  the bundled handler.js (storage/plugins/agent-skills/<hubId>); that fallback holds only for the
 *  bundle's location, so tests set STORAGE_DIR. */
export function storageDir(): string {
  if (process.env.STORAGE_DIR) return process.env.STORAGE_DIR;
  if (typeof __dirname !== "string") throw new Error("STORAGE_DIR isn't set");
  return path.resolve(__dirname, "..", "..", "..");
}

/** AnythingLLM's server folder, whose modules a skill can require: ANYTHINGLLM_SERVER_DIR, else
 *  the working directory AnythingLLM runs in (/app/server in its image). */
export const serverDir = (): string => process.env.ANYTHINGLLM_SERVER_DIR || process.cwd();

/** One of AnythingLLM's server modules, such as "utils/PushNotifications". */
export function serverRequire<T>(what: string): T {
  return createRequire(path.join(serverDir(), "index.js"))(path.join(serverDir(), what)) as T;
}

/** One value per process, made the first time: kept on globalThis, since AnythingLLM loads a
 *  skill's handler.js afresh for each agent run, and shared by every skill's bundled copy. */
export function perProcess<T>(key: string, make: () => T): T {
  const g = globalThis as unknown as Record<symbol, T>;
  const at = Symbol.for(`anythingllm-suite.${key}`);
  if (!(at in g)) g[at] = make();
  return g[at];
}

/** Runs `fn` after every earlier call with the same key in this process has finished. */
export function serial<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
  const queue = perProcess(`serial.${key}`, () => ({ tail: Promise.resolve() as Promise<unknown> }));
  const run = queue.tail.then(fn);
  queue.tail = run.catch(() => {});
  return run;
}

/** The suite's own folder in the storage: the control server, and the pages' key. */
export const SUITE_DIR = "anythingllm-suite";

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

/** What of `this` in a skill's handler tells where it was called from, and by whom. */
export interface Invoked {
  super?: { handlerProps?: { invocation?: { workspace?: { slug?: string } | null; user_id?: number | null } } };
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

/** Whom a push goes to: the user who called (multi-user mode), else AnythingLLM's "primary". */
export const pushTo = (self: Invoked | undefined): string | number => self?.super?.handlerProps?.invocation?.user_id ?? "primary";

/** AnythingLLM's web push (utils/PushNotifications), as far as a skill uses it. */
interface PushService {
  loadSubscriptions(): Promise<unknown>;
  sendNotification(n: { to: string | number; payload: { title: string; body: string; data?: { onClickUrl?: string } } }): Promise<unknown>;
}

/** Pushes a notification to the browsers where the user switched AnythingLLM's notifications on
 *  (none when they haven't); `url` is the page it opens. Loads the subscriptions first, as a job's
 *  process does, since the service's are loaded only in the process that booted it. */
export async function push(to: string | number, note: { title: string; body: string; url: string }): Promise<void> {
  const { pushNotificationService: service } = serverRequire<{ pushNotificationService: PushService }>("utils/PushNotifications");
  await service.loadSubscriptions();
  await service.sendNotification({ to, payload: { title: note.title, body: note.body, data: { onClickUrl: note.url } } });
}
