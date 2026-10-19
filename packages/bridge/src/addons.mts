// What install puts into AnythingLLM's storage folder, where AnythingLLM finds it and runs it itself:
//
//   anywherellm-suite/control.cjs             the control MCP server (packages/control)
//   plugins/anythingllm_mcp_servers.json      an entry `control` that starts it with `node`
//   plugins/agent-skills/<hubId>/             each skill (packages/skills)
//   anywherellm-suite/page-key                the browser-extension key the skills' pages post
//                                             with, when install is given one (--page-key)
//
// The entry runs the container's own node on the path the container sees (/app/server/storage), or
// for AnythingLLM Desktop (and one run from source) the node that ran install, on the host's path.
// Every other entry of the servers file stays, and so do the settings AnythingLLM keeps in ours
// (`anythingllm`: suppressed tools, autoStart). Files are written in place, not renamed over, since
// a file in AnythingLLM's storage may belong to its user and group.

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pageKeyFile, SAVED_NOW, SUITE_DIR } from "#shared/anythingllm";
import { sameText, writeAtomicIfChanged } from "#shared/atomic";
import { invalid } from "#shared/errors";
import { DEFAULT_ROLES, ROLES_ENV } from "#shared/roles";

/** The files install writes, built into it (packages/build.mjs). */
export interface Payload {
  control: string;
  skills: Skill[];
}

export interface Skill {
  /** Its folder in packages/skills, the name `--skills` takes. */
  name: string;
  hubId: string;
  /** File name -> text. */
  files: Record<string, string>;
  /** Whether it has pages, which post with the pages' key (build.mjs: it bundles shared/pages). */
  pages?: boolean;
}

export type Runtime = "container" | "native";

export const NAME = "control";
const CONTROL = "control.cjs";
/** Where the container sees its storage (contract/versions.env INNER_STORAGE). */
export const INNER_STORAGE = "/app/server/storage";

type Obj = Record<string, unknown>;
export type Check = [what: string, ok: boolean, detail: string];

export const serversFile = (storage: string): string => path.join(storage, "plugins", "anythingllm_mcp_servers.json");
const controlFile = (storage: string): string => path.join(storage, SUITE_DIR, CONTROL);
const skillDir = (storage: string, skill: Skill): string => path.join(storage, "plugins", "agent-skills", skill.hubId);

/** The servers-file entry that starts the control server. */
export function entry(runtime: Runtime, storage: string, roles: string[], node: string): Obj {
  const [command, file] = runtime === "container" ? ["node", `${INNER_STORAGE}/${SUITE_DIR}/${CONTROL}`] : [node, controlFile(storage)];
  return { command, args: [file], env: { [ROLES_ENV]: roles.join(",") } };
}

/** What an entry `entry` wrote says, the runtime and the roles; null for an entry that isn't ours. */
export function parseEntry(found: unknown): { runtime: Runtime; roles: string[] } | null {
  const { command, args, env } = (found ?? {}) as Obj;
  const words = Array.isArray(args) ? args.map(String) : [];
  const file = (words.at(-1) ?? "").replace(/\\/g, "/");
  if (!file.endsWith(`/${SUITE_DIR}/${CONTROL}`)) return null;
  const roles = ((env ?? {}) as Obj)[ROLES_ENV];
  return { runtime: command === "node" && file.startsWith(INNER_STORAGE) ? "container" : "native", roles: typeof roles === "string" ? roles.split(",") : DEFAULT_ROLES };
}

const ours = (found: unknown): boolean => parseEntry(found) !== null;

/** Runs a file operation, saying what to do when the storage isn't the user's to write. */
function writable<T>(file: string, operation: () => T): T {
  try {
    return operation();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw e;
    throw invalid(
      `can't write ${file}: the storage belongs to another user, likely the container's. Run install as that user, or for rootless podman inside \`podman unshare\`, or start the container with --userns=keep-id`,
    );
  }
}

