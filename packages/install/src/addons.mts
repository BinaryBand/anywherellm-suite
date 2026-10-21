// What install puts into AnythingLLM's storage folder, where AnythingLLM finds it and runs it itself:
//
//   plugins/agent-skills/<hubId>/             each skill (packages/skills)
//   anywherellm-suite/page-key                the browser-extension key the skills' pages post
//                                             with, when install is given one (--page-key)
//
// Files are written in place, not renamed over, since a file in AnythingLLM's storage may belong to
// its user and group.

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pageKeyFile, SAVED_NOW, SUITE_DIR } from "#shared/anythingllm";
import { sameText, writeAtomicIfChanged } from "#shared/atomic";
import { Told } from "#shared/errors";

/** The files install writes, built into it (packages/build.mjs). */
export interface Payload {
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

/** Where the container sees its storage (tools/versions.env INNER_STORAGE). */
export const INNER_STORAGE = "/app/server/storage";

type Obj = Record<string, unknown>;
export type Check = [what: string, ok: boolean, detail: string];

/** Where AnythingLLM keeps the skill in `storage`. */
export const skillDir = (storage: string, skill: Skill): string => path.join(storage, "plugins", "agent-skills", skill.hubId);

/** Runs a file operation that `verb`s `file`, saying what to do when the storage isn't the user's to use. */
export function writable<T>(file: string, operation: () => T, verb = "write"): T {
  try {
    return operation();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw e;
    throw new Told(
      `can't ${verb} ${file}: the storage belongs to another user, likely the container's: run it as the storage's owner (for rootless podman, inside \`podman unshare\`), or start the container with --userns=keep-id`,
    );
  }
}

/** Refuses a path a link leads somewhere else from: `what` (a file of the owner's on the host) isn't
 *  kept through a symbolic link, at a hard link or in a folder that is a link, since what is written
 *  there, or removed, would be another file's. */
export function refuseLinks(file: string, what: string): void {
  const folder = path.dirname(file);
  try {
    if (fs.lstatSync(folder).isSymbolicLink()) throw new Told(`${folder} is a link; ${what} isn't kept through it`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    const s = fs.lstatSync(file);
    if (s.isSymbolicLink() || s.nlink > 1 || !s.isFile()) throw new Told(`${file} is a link or not a plain file; ${what} isn't kept there: remove it by hand`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
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
  if (unknown.length) throw new Told(`no such skill: ${unknown.join(", ")}; the skills are ${payload.skills.map((s) => s.name).join(", ") || "none"}`);
  return payload.skills.filter((s) => names.includes(s.name));
}

/** Puts `skills` into the storage; what it did, line by line. */
export function put(storage: string, skills: Skill[]): string[] {
  const done: string[] = [];
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
  const done: string[] = [];
  if (fs.existsSync(pageKeyFile(storage))) done.push("the pages' key goes with it: revoke it in AnythingLLM's Settings > Browser Extension");
  for (const folder of [path.join(storage, SUITE_DIR), ...payload.skills.map((s) => skillDir(storage, s))]) {
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
  const found: Check[] = [];
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
