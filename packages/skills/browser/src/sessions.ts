// A workspace's browser sessions, its cookies, kept beside the vault in a sealed file of their own
// (#shared/vault writeSealed: encrypted with the vault's key, and changed without rewriting the
// vault): Chrome runs with a profile made for it in a temporary folder, and what it's signed in to
// is saved here and given back when it starts again. A profile kept in the storage held cookies
// that anyone reading the folder could use. Partitioned cookies and what sites keep elsewhere
// (localStorage, IndexedDB) aren't kept: a site that keeps its sign-in there signs in again, with
// the saved login.

import crypto from "node:crypto";
import * as vault from "#shared/vault";
import type { Browser, CDPSession } from "./host";

const fileOf = (workspace: string): string => `session-${workspace}`;
/** What Storage.setCookies takes of what Storage.getCookies gives, besides expires. */
const FIELDS = ["name", "value", "domain", "path", "secure", "httpOnly", "sameSite", "priority", "sourceScheme", "sourcePort"];

type Cookie = Record<string, unknown>;

/** Runs `fn` with a DevTools session on the browser itself, whose Storage domain holds every cookie. */
async function withSession<T>(browser: Browser, fn: (cdp: CDPSession) => Promise<T>): Promise<T> {
  const cdp = await browser.target().createCDPSession();
  try {
    return await fn(cdp);
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** The cookies worth keeping, as setCookies takes them, in a stable order: not run out, not
 *  partitioned; one that ends with the browser (session) is kept too, so a sign-in lasts. */
function keepable(cookies: Cookie[], now = Date.now() / 1000): Cookie[] {
  return cookies
    .filter((c) => !c.partitionKey && (c.session || !(Number(c.expires) > 0) || Number(c.expires) > now))
    .map((c) => {
      const kept: Cookie = Object.fromEntries(FIELDS.filter((f) => c[f] !== undefined).map((f) => [f, c[f]]));
      if (!c.session && Number(c.expires) > 0) kept.expires = c.expires;
      return kept;
    })
    .sort((a, b) => `${a.domain}\0${a.path}\0${a.name}`.localeCompare(`${b.domain}\0${b.path}\0${b.name}`));
}

const digest = (cookies: Cookie[]): string => crypto.createHash("sha256").update(JSON.stringify(cookies)).digest("hex");

/** Gives a newly started browser the workspace's saved cookies; answers what's saved now, to
 *  compare a later save with. */
export async function restore(workspace: string, browser: Browser): Promise<string> {
  const cookies = keepable((vault.readSealed(fileOf(workspace)) as Cookie[] | null) ?? []);
  if (cookies.length) await withSession(browser, (cdp) => cdp.send("Storage.setCookies", { cookies }));
  return digest(cookies);
}

/** Saves the browser's cookies for the workspace, unless they're what `last` says was saved;
 *  answers what's saved now. */
export async function save(workspace: string, browser: Browser, last: string | null): Promise<string> {
  const { cookies } = (await withSession(browser, (cdp) => cdp.send("Storage.getCookies"))) as { cookies: Cookie[] };
  const kept = keepable(cookies);
  const now = digest(kept);
  if (now !== last) vault.writeSealed(fileOf(workspace), kept.length ? kept : null);
  return now;
}
