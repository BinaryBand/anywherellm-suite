// The two things install keeps about the Library and Vault pages' links (shared/page-links.mts is the
// skills' side): the switch that keeps them from the agent, a file the owner makes and removes here
// (it is the owner's file, but code that runs in the container can write the storage, so it is a
// guard against the model, not against everything that runs beside it), and the links file the skills
// keep, which holds the pages' two root-relative paths and, per page, when its link was last replaced.
// Nothing here reads a page's own state (page.json, vault-page.json): those hold the secrets, and the
// links file exists so that nobody needs to.

import fs from "node:fs";
import { writeAtomic } from "#shared/atomic";
import { Told } from "#shared/errors";
import { hiddenFile, linksFile, type PageKind } from "#shared/page-links";
import { eventsDir } from "#shared/pages";
import { type Check, refuseLinks, writable } from "./addons.mts";

const PAGE_PATH = /^\/[\w.-]+\/[\w.-]+\.html$/;

const KINDS = ["library", "vault"] as const satisfies PageKind[];

/** The links file as the installer reads it: the paths, and per page when its link was last replaced
 *  by a rotation (ms since the epoch). `rotated` is null when the file records no rotations at all,
 *  which is not the same as a page that was never rotated. */
export interface Kept extends Partial<Record<PageKind, string>> {
  rotated: Partial<Record<PageKind, number>> | null;
}

/** The links the skills kept, or null when there is no links file yet. A file that is unreadable or
 *  not what the skills write is a refusal that says how it is made again. */
export function readKept(storage: string): Kept | null {
  const file = linksFile(storage);
  let text: string;
  try {
    text = writable(file, () => fs.readFileSync(file, "utf8"), "read");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let found: unknown;
  try {
    found = JSON.parse(text);
  } catch {
    throw new Told(`${file} isn't JSON: remove it, and the agent's next library call or browser step makes it again`);
  }
  if (!found || typeof found !== "object" || Array.isArray(found)) throw new Told(`${file} isn't what the skills write: remove it, and the agent's next library call or browser step makes it again`);
  const links: Kept = { rotated: null };
  for (const kind of KINDS) {
    const value = (found as Record<string, unknown>)[kind];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || !PAGE_PATH.test(value)) throw new Told(`${file} holds a ${kind} link that isn't a page's path: remove it, and the agent's next library call or browser step makes it again`);
    links[kind] = value;
  }
  const rotated = (found as Record<string, unknown>).rotated;
  if (rotated !== undefined && rotated !== null) {
    if (typeof rotated !== "object" || Array.isArray(rotated)) throw new Told(`${file} holds rotation times that aren't what the skills write: remove it, and the agent's next library call or browser step makes it again`);
    links.rotated = {};
    for (const kind of KINDS) {
      const at = (rotated as Record<string, unknown>)[kind];
      if (at === undefined || at === null) continue;
      const ms = typeof at === "string" ? Date.parse(at) : NaN;
      if (Number.isNaN(ms)) throw new Told(`${file} holds a ${kind} rotation time that isn't a time: remove it, and the agent's next library call or browser step makes it again`);
      links.rotated[kind] = ms;
    }
  }
  return links;
}

/** Makes the switch unless it is there (then its time stays); whether it did. */
export function hide(storage: string, now: Date = new Date()): boolean {
  const file = hiddenFile(storage);
  refuseLinks(file, "the switch");
  if (fs.existsSync(file)) return false;
  writable(file, () => writeAtomic(file, `${now.toISOString()}\n`, 0o644));
  return true;
}

/** Removes the switch; whether there was one. */
export function show(storage: string): boolean {
  const file = hiddenFile(storage);
  refuseLinks(file, "the switch");
  if (!fs.existsSync(file)) return false;
  writable(file, () => fs.rmSync(file), "remove");
  return true;
}

/** How many page events wait in AnythingLLM's documents to be applied, by where they were posted: the
 *  Vault's keys section (raw-vault-lean-keys-*), its logins section (raw-vault-lean-logins-*, the
 *  browser's) and the Library page (raw-library-lean-event-*). They carry the secrets of the links as
 *  they are, and are dropped when the links change. */
export interface Waiting {
  keys: number;
  logins: number;
  library: number;
}

export function waitingEvents(storage: string): Waiting {
  const waiting: Waiting = { keys: 0, logins: 0, library: 0 };
  let names: string[] = [];
  try {
    names = fs.readdirSync(eventsDir(storage));
  } catch {
    return waiting;
  }
  for (const name of names) {
    if (name.startsWith("raw-vault-lean-keys-")) waiting.keys++;
    else if (name.startsWith("raw-vault-lean-logins-")) waiting.logins++;
    else if (name.startsWith("raw-library-lean-event-")) waiting.library++;
  }
  return waiting;
}

/** When the switch was made; null when there is none (the links are given to the agent). */
export function hiddenSince(storage: string): Date | null {
  try {
    return fs.statSync(hiddenFile(storage)).mtime;
  } catch {
    return null;
  }
}

/** For health: whether the switch is on (and since when), and whether the file the bridge reads is
 *  sound. */
export function linksCheck(storage: string): Check {
  const name = "the pages' links";
  const since = hiddenSince(storage);
  const way = since ? `switch on since ${since.toISOString().replace(/\.\d+Z$/, "Z")}: kept from the agent` : "switch off: given to the agent too (pages --hide keeps them from it)";
  try {
    readKept(storage);
    return [name, true, way];
  } catch (e) {
    return [name, false, `${(e as Error).message} (${way})`];
  }
}
