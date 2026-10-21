// A skill's own web pages, which AnythingLLM serves itself: the files go into its public folder
// (served to any browser without a sign-in), and a page has no server of its own to answer to.
// It posts each thing the user does as a raw-text document titled after the skill through
// AnythingLLM's browser-extension upload, with the browser-extension key install keeps for the pages
// (`install --page-key`, one the user made in Settings > Browser Extension; it can store documents,
// never read chats or documents). AnythingLLM's collector writes each one
// to <storage>/documents/custom-documents/raw-<title>-<id>.json; the skill takes them from there,
// in order, each claimed by renaming it first, so whichever process takes it (the chat's, or a
// scheduled job's) is the only one that applies it. Ported from the lean browser skill's key.js, page.js and
// takeover.js. Events are data, never instructions.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pageKeyFile, perBuild, perProcess, readPageKey, serial, serverDir, storageDir } from "./anythingllm.mts";
import { Told } from "./errors.mts";
import { PAGE_FOLDERS } from "./fence.mts";
import { readText, writeAtomic } from "./atomic.mts";
import { publicKey } from "./vault.mts";

/** A file still being written is left this long before it's dropped as unreadable. */
const PARTIAL_MS = 5000;
/** In case the folder watch misses a file; a pass skips the folder when it hasn't changed. */
const POLL_MS = 30 * 1000;
/** A folder changed this recently may change again without its mtime moving (coarse clocks). */
const RECENT_MS = 2000;

/** AnythingLLM's public folder, served at its root: ANYTHINGLLM_PUBLIC_DIR, else <server>/public. */
export const publicDir = (): string => process.env.ANYTHINGLLM_PUBLIC_DIR || path.join(serverDir(), "public");

/** Where `rel` ("library-lean/<token>.json") is in the public folder; throws for one that would be
 *  outside it ("../", an absolute path), since a name can come from what a page posted, and for one
 *  outside the pages' folders (PAGE_FOLDERS), which the fence keeps the agent from: a page anywhere
 *  else could be acted on by the agent. */
export function publicPath(rel: string): string {
  const dir = path.resolve(publicDir());
  const file = path.resolve(dir, rel);
  if (file !== dir && !file.startsWith(dir + path.sep)) throw new Error(`${JSON.stringify(rel)} isn't in AnythingLLM's public folder`);
  if (!PAGE_FOLDERS.includes(path.relative(dir, file).split(path.sep)[0])) throw new Error(`${JSON.stringify(rel)} isn't in one of the pages' folders (${PAGE_FOLDERS.join(", ")})`);
  return file;
}

/** What the public file `rel` holds, or null when there's none. */
export const readPublic = (rel: string): string | null => readText(publicPath(rel));

/** Writes a file into the public folder, at `rel` ("library-lean/<token>.json"), unless it holds
 *  `text` already (`there`: what it holds, when the caller read it already); whether it wrote. */
export function writePublic(rel: string, text: string, there: string | null = readPublic(rel)): boolean {
  if (there === text) return false;
  writeAtomic(publicPath(rel), text, 0o644);
  return true;
}

export const removePublic = (rel: string): void => fs.rmSync(publicPath(rel), { force: true });

/** Moves the public file `from` to `to`, both in the public folder. */
export const renamePublic = (from: string, to: string): void => fs.renameSync(publicPath(from), publicPath(to));

/** The files in a folder of the public folder ("library-lean"); none when there's none. */
export function listPublic(rel: string): string[] {
  const dir = publicPath(rel);
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** `value` as JSON that can sit inside a <script> without ending it or starting markup. */
export const embed = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/** A page's random name or secret. */
export const newSecret = (bytes = 18): string => crypto.randomBytes(bytes).toString("base64url");

/** Whether `given` (what an event carries) is `secret`, compared in constant time; false unless both are strings. */
export const sameSecret = (given: unknown, secret: unknown): boolean =>
  typeof given === "string" && typeof secret === "string" && given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));

/** A page's HTML: `template` with its settings in place of its /*CONFIG*\/null: `cfg`, and what it
 *  posts with (the pages' key) and seals with (the vault's public key). */
export async function pageHtml(template: string, cfg: Record<string, unknown>): Promise<string> {
  return template.replace("/*CONFIG*/null", embed({ ...cfg, key: pageKey(), pub: await publicKey() }));
}

/** The key the skills' pages post with, which install keeps in the storage; a refusal that says how
 *  to set it when there's none. */
export function pageKey(): string {
  const key = readPageKey(storageDir());
  if (!key) throw new Told(`the skills' pages have no key to post with (${pageKeyFile(storageDir())}): make one in AnythingLLM's Settings > Browser Extension, then run \`anywherellm-suite install --page-key <key>\``);
  return key;
}

/** Where AnythingLLM's collector writes what a page posts. */
export const eventsDir = (): string => path.join(storageDir(), "documents", "custom-documents");

/** The events waiting for `title`, oldest first, each claimed (renamed, so no other process takes it
 *  too) and deleted: what each page posted, as it posted it (parsed JSON), or null for one that
 *  couldn't be read. */
