// Putting the suite on this machine.
//
// install     the control server and the skills into an AnythingLLM's storage folder, where
//             AnythingLLM runs them itself (addons.mts), and the key their pages post with when
//             given one (--page-key); with --bridge also the bridge AnywhereLLM Lite calls: pointed
//             at the storage (its password), BRIDGE_ALLOW set to the clients' when none is, and
//             started under the user's service manager (service/)
// uninstall   all of that taken out again, and the bridge stopped
// health      every check; false when one fails
//
// The storage is the one named, else the one install was last given, else AnythingLLM Desktop's
// when it is there. The runtime and the roles are the ones named, else those of the entry already
// there, else native for Desktop's storage and container for any other, and the chat role.

import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readPageKey } from "#shared/anythingllm";
import { invalid } from "#shared/errors";
import { readEnv, saveEnv } from "#shared/envfile";
import { desktopStorage, expandHome, samePath, type Place } from "#shared/paths";
import { DEFAULT_ROLES, ROLES } from "#shared/roles";
import { request, Upstream } from "#shared/upstream";
import { checks, chosen, current, entry, INNER_STORAGE, NAME, needsPageKey, put, putPageKey, take, type Check, type Payload, type Runtime } from "./addons.mts";
import { choose, foreground, managerOf, parseKind, run, type Host, type Manager, type Run } from "./service/index.mts";
import { fileFor, loadSettings, shown, type Settings } from "./settings.mts";

/** This machine: its home, environment and OS (a test may say another), and what install needs. */
export interface Ctx extends Place {
  print: (line: string) => void;
  /** The command that serves, for the service to run. */
  command: string[];
  /** The node that runs the control server for a native AnythingLLM: the one running this. */
  node: string;
  /** What BRIDGE_ALLOW is set to when it is unset (contract/default-allow.txt). */
  defaultAllow: string;
  /** What install puts into the storage. */
  payload: Payload;
  /** The service manager's commands; the real ones unless a test gives its own. */
  run?: Run;
  /** The user's id (launchd's GUI domain); this process's unless a test gives its own. */
  uid?: number;
  /** How many seconds a started bridge has to answer (60). */
  startWait?: number;
}

export interface Options {
  storage?: string;
  runtime?: Runtime;
  roles?: string[];
  /** Skill names, "all" or "none"; all when not given. */
  skills?: string[];
  /** The browser-extension key the skills' pages post with, made in AnythingLLM's Settings > Browser Extension. */
  pageKey?: string;
  bridge: boolean;
  start: boolean;
  /** BRIDGE_SERVICE to save: a manager's name, or "auto" to choose by the OS. */
  service?: string;
}

const RUNTIMES: Runtime[] = ["container", "native"];

const hostOf = (ctx: Ctx): Host => ({ ...ctx, run: ctx.run ?? run, uid: ctx.uid ?? process.getuid?.() ?? 0 });

/** The storage to use, or a refusal that says how to find it. */
function storageFor(ctx: Ctx, asked: string | undefined): string {
  const desktop = desktopStorage(ctx);
  const where = asked ? path.resolve(expandHome(asked, ctx.home)) : (loadSettings(ctx).storage ?? (fs.existsSync(desktop) ? desktop : null));
  if (!where) {
    throw invalid(
      `say which AnythingLLM: --storage DIR. For Docker, the folder mounted at ${INNER_STORAGE} (a named volume isn't reachable from here; use a bind mount). AnythingLLM Desktop's would be ${desktop}, and there is none.`,
    );
  }
  if (!fs.existsSync(path.join(where, "anythingllm.db")) && !fs.existsSync(path.join(where, "plugins"))) throw invalid(`${where} doesn't look like AnythingLLM's storage`);
  return where;
}

const statusOf = async (url: string): Promise<number> => {
  try {
    return (await request(url, { timeout: 5_000 })).status;
  } catch {
    return 0;
  }
};

async function waitFor(url: string, seconds = 60): Promise<boolean> {
  for (const deadline = Date.now() + seconds * 1000; Date.now() < deadline; await sleep(500)) {
    if ((await statusOf(url)) === 200) return true;
  }
  return false;
}