/** Writes `text` unless the file holds it already (holds); whether it wrote. */
function write(file: string, text: string): boolean {
  if (holds(file, text)) return false;
  writable(file, () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  });
  return true;
}

function readServers(file: string): Obj {
  if (!fs.existsSync(file)) return {};
  let found: unknown;
  try {
    found = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
  } catch (e) {
    throw invalid(`${file} isn't JSON (${(e as Error).message}); fix it first`);
  }
  if (!found || typeof found !== "object" || Array.isArray(found)) throw invalid(`${file} doesn't hold a JSON object`);
  return found as Obj;
}

/** What our entry in the servers file says (parseEntry), or null when there is none or no file to read. */
export function current(storage: string): ReturnType<typeof parseEntry> {
  try {
    return parseEntry(((readServers(serversFile(storage)).mcpServers ?? {}) as Obj)[NAME]);
  } catch {
    return null;
  }
}

/** Sets our entry in the servers file, or with null drops it; what it did. */
export function setEntry(storage: string, wanted: Obj | null): string {
  const file = serversFile(storage);
  const config = readServers(file);
  const servers = { ...((config.mcpServers ?? {}) as Obj) };
  const old = servers[NAME] as Obj | undefined;
  if (old !== undefined && !ours(old)) throw invalid(`${file} has a server named ${NAME} that isn't ours; rename it first`);
  if (!wanted && old === undefined) return `no ${NAME} entry in ${file}`;
  if (wanted) servers[NAME] = old?.anythingllm ? { ...wanted, anythingllm: old.anythingllm } : wanted;
  else delete servers[NAME];
  if (!write(file, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`)) return `unchanged: ${NAME} in ${file}`;
  return `${wanted ? "set" : "dropped"} ${NAME} in ${file}`;
}

/** A skill's file as install writes it over `file`: a plugin.json keeps what AnythingLLM saved in
 *  the one installed, whether the skill is on and its settings' values (setup_args' `value`), and
 *  what the skill wrote at the end of its description (SAVED_NOW). */
function skillFile(file: string, text: string): string {
  if (path.basename(file) !== "plugin.json") return text;
  let old: Obj;
  try {
    old = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return text; // none yet, or not JSON
  }
  const next = JSON.parse(text) as Obj;
  if (typeof old.active === "boolean") next.active = old.active;
  const saved = String(old.description ?? "").split(SAVED_NOW)[1];
  if (saved !== undefined && typeof next.description === "string") next.description = next.description.split(SAVED_NOW)[0] + SAVED_NOW + saved;
  const args = (next.setup_args ?? {}) as Record<string, Obj>;
  for (const [name, arg] of Object.entries((old.setup_args ?? {}) as Record<string, Obj | null>)) if (args[name] && arg?.value !== undefined) args[name].value = arg.value;
  return `${JSON.stringify(next, null, 2)}\n`;
}

/** Whether `file` holds `text`, or for JSON the same value however it's laid out (AnythingLLM
 *  writes plugin.json again when a setting changes). */
function holds(file: string, text: string): boolean {
  if (sameText(file, text)) return true;
  if (!file.endsWith(".json") || !fs.existsSync(file)) return false;
  try {
    return isDeepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), JSON.parse(text));
  } catch {
    return false;
  }
}

/** The skills `names` asks for ("all" or none given for every one); an unknown name is refused. */
export function chosen(payload: Payload, names?: string[]): Skill[] {
  if (!names || names.includes("all")) return payload.skills;
  const unknown = names.filter((n) => n !== "none" && !payload.skills.some((s) => s.name === n));
  if (unknown.length) throw invalid(`no such skill: ${unknown.join(", ")}; the skills are ${payload.skills.map((s) => s.name).join(", ") || "none"}`);
  return payload.skills.filter((s) => names.includes(s.name));
}

/** Puts the control server, its entry and `skills` into the storage; what it did, line by line. */
export function put(storage: string, payload: Payload, wantedEntry: Obj, skills: Skill[]): string[] {
  const done = [write(controlFile(storage), payload.control) ? `wrote the control server: ${controlFile(storage)}` : `unchanged: ${controlFile(storage)}`];
  done.push(setEntry(storage, wantedEntry));
  for (const skill of skills) {
    const dir = skillDir(storage, skill);
    const changed = Object.entries(skill.files).filter(([name, text]) => write(path.join(dir, name), skillFile(path.join(dir, name), text)));
    const old = leftovers(storage, skill);
    for (const name of old) writable(dir, () => fs.rmSync(path.join(dir, name), { recursive: true, force: true }));
    done.push(`${changed.length || old.length ? "wrote" : "unchanged:"} the ${skill.name} skill: ${dir}${old.length ? ` (removed what it no longer ships: ${old.join(", ")})` : ""}`);
  }
  return done;
}

/** What's in a skill's folder that this version doesn't ship: an older version's files, which
 *  AnythingLLM would otherwise keep beside it. A skill ships its files flat (build.mjs inlines its
 *  static/ folder), and keeps its data elsewhere in the storage, so the folder is its files alone. */
function leftovers(storage: string, skill: Skill): string[] {
  try {
    return fs.readdirSync(skillDir(storage, skill)).filter((name) => !(name in skill.files));
  } catch {
    return [];
  }
}

/** Takes out what `put` put in (the skills it knows of); what it did. A skill's data stays. */
export function take(storage: string, payload: Payload): string[] {
  const done = [setEntry(storage, null)];
  if (fs.existsSync(pageKeyFile(storage))) done.push("the pages' key goes with it: revoke it in AnythingLLM's Settings > Browser Extension");
  for (const folder of [path.dirname(controlFile(storage)), ...payload.skills.map((s) => skillDir(storage, s))]) {
    if (!fs.existsSync(folder)) continue;
    writable(folder, () => fs.rmSync(folder, { recursive: true }));
    done.push(`removed ${folder}`);
  }
  return done;
}

/** Keeps the pages' key in the storage, readable by its owner alone; what it did. */
export function putPageKey(storage: string, key: string): string {
  const file = pageKeyFile(storage);
  return writable(file, () => writeAtomicIfChanged(file, `${key}\n`, 0o600)) ? `kept the pages' key: ${file}` : `unchanged: the pages' key in ${file}`;
}

/** Whether a skill with pages is in the storage, so the pages' key is needed. */
export const needsPageKey = (storage: string, payload: Payload): boolean => payload.skills.some((s) => s.pages && fs.existsSync(skillDir(storage, s)));

/** Whether what `put` puts there is there and current. */
export function checks(storage: string, payload: Payload): Check[] {
  const same = (file: string, text: string): string => (!fs.existsSync(file) ? "missing" : sameText(file, text) ? "" : "not this version's");
  const control = same(controlFile(storage), payload.control);
  let listed: Check;
  try {
    const found = ((readServers(serversFile(storage)).mcpServers ?? {}) as Obj)[NAME];
    listed = [`the ${NAME} entry`, found !== undefined && ours(found), found === undefined ? `missing from ${serversFile(storage)}` : ours(found) ? "" : "another server has its name"];
  } catch (e) {
    listed = [`the ${NAME} entry`, false, (e as Error).message];
  }
  const found: Check[] = [["the control server", !control, control && `${control}: run install again`], listed];
  for (const skill of payload.skills) {
    if (!fs.existsSync(skillDir(storage, skill))) continue; // not chosen
    const stale = Object.entries(skill.files).filter(([name, text]) => {
      const file = path.join(skillDir(storage, skill), name);
      return !holds(file, skillFile(file, text));
    }).map(([name]) => name);
    const old = leftovers(storage, skill);
    const why = [...(stale.length ? [`${stale.join(", ")} not this version's`] : []), ...(old.length ? [`${old.join(", ")} left from an older version`] : [])];
    found.push([`the ${skill.name} skill`, !why.length, why.length ? `${why.join("; ")}: run install again` : ""]);
  }
  return found;
}