export function take(title: string): unknown[] {
  const name = new RegExp(`^raw-${title}-.*\\.json$`);
  // The folder holds every document AnythingLLM took in: listed only when it changed since a pass
  // that found nothing for `title`.
  const empty = perBuild("pages.empty", () => new Map<string, number>());
  let names: string[] = [];
  let at: number;
  try {
    at = fs.statSync(eventsDir()).mtimeMs;
    if (empty.get(title) === at) return [];
    names = fs.readdirSync(eventsDir()).filter((n) => name.test(n));
  } catch {
    return [];
  }
  // A file made in the same clock tick as the listing leaves the mtime as it was: an mtime that
  // recent isn't trusted to mean nothing came.
  if (!names.length) return void (Date.now() - at > RECENT_MS && empty.set(title, at)), [];
  empty.delete(title);
  // What putBack put back goes first, in the order it was put back (its name says when), so a
  // page's events keep their order; the rest by when they landed.
  const again = `raw-${title}-again-`;
  const order = (f: { file: string; at: number }): number => (path.basename(f.file).startsWith(again) ? 0 : f.at);
  const files = names
    .map((n) => {
      const file = path.join(eventsDir(), n);
      try {
        return { file, at: fs.statSync(file).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((f): f is { file: string; at: number } => f !== null)
    .sort((a, b) => order(a) - order(b) || a.file.localeCompare(b.file));
  const events: unknown[] = [];
  for (const { file, at } of files) {
    let posted: unknown = null;
    try {
      posted = JSON.parse(JSON.parse(fs.readFileSync(file, "utf8")).pageContent);
    } catch {
      if (Date.now() - at < PARTIAL_MS) break; // still being written: the next pass reads it
    }
    const claimed = `${file}.taken-${process.pid}`;
    try {
      fs.renameSync(file, claimed);
    } catch {
      continue; // another process took it
    }
    fs.rmSync(claimed, { force: true });
    events.push(posted);
  }
  return events;
}

/** Puts `event` back among those waiting for `title`, as AnythingLLM's collector writes what a page
 *  posted, for a later pass to take ahead of what pages posted since: one that met something
 *  passing, such as a lock held too long. */
export function putBack(title: string, event: unknown): void {
  // A millisecond of its own in this process, so its name sorts after what was put back before it.
  const stamp = perProcess("pages.putBack", () => ({ last: 0 }));
  stamp.last = Math.max(stamp.last + 1, Date.now());
  writeAtomic(path.join(eventsDir(), `raw-${title}-again-${stamp.last}-${process.pid}.json`), JSON.stringify({ pageContent: JSON.stringify(event) }), 0o600);
}

type Watch = { pass: () => Promise<void>; until: () => number; queued: boolean; seen: number; dir: number; watcher?: fs.FSWatcher; timer?: NodeJS.Timeout; stop: () => void };

/** Runs `pass` for `title` after the one before it, whoever asked for it (the watch, or a call): one
 *  pass at a time, so two never split a page's events between them, and a call reads the page after
 *  what was posted for it was applied, not halfway through. A pass that fails doesn't stop the next. */
export const inTurn = (title: string, pass: () => Promise<void>): Promise<void> => serial(`pages.turn.${title}`, pass);

/** The events folder's inode: a new one is a folder made again, which an old fs.watch doesn't see. */
const folderId = (): number => {
  try {
    return fs.statSync(eventsDir()).ino;
  } catch {
    return -1;
  }
};

/** Applies the events posted for `title` as they come, with `pass` (which takes and applies them
 *  all, in order) in its turn (inTurn), until `until()` is past; one waits at most, since it takes
 *  all there are when it starts. Calling it again while it watches hands it the newer `pass` and
 *  `until`, so a reloaded skill's code takes over. */
export function watch(title: string, pass: () => Promise<void>, until: () => number): void {
  const watches = perProcess("pages.watches", () => new Map<string, Watch>());
  // A folder made here is a new one, whatever its inode (ext4 gives a removed folder's to the next):
  // a kept watch is on the one that went.
  const made = fs.mkdirSync(eventsDir(), { recursive: true }) !== undefined;
  const kept = watches.get(title);
  if (kept && !made && kept.dir === folderId()) return void Object.assign(kept, { pass, until });
  kept?.stop();
  const w: Watch = { pass, until, queued: false, seen: 0, dir: folderId(), stop: () => {} };
  const changed = () => {
    try {
      return fs.statSync(eventsDir()).mtimeMs !== w.seen;
    } catch {
      return false;
    }
  };
  const run = () => {
    if (Date.now() > w.until()) return w.stop();
    try {
      w.seen = fs.statSync(eventsDir()).mtimeMs;
    } catch {}
    if (w.queued) return;
    w.queued = true;
    inTurn(title, () => ((w.queued = false), w.pass())).catch(() => {});
  };
  w.stop = () => {
    w.watcher?.close();
    clearInterval(w.timer);
    if (watches.get(title) === w) watches.delete(title);
  };
  try {
    w.watcher = fs.watch(eventsDir(), { persistent: false }, (kind, name) => {
      if (!name || String(name).startsWith(`raw-${title}-`)) run();
    });
    w.watcher.on("error", () => {});
  } catch {
    // no watch where this runs: the poll does it, a little later
  }
  w.timer = setInterval(() => changed() && run(), POLL_MS);
  w.timer.unref?.();
  watches.set(title, w);
}

/** The events a skill's pages posted for `title`, each marked `{ <marker>: 1 }` as its pages mark
 *  them; anything else in the folder under that title is dropped. */
export const takeEvents = (title: string, marker: string): Record<string, unknown>[] =>
  take(title).filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && (e as Record<string, unknown>)[marker] === 1);