export async function install(ctx: Ctx, opts: Options): Promise<void> {
  if (opts.runtime && !RUNTIMES.includes(opts.runtime)) throw invalid(`--runtime is container or native, not ${opts.runtime}`);
  const unknown = (opts.roles ?? []).filter((r) => !ROLES.includes(r));
  if (unknown.length || opts.roles?.length === 0) throw invalid(`--roles is one or more of ${ROLES.join(", ")}${unknown.length ? `, not ${unknown.join(", ")}` : ""}`);
  if (opts.pageKey !== undefined && !/^brx-\S+$/.test(opts.pageKey)) throw invalid(`--page-key is a browser-extension key (brx-...), as AnythingLLM's Settings > Browser Extension makes one`);
  const skills = chosen(ctx.payload, opts.skills);
  const service = opts.service === undefined ? undefined : parseKind(opts.service);
  const storage = storageFor(ctx, opts.storage);
  const was = current(storage);
  const runtime = opts.runtime ?? was?.runtime ?? (samePath(ctx.platform, storage, desktopStorage(ctx)) ? "native" : "container");
  const roles = opts.roles ?? was?.roles ?? DEFAULT_ROLES;
  ctx.print(`AnythingLLM's storage: ${storage} (${runtime === "container" ? `a container's, seen there as ${INNER_STORAGE}` : "AnythingLLM runs on this machine"})`);
  for (const line of put(storage, ctx.payload, entry(runtime, storage, roles, ctx.node), skills)) ctx.print(line);
  if (opts.pageKey) ctx.print(putPageKey(storage, opts.pageKey));

  const file = fileFor(ctx);
  const changes: Record<string, string | null> = { ANYTHINGLLM_STORAGE: storage };
  if (service !== undefined) changes.BRIDGE_SERVICE = service || null;
  if (opts.bridge && readEnv(file).BRIDGE_ALLOW === undefined) {
    changes.BRIDGE_ALLOW = ctx.defaultAllow;
    ctx.print(`BRIDGE_ALLOW: what its clients call, ${ctx.defaultAllow}`);
  }
  saveEnv(file, changes);
  const settings = loadSettings(ctx);
  if (opts.bridge && opts.start) await start(ctx, settings, file);
  leftForYou(ctx, settings, file, runtime, opts.bridge, needsPageKey(storage, ctx.payload) && !readPageKey(storage));
}

async function start(ctx: Ctx, settings: Settings, file: string): Promise<void> {
  const manager = choose(settings.service, hostOf(ctx));
  if (manager === foreground) {
    ctx.print(`${settings.service ? "BRIDGE_SERVICE is foreground" : "This machine has no service manager the bridge drives"}. Run \`anywherellm-suite serve\``);
    ctx.print("under your own supervisor: a terminal, tmux, a container, a process manager. It reads the same settings file.");
    return;
  }
  if (manager.define({ command: ctx.command, envFile: file, port: settings.port })) ctx.print(`wrote the bridge's service: ${manager.label}`);
  manager.start();
  if (!(await waitFor(`http://127.0.0.1:${settings.port}/health`, ctx.startWait))) throw invalid(`the bridge didn't answer; see ${manager.logs}`);
}

/** The manager the bridge was defined in, if any. */
const definedIn = (ctx: Ctx, settings: Settings): Manager | null => {
  const manager = managerOf(settings.service, hostOf(ctx));
  return manager !== foreground && manager.defined() ? manager : null;
};

/** What install could not do for the owner. */
function leftForYou(ctx: Ctx, settings: Settings, file: string, runtime: Runtime, bridge: boolean, askKey: boolean): void {
  ctx.print("\nLeft for you:");
  ctx.print(`- In AnythingLLM, Settings > Agent Skills: refresh the MCP servers (or restart AnythingLLM) so it starts \`${NAME}\`, and switch on the skills you want.`);
  if (askKey) ctx.print(`- The skills' pages need a key to post with: make one in AnythingLLM's Settings > Browser Extension, then run install again with --page-key <key>.`);
  if (runtime === "native") ctx.print(`- The entry starts the server with ${ctx.node}; run install again if that Node moves.`);
  if (!bridge) return;
  if (!settings.envFile || !fs.existsSync(settings.envFile)) {
    ctx.print(`- AnythingLLM's .env isn't at ${settings.envFile}: set ANYTHINGLLM_ENV in ${file} (its password is the bridge's login; none is needed for Desktop).`);
  }
  if (!settings.allow.length) ctx.print(`- BRIDGE_ALLOW is empty, so the bridge passes nothing: set it in ${file}.`);
  ctx.print("- For AnywhereLLM Lite: give the bridge an https address (README: Reach it from your devices).");
}

export function uninstall(ctx: Ctx, opts: { storage?: string } = {}): void {
  const settings = loadSettings(ctx);
  const storage = opts.storage ? path.resolve(expandHome(opts.storage, ctx.home)) : settings.storage;
  if (storage) for (const line of take(storage, ctx.payload)) ctx.print(line);
  else ctx.print("No storage is known: name it with --storage to take the control server and the skills out.");
  const manager = definedIn(ctx, settings);
  const stopped = manager?.stop();
  saveEnv(fileFor(ctx), { ANYTHINGLLM_STORAGE: null });
  if (stopped) ctx.print("Stopped the bridge.");
  else if (manager) ctx.print(`${manager.label} would not stop: stop the bridge yourself.`);
  if (storage) ctx.print("A skill's data stays in the storage (the library's in library-lean/).");
}

/** Every health check; false when one failed. */
export async function health(ctx: Ctx): Promise<boolean> {
  const settings = loadSettings(ctx);
  const { storage } = settings;
  const found: Check[] = storage ? [["AnythingLLM's storage", fs.existsSync(storage), storage], ...checks(storage, ctx.payload)] : [["AnythingLLM's storage", false, "not set: run install"]];
  const manager = definedIn(ctx, settings);
  const [key, bridge] = await Promise.all([
    storage && needsPageKey(storage, ctx.payload) ? pageKeyCheck(storage, settings.anythingllmUrl) : null,
    manager || readEnv(fileFor(ctx)).BRIDGE_ALLOW !== undefined ? bridgeChecks(settings, manager) : [],
  ]);
  found.push(...(key ? [key] : []), ...bridge);
  for (const [what, ok, detail] of found) ctx.print(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  return found.every(([, ok]) => ok);
}

async function bridgeChecks(settings: Settings, manager: Manager | null): Promise<Check[]> {
  const found: Check[] = [];
  if (manager) {
    const state = manager.status();
    found.push([manager.label, state === "active", state]);
  }
  const probe = (what: string, status: number, detail = ""): Check => [what, status === 200, `${detail}${status || "no answer"}`];
  const publicUrl = `${settings.publicUrl}/health`;
  const [bridge, ping, login, route] = await Promise.all([
    statusOf(`http://127.0.0.1:${settings.port}/health`),
    statusOf(`${settings.anythingllmUrl}/api/ping`),
    loginCheck(settings),
    settings.publicUrl ? statusOf(publicUrl).then((status) => probe(publicUrl, status)) : (["route", true, "PUBLIC_URL and PUBLIC_HOST unset: the bridge answers on this machine only"] as Check),
  ]);
  found.push(probe(`bridge on :${settings.port}`, bridge), probe("AnythingLLM", ping, `${settings.anythingllmUrl}: `), login);
  const allowed = shown(settings).BRIDGE_ALLOW;
  found.push(["BRIDGE_ALLOW", Boolean(allowed), allowed || "empty: the bridge passes nothing"], route);
  return found;
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

async function loginCheck(settings: Settings): Promise<Check> {
  const name = "the internal API's login";
  try {
    const reply = await Upstream.of(settings).exchange("GET", "/system/api-keys");
    return [name, reply.status !== 401, reply.status === 401 ? "refused" : ""];
  } catch (e) {
    return [name, false, (e as Error).message];
  }
}
