// Putting the suite on this machine.
//
// install     the control server and the skills into an AnythingLLM's storage folder, where
//             AnythingLLM runs them itself (addons.mts), and the key their pages post with when
//             given one (--page-key)
// uninstall   all of that taken out again
// health      every check; false when one fails
//
// Each takes the storage named (--storage), else AnythingLLM Desktop's when it is there; nothing is
// remembered between commands. The runtime and the roles are the ones named, else those of the
// entry already there, else native for Desktop's storage and container for any other, and the chat
// role.

import fs from "node:fs";
import path from "node:path";
import { readPageKey } from "#shared/anythingllm";
import { Told } from "#shared/errors";
import { desktopStorage, expandHome, samePath, type Place } from "./paths.mts";
import { DEFAULT_ROLES, ROLES } from "#shared/roles";
import { anythingllmUrl, request } from "#shared/upstream";
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

/** The storage to use, or a refusal that says how to find it. */
function storageFor(ctx: Ctx, asked: string | undefined): string {
  const desktop = desktopStorage(ctx);
  const where = asked ? path.resolve(expandHome(asked, ctx.home)) : (fs.existsSync(desktop) ? desktop : null);
  if (!where) {
    throw new Told(
      `say which AnythingLLM: --storage DIR. For Docker, the folder mounted at ${INNER_STORAGE} (a named volume isn't reachable from here; use a bind mount). AnythingLLM Desktop's would be ${desktop}, and there is none.`,
    );
  }
  if (!fs.existsSync(path.join(where, "anythingllm.db")) && !fs.existsSync(path.join(where, "plugins"))) throw new Told(`${where} doesn't look like AnythingLLM's storage`);
  return where;
}

export async function install(ctx: Ctx, opts: Options): Promise<void> {
  if (opts.runtime && !RUNTIMES.includes(opts.runtime)) throw new Told(`--runtime is container or native, not ${opts.runtime}`);
  const unknown = (opts.roles ?? []).filter((r) => !ROLES.includes(r));
  if (unknown.length || opts.roles?.length === 0) throw new Told(`--roles is one or more of ${ROLES.join(", ")}${unknown.length ? `, not ${unknown.join(", ")}` : ""}`);
  if (opts.pageKey !== undefined && !/^brx-\S+$/.test(opts.pageKey)) throw new Told(`--page-key is a browser-extension key (brx-...), as AnythingLLM's Settings > Browser Extension makes one`);
  const skills = chosen(ctx.payload, opts.skills);
  const storage = storageFor(ctx, opts.storage);
  const was = current(storage);
  const runtime = opts.runtime ?? was?.runtime ?? (samePath(ctx.platform, storage, desktopStorage(ctx)) ? "native" : "container");
  const roles = opts.roles ?? was?.roles ?? DEFAULT_ROLES;
  ctx.print(`AnythingLLM's storage: ${storage} (${runtime === "container" ? `a container's, seen there as ${INNER_STORAGE}` : "AnythingLLM runs on this machine"})`);
  for (const line of put(storage, ctx.payload, entry(runtime, storage, roles, ctx.node), skills)) ctx.print(line);
  if (opts.pageKey) ctx.print(putPageKey(storage, opts.pageKey));
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
  for (const line of take(storageFor(ctx, opts.storage), ctx.payload)) ctx.print(line);
  ctx.print("A skill's data stays in the storage (the library's in library-lean/).");
}

/** Every health check; false when one failed. */
export async function health(ctx: Ctx, opts: { storage?: string } = {}): Promise<boolean> {
  const storage = storageFor(ctx, opts.storage);
  ctx.print(`AnythingLLM's storage: ${storage}`);
  const found: Check[] = checks(storage, ctx.payload);
  if (needsPageKey(storage, ctx.payload)) found.push(await pageKeyCheck(storage, anythingllmUrl(ctx.env)));
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
