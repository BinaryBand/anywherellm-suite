// Putting the suite on this machine.
//
// install     the control server and the skills into an AnythingLLM's storage folder, where
//             AnythingLLM runs them itself (addons.mts), and the key their pages post with when
//             given one (--page-key)
// uninstall   all of that taken out again
// health      every check; false when one fails
//
// The storage is the one named, else the one install was last given (ANYTHINGLLM_STORAGE in
// `install.env`, in the user's settings folder: `~/.config/anywherellm-suite` on Linux), else
// AnythingLLM Desktop's when it is there. The runtime and the roles are the ones named, else those of the entry already
// there, else native for Desktop's storage and container for any other, and the chat role.

import fs from "node:fs";
import path from "node:path";
import { readPageKey } from "#shared/anythingllm";
import { invalid } from "#shared/errors";
import { readEnv, saveEnv } from "#shared/envfile";
import { configDir, desktopStorage, expandHome, pathsOf, samePath, type Place } from "#shared/paths";
import { DEFAULT_ROLES, ROLES } from "#shared/roles";
import { ANYTHINGLLM_PORT, request } from "#shared/upstream";
import { checks, chosen, current, entry, INNER_STORAGE, NAME, needsPageKey, put, putPageKey, take, type Check, type Payload, type Runtime } from "./addons.mts";

/** This machine: its home, environment and OS (a test may say another), and what install needs. */
export interface Ctx extends Place {
  print: (line: string) => void;
  /** The node that runs the control server for a native AnythingLLM: the one running this. */
  node: string;
  /** What install puts into the storage. */
  payload: Payload;
}

export interface Options {
  storage?: string;
  runtime?: Runtime;
  roles?: string[];
  /** Skill names, "all" or "none"; all when not given. */
  skills?: string[];
  /** The browser-extension key the skills' pages post with, made in AnythingLLM's Settings > Browser Extension. */
  pageKey?: string;
}

const RUNTIMES: Runtime[] = ["container", "native"];

const HEADER = ["# anywherellm-suite's installer: the storage `install` was last given, which `uninstall` and", "# `health` use when given none."];

/** The installer's settings file. */
export const settingsFile = (place: Place): string => pathsOf(place.platform).join(configDir("anywherellm-suite", place), "install.env");

/** The storage install was last given, if any. */
const remembered = (place: Place): string | null => readEnv(settingsFile(place)).ANYTHINGLLM_STORAGE || null;

/** The storage to use, or a refusal that says how to find it. */
function storageFor(ctx: Ctx, asked: string | undefined): string {
  const desktop = desktopStorage(ctx);
  const where = asked ? path.resolve(expandHome(asked, ctx.home)) : (remembered(ctx) ?? (fs.existsSync(desktop) ? desktop : null));
  if (!where) {
    throw invalid(
      `say which AnythingLLM: --storage DIR. For Docker, the folder mounted at ${INNER_STORAGE} (a named volume isn't reachable from here; use a bind mount). AnythingLLM Desktop's would be ${desktop}, and there is none.`,
    );
  }
  if (!fs.existsSync(path.join(where, "anythingllm.db")) && !fs.existsSync(path.join(where, "plugins"))) throw invalid(`${where} doesn't look like AnythingLLM's storage`);
  return where;
}

