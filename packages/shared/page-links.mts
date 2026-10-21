// Whether the Library and Vault pages' links are kept from the agent, and where the user finds them
// then. The switch is a file in the suite's folder of the storage, `page-links-hidden`, which the
// owner makes and removes on the host (`anywherellm-suite pages --hide` / `--show`). It is the
// owner's file, but code that runs in the container can write it, so it is a switch for what the
// skills tell the agent, not a lock against the agent's own tools. With it present the skills still write their pages, but their answers carry no
// link to the Library page or the Vault. The links file, `page-links.json`, holds the two paths for
// whoever may show them to the user (the bridge, `anywherellm-suite pages`): it is written whether
// the switch is on or off, and each skill owns its own key; `rotated` says when each page's token was
// last replaced by a rotation (so `pages` can tell which link is new). It holds no event secret and no page key,
// but a path in it is a bearer capability (whoever fetches the page gets the secret its HTML
// embeds), so it is kept like the page key: 0600, never logged.

import fs from "node:fs";
import path from "node:path";
import { SUITE_DIR, storageDir } from "./anythingllm.mts";
import { readJson, updateJson } from "./atomic.mts";

export type PageKind = "library" | "vault";
export type Links = Partial<Record<PageKind, string>>;

/** The switch: its presence means the links are kept from the agent. */
export const hiddenFile = (storage: string = storageDir()): string => path.join(storage, SUITE_DIR, "page-links-hidden");

/** Where the two pages' root-relative paths are kept. */
export const linksFile = (storage: string = storageDir()): string => path.join(storage, SUITE_DIR, "page-links.json");

/** Whether the links are kept from the agent now; read each time, never kept. */
export const linksHidden = (storage: string = storageDir()): boolean => fs.existsSync(hiddenFile(storage));

/** Where the user opens the pages when the agent isn't given their links. */
export const OPEN_PAGES = "in AnywhereLLM Lite, or with `anywherellm-suite pages` on the AnythingLLM host";

/** The links kept now; none for a page not shown yet. A file that can't be read or parsed is none:
 *  the links are derived from the pages and written again at the next show. Only strings are kept;
 *  the rotation stamps are for whoever shows the links (the installer's `pages` reads them). */
export function readLinks(storage: string = storageDir()): Links {
  try {
    const found = readJson<Record<string, unknown>>(linksFile(storage), () => ({}));
    const links: Links = {};
    for (const kind of ["library", "vault"] as const) if (typeof found[kind] === "string") links[kind] = found[kind] as string;
    return links;
  } catch {
    return {};
  }
}

/** Keeps `rel` (root-relative, like "/vault-lean/<token>.html") as the link of `kind`, without
 *  touching the other page's. No write when it is the link already, unless `rotated`: the token was
 *  just replaced by a rotation, and the time is kept beside the link. A hint for whoever shows the
 *  page to the user: a failure (a file that can't be written) is logged, and never reaches the page
 *  or the answer that shows it. */
export async function noteLink(kind: PageKind, rel: string, rotated = false): Promise<void> {
  if (readLinks()[kind] === rel && !rotated) return;
  const file = linksFile();
  const keep = (links: Record<string, unknown>) => {
    links[kind] = rel;
    if (rotated) {
      const stamps = links.rotated && typeof links.rotated === "object" ? (links.rotated as Record<string, unknown>) : {};
      stamps[kind] = new Date().toISOString();
      links.rotated = stamps;
    }
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Read as a fresh start: a damaged file is derived data, replaced by the next write.
    await updateJson<Record<string, unknown>, void>(file, () => ({}), keep).catch(async (e) => {
      if (!(e instanceof SyntaxError)) throw e;
      fs.rmSync(file, { force: true });
      await updateJson<Record<string, unknown>, void>(file, () => ({}), keep);
    });
  } catch (e) {
    console.error(`${kind}-lean couldn't keep the page's link: ${(e as Error)?.message ?? e}`);
  }
}
