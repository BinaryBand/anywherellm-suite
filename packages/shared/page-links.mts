// Whether the Library, Vault and apps manager pages' links are kept from the agent, and where the user finds them
// then. The switch is a file in the suite's folder of the storage, `page-links-hidden`, which the
// owner makes and removes on the host (`anywherellm-suite pages --hide` / `--show`). It is the
// owner's file, but code that runs in the container can write it, so it is a switch for what the
// skills tell the agent, not a lock against the agent's own tools. With it present the skills still write their pages, but their answers carry no
// link to the Library page, the Vault or the apps manager. The links file, `page-links.json`, holds the paths for
// whoever may show them to the user (the bridge, `anywherellm-suite pages`): it is written whether
// the switch is on or off, and each skill owns its own key; `rotated` says when each page's token was
// last replaced by a rotation (so `pages` can tell which link is new). For AnywhereLLM Lite's shelf it
// also holds the browser's open tabs (`browser`) and the Library's and the apps' status (`status`):
// paths, numbers and times only, which the bridge passes on. It holds no event secret and no page key,
// but a path in it is a bearer capability (whoever fetches the page gets the secret its HTML
// embeds), so it is kept like the page key: 0600, never logged.

import fs from "node:fs";
import path from "node:path";
import { SUITE_DIR, storageDir } from "./anythingllm.mts";
import { readJson, updateJson } from "./atomic.mts";

export type PageKind = "library" | "vault" | "apps";
export const KINDS: readonly PageKind[] = ["library", "vault", "apps"];
export type Links = Partial<Record<PageKind, string>>;

/** The switch: its presence means the links are kept from the agent. */
export const hiddenFile = (storage: string = storageDir()): string => path.join(storage, SUITE_DIR, "page-links-hidden");

/** Where the pages' root-relative paths are kept. */
export const linksFile = (storage: string = storageDir()): string => path.join(storage, SUITE_DIR, "page-links.json");

/** Whether the links are kept from the agent now; read each time, never kept. */
export const linksHidden = (storage: string = storageDir()): boolean => fs.existsSync(hiddenFile(storage));

/** Where the user opens the pages when the agent isn't given their links. */
export const OPEN_PAGES = "in AnywhereLLM Lite, or with `anywherellm-suite pages` on the AnythingLLM host";

/** The links kept now; none for a page not shown yet. A file that can't be read or parsed is none:
 *  the links are derived from the pages and written again at the next show. Only strings are kept;
 *  the rotation stamps are for whoever shows the links (the installer's `pages` reads them). */
export function readLinks(storage: string = storageDir()): Links {
  const found = readAll(storage);
  const links: Links = {};
  for (const kind of KINDS) if (typeof found[kind] === "string") links[kind] = found[kind] as string;
  return links;
}

/** The links file as it is, every key; empty where it can't be read or parsed. */
export function readAll(storage: string = storageDir()): Record<string, unknown> {
  try {
    const found = readJson<unknown>(linksFile(storage), () => ({}));
    return found && typeof found === "object" && !Array.isArray(found) ? (found as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Changes the links file with `keep`, under its lock. A hint for whoever shows the pages: a failure
 *  (a file that can't be written) is logged after `failed`, and never reaches the page or the answer. */
async function change(failed: string, keep: (links: Record<string, unknown>) => void): Promise<void> {
  const file = linksFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Read as a fresh start: a damaged file is derived data, replaced by the next write.
    await updateJson<Record<string, unknown>, void>(file, () => ({}), keep).catch(async (e) => {
      if (!(e instanceof SyntaxError)) throw e;
      fs.rmSync(file, { force: true });
      await updateJson<Record<string, unknown>, void>(file, () => ({}), keep);
    });
  } catch (e) {
    console.error(`${failed}: ${(e as Error)?.message ?? e}`);
  }
}

/** Keeps `rel` (root-relative, like "/vault-lean/<token>.html") as the link of `kind`, without
 *  touching the other page's. No write when it is the link already, unless `rotated`: the token was
 *  just replaced by a rotation, and the time is kept beside the link. */
export async function noteLink(kind: PageKind, rel: string, rotated = false): Promise<void> {
  if (readLinks()[kind] === rel && !rotated) return;
  await change(`${kind}-lean couldn't keep the page's link`, (links) => {
    links[kind] = rel;
    if (rotated) {
      const stamps = links.rotated && typeof links.rotated === "object" ? (links.rotated as Record<string, unknown>) : {};
      stamps[kind] = new Date().toISOString();
      links.rotated = stamps;
    }
  });
}

/** One of the browser's open tabs, as the links file lists it: its page's path
 *  ("/browser-lean/<token>.html"), its workspace, when its workspace's browser closes, and when it
 *  was drawn (ms since 1970), which orders the list. */
export interface TabLink {
  path: string;
  workspace: string;
  until: number;
  drawn: number;
}

/** The most tabs the list keeps. */
export const MAX_TABS = 20;

/** Keeps `tabs` as the open tabs of `workspace`, in place of the ones listed for it before, newest
 *  drawn first. The other workspaces' stay, but not one past its `until`: a process that ended (a
 *  restart) took its browsers with it, and lists them no more. */
export function noteTabs(workspace: string, tabs: TabLink[]): Promise<void> {
  return change("browser-lean couldn't list its tabs", (links) => {
    const now = Date.now();
    const others = (Array.isArray(links.browser) ? links.browser : []).filter((t) => t && typeof t === "object" && t.workspace !== workspace && Number(t.until) > now);
    links.browser = [...others, ...tabs].sort((a, b) => (Number(b.drawn) || 0) - (Number(a.drawn) || 0)).slice(0, MAX_TABS);
  });
}

/** What each skill tells AnywhereLLM Lite's shelf, as times (ISO-8601, UTC), newest first: the
 *  Library's failed runs' ends, and each app's last change. Lite counts them and writes the words. */
export interface Status {
  library: { failed: string[] };
  apps: { changed: string[] };
}

/** Keeps `value` as the status of `kind`; no write when it is the one kept already. */
export async function noteStatus<K extends keyof Status>(kind: K, value: Status[K]): Promise<void> {
  const status = readAll().status as Record<string, unknown> | undefined;
  if (JSON.stringify(status?.[kind]) === JSON.stringify(value)) return;
  await change(`${kind}-lean couldn't keep its status`, (links) => {
    const kept = links.status && typeof links.status === "object" && !Array.isArray(links.status) ? (links.status as Record<string, unknown>) : {};
    kept[kind] = value;
    links.status = kept;
  });
}