export async function install(ctx: Ctx, opts: Options): Promise<void> {
  if (opts.runtime && !RUNTIMES.includes(opts.runtime)) throw invalid(`--runtime is container or native, not ${opts.runtime}`);
  const unknown = (opts.roles ?? []).filter((r) => !ROLES.includes(r));
  if (unknown.length || opts.roles?.length === 0) throw invalid(`--roles is one or more of ${ROLES.join(", ")}${unknown.length ? `, not ${unknown.join(", ")}` : ""}`);
  if (opts.pageKey !== undefined && !/^brx-\S+$/.test(opts.pageKey)) throw invalid(`--page-key is a browser-extension key (brx-...), as AnythingLLM's Settings > Browser Extension makes one`);
  const skills = chosen(ctx.payload, opts.skills);
  const storage = storageFor(ctx, opts.storage);
  const was = current(storage);
  const runtime = opts.runtime ?? was?.runtime ?? (samePath(ctx.platform, storage, desktopStorage(ctx)) ? "native" : "container");
  const roles = opts.roles ?? was?.roles ?? DEFAULT_ROLES;
  ctx.print(`AnythingLLM's storage: ${storage} (${runtime === "container" ? `a container's, seen there as ${INNER_STORAGE}` : "AnythingLLM runs on this machine"})`);
  for (const line of put(storage, ctx.payload, entry(runtime, storage, roles, ctx.node), skills)) ctx.print(line);
  if (opts.pageKey) ctx.print(putPageKey(storage, opts.pageKey));
  saveEnv(settingsFile(ctx), { ANYTHINGLLM_STORAGE: storage }, HEADER);
  leftForYou(ctx, runtime, needsPageKey(storage, ctx.payload) && !readPageKey(storage));
}

/** What install could not do for the owner. */
function leftForYou(ctx: Ctx, runtime: Runtime, askKey: boolean): void {
  ctx.print("\nLeft for you:");
  ctx.print(`- In AnythingLLM, Settings > Agent Skills: refresh the MCP servers (or restart AnythingLLM) so it starts \`${NAME}\`, and switch on the skills you want.`);
  if (askKey) ctx.print(`- The skills' pages need a key to post with: make one in AnythingLLM's Settings > Browser Extension, then run install again with --page-key <key>.`);
  if (runtime === "native") ctx.print(`- The entry starts the server with ${ctx.node}; run install again if that Node moves.`);
}

export function uninstall(ctx: Ctx, opts: { storage?: string } = {}): void {
  const storage = opts.storage ? path.resolve(expandHome(opts.storage, ctx.home)) : remembered(ctx);
  if (storage) for (const line of take(storage, ctx.payload)) ctx.print(line);
  else ctx.print("No storage is known: name it with --storage to take the control server and the skills out.");
  saveEnv(settingsFile(ctx), { ANYTHINGLLM_STORAGE: null }, HEADER);
  if (storage) ctx.print("A skill's data stays in the storage (the library's in library-lean/).");
}

/** Every health check; false when one failed. */
export async function health(ctx: Ctx): Promise<boolean> {
  const storage = remembered(ctx);
  const found: Check[] = storage ? [["AnythingLLM's storage", fs.existsSync(storage), storage], ...checks(storage, ctx.payload)] : [["AnythingLLM's storage", false, "not set: run install"]];
  if (storage && needsPageKey(storage, ctx.payload)) found.push(await pageKeyCheck(storage, (ctx.env.ANYTHINGLLM_URL || `http://127.0.0.1:${ANYTHINGLLM_PORT}`).replace(/\/+$/, "")));
  for (const [what, ok, detail] of found) ctx.print(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  return found.every(([, ok]) => ok);
}

/** Whether install kept a key for the pages, and AnythingLLM takes it (the browser extension's own check). */
async function pageKeyCheck(storage: string, anythingllmUrl: string): Promise<Check> {
  const name = "the pages' key";
  const key = readPageKey(storage);
  if (!key) return [name, false, "none: make one in AnythingLLM's Settings > Browser Extension, then run install --page-key <key>"];
  try {
    const { status } = await request(`${anythingllmUrl}/api/browser-extension/check`, { token: key, timeout: 5_000 });
    return [name, status === 200, status === 200 ? "" : `AnythingLLM refuses it (${status}): make a new one and run install --page-key again`];
  } catch (e) {
    return [name, false, `not checked: ${(e as Error).message} (${anythingllmUrl}; set ANYTHINGLLM_URL)`];
  }
}
