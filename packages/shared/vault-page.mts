// The Vault: one page where the user sees every secret the instance's vault keeps, by name and
// never by value, and deletes it: the browser's logins and passkeys, the library's API keys, OAuth
// sign-ins and signing keys. Each skill that keeps secrets bundles this module and serves the page itself, so
// either skill works installed alone; installed together, they serve the same page.
//
// The page (vault.html) lives under one random name in AnythingLLM's public folder
// (public/vault-lean/<token>.html), kept with the secret its events carry beside the vault
// (vault-lean/vault-page.json). Each skill writes only its own section's state beside it
// (<token>-logins.json, <token>-keys.json), nothing secret, and the page shows a tab for each
// section it finds: a skill installed alone shows its own. What the user does in a section is
// posted under that section's title (vault-lean-logins, vault-lean-keys) and applied by the skill
// that owns it, as its events come while the page was shown lately, and at the start of its calls.
//
// A skill shipping an older page doesn't write over a newer one another skill wrote (VERSION).
//
// With the switch on (#shared/page-links) the skills give the agent no link to the page. A page made
// before that, or while the switch was off, may have been given to it, so the first show after the
// switch goes on replaces the page's name and secret once (settle); the names carry a mark for it.
// Whatever the switch, show and rotate keep the page's path in the links file for whoever shows it
// to the user.

import fs from "node:fs";
import path from "node:path";
import { readJson, updateJson } from "./atomic.mts";
import { linksHidden, noteLink } from "./page-links.mts";
import { inTurn, listPublic, newSecret, pageHtml, publicPath, removePublic, sameSecret, takeEvents, watch, writePublic } from "./pages.mts";
import { vaultDir } from "./vault.mts";
import template from "./vault.html";

/** A section of the Vault, and the skill that owns it: logins (the browser), keys (the library). */
export type Section = "logins" | "keys";

/** The page's version: a skill writes the page unless the one there is newer. */
const VERSION = 5;
/** How long a section's events are watched for after the page was last shown for it. */
const WATCH_MS = 30 * 60 * 1000;
const MARKER = "vault_lean_event";

interface Names {
  token: string;
  secret: string;
  /** Made while the links were kept from the agent, and not given to it since. Absent: they may have been. */
  hidden?: true;
}

/** Keeps the Vault's link in the links file; a failure (a file that can't be written) is logged and
 *  never reaches the page or the answer that shows it. */
const keepLink = (rel: string): Promise<void> => noteLink("vault", rel).catch((e) => console.error(`vault-lean couldn't keep the page's link: ${(e as Error).message}`));

const namesFile = () => path.join(vaultDir(), "vault-page.json");
const fresh = (): Names => ({ token: newSecret(), secret: newSecret(), ...(linksHidden() ? { hidden: true as const } : {}) });
const readNames = (): Names | null => readJson<Names | null>(namesFile(), () => null);
/** A file of the Vault's in AnythingLLM's public folder. */
const pub = (name: string) => `vault-lean/${name}`;
/** The title a section's events are posted under, as the page posts them. */
export const titleOf = (section: Section): string => `vault-lean-${section}`;

/** Writes the page under `names`, unless the one there was written by a newer version of it. */
async function writePage(names: Names): Promise<void> {
  const file = publicPath(pub(`${names.token}.html`));
  let there = 0;
  try {
    there = Number(/"version":(\d+)/.exec(fs.readFileSync(file, "utf8"))?.[1] ?? 0);
  } catch {
    // no page yet
  }
  if (there <= VERSION) writePublic(pub(`${names.token}.html`), await pageHtml(template, { token: names.token, secret: names.secret, version: VERSION }));
}

/** Brings the names in line with the switch (#shared/page-links). Switch off: the mark goes, since
 *  the links go out again. Switch on, names not marked: what the section's page posted under the old
 *  secret is applied first, then the names are replaced, so the link the agent may have is dead. */
async function settle(section: Section, drain: () => Promise<void>): Promise<void> {
  const names = readNames();
  if (!names || !!names.hidden === linksHidden()) return;
  if (!linksHidden()) return void (await updateJson(namesFile(), fresh, (n) => void delete n.hidden));
  await inTurn(titleOf(section), drain);
  await rotateNames((n) => !n.hidden);
}

/** Writes the Vault's page and the section's `state` (nothing secret), and applies the section's
 *  events with `drain` as they come for a while (#shared/pages watch); answers the page's address,
 *  from AnythingLLM's address `base` (null: from the root of the host the link is opened on). */
export async function show(section: Section, state: unknown, drain: () => Promise<void>, base: string | null): Promise<string> {
  await settle(section, drain);
  const names = readNames() ?? (await updateJson(namesFile(), fresh, (n) => n));
  await writePage(names);
  writePublic(pub(`${names.token}-${section}.json`), JSON.stringify(state));
  // A hint for whoever shows the page to the user: a failure is only logged, the page is written.
  await keepLink(`/${pub(`${names.token}.html`)}`);
  const until = Date.now() + WATCH_MS;
  watch(titleOf(section), drain, () => until);
  return `${base ?? ""}/${pub(`${names.token}.html`)}`;
}

/** The page's address, as show answers it, when there's a Vault; else null. */
export function linkOf(base: string | null): string | null {
  const names = readNames();
  return names && `${base ?? ""}/${pub(`${names.token}.html`)}`;
}

/** Writes the section's state again, when there's a Vault. */
export function refresh(section: Section, state: unknown): void {
  const names = readNames();
  if (names) writePublic(pub(`${names.token}-${section}.json`), JSON.stringify(state));
}

/** The section's events posted since the last time, oldest first: only those with the Vault's secret. */
export function take(section: Section): Record<string, unknown>[] {
  const names = readNames();
  return takeEvents(titleOf(section), MARKER).filter((e) => !!names && sameSecret(e.secret, names.secret));
}

/** Runs `pass` in turn with the section's watch (#shared/pages inTurn). */
export const inTurnFor = (section: Section, pass: () => Promise<void>): Promise<void> => inTurn(titleOf(section), pass);

/** New names when `due` says so of the names as they are under the lock (always, by default); the
 *  old page goes, and each section's state moves under the new name. Answers the names now. */
async function rotateNames(due: (names: Names) => boolean = () => true): Promise<Names> {
  const existed = readNames() !== null;
  let old: Names | null = null;
  const now = await updateJson(namesFile(), fresh, (n) => {
    if (!due(n)) return { ...n };
    old = existed ? { token: n.token, secret: n.secret } : null;
    delete n.hidden;
    Object.assign(n, fresh());
    return { ...n };
  });
  if (old) {
    const { token } = old as Names;
    for (const file of listPublic(pub("")).filter((f) => f.startsWith(`${token}-`) && f.endsWith(".json"))) {
      fs.renameSync(publicPath(pub(file)), publicPath(pub(`${now.token}${file.slice(token.length)}`)));
    }
    removePublic(pub(`${token}.html`));
  }
  return now;
}

/** A new link: new names; the old page goes, and each section's state moves under the new name. */
export async function rotate(): Promise<void> {
  const now = await rotateNames();
  await writePage(now);
  // A hint for whoever shows the page to the user: a failure is only logged, the page is written.
  await keepLink(`/${pub(`${now.token}.html`)}`);
}
