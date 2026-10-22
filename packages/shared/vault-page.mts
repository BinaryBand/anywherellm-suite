// The Vault: one page where the user sees every secret the instance's vault keeps, by name and
// never by value, and deletes it: the browser's logins and passkeys, the library's API keys and
// signing keys; and the addresses on their network they let the skills reach
// (addresses.mts). Each skill that keeps secrets bundles this module and serves the page itself, so
// either skill works installed alone; installed together, they serve the same page.
//
// The page (vault.html) lives under one random name in AnythingLLM's public folder
// (public/vault-lean/<token>.html), kept with the secret its events carry beside the vault
// (vault-lean/vault-page.json). Each skill writes only its own section's state beside it
// (<token>-logins.json, <token>-keys.json) and the addresses section's (<token>-addresses.json),
// nothing secret, and the page shows a tab for each section it finds: a skill installed alone shows
// its own. What the user does in a section is posted under that
// section's title (vault-lean-logins, vault-lean-keys, vault-lean-addresses) and applied by the
// skill that owns it (either, for the addresses), as its events come while the page was shown
// lately, and at the start of its calls.
//
// A skill shipping an older page doesn't write over a newer one another skill wrote (VERSION).
//
// With the switch on (#shared/page-links) the skills give the agent no link to the page. A page made
// before that, or while the switch was off, may have been given to it, so the first show after the
// switch goes on replaces the page's name and secret once (settle); the names carry a mark for it.
// Whatever the switch, show and rotate keep the page's path in the links file for whoever shows it
// to the user.

import path from "node:path";
import { linksHidden } from "./page-links.mts";
import { inTurn, pageHtml, readPublic, sameSecret, takeEvents, watch, writePublic } from "./pages.mts";
import { type Names, tokenPage } from "./token-page.mts";
import { vaultDir } from "./vault.mts";
import template from "./vault.html";

/** A section of the Vault, and the skill that owns it: logins (the browser), keys (the library),
 *  addresses (both). */
export type Section = "logins" | "keys" | "addresses";

/** The page's version: a skill writes the page unless the one there is newer. */
const VERSION = 11;
/** How long a section's events are watched for after the page was last shown for it. */
const WATCH_MS = 30 * 60 * 1000;
const MARKER = "vault_lean_event";

/** The Vault's names (#shared/token-page): its page is <token>.html, and each section's state
 *  <token>-<section>.json, the token being at least 8 base64url characters; a section's state moves
 *  under a new token, since another skill may own it. */
const page = tokenPage<Names>({
  kind: "vault",
  folder: "vault-lean",
  file: () => path.join(vaultDir(), "vault-page.json"),
  what: "the Vault",
  fresh: (names) => names,
  pattern: /^([A-Za-z0-9_-]{8,})(\.html|-(?:logins|keys|addresses)\.json)$/,
  carried: (rest) => rest !== ".html",
});

/** A file of the Vault's in AnythingLLM's public folder. */
const pub = (name: string) => `vault-lean/${name}`;
/** The title a section's events are posted under, as the page posts them. */
const titleOf = (section: Section): string => `vault-lean-${section}`;


/** Writes the page under `names`, unless the one there was written by a newer version of it; answers its name. */
async function writePage(names: Names): Promise<string> {
  const name = `${names.token}.html`;
  const there = readPublic(pub(name));
  if (Number(/"version":(\d+)/.exec(there ?? "")?.[1] ?? 0) <= VERSION) writePublic(pub(name), await pageHtml(template, { token: names.token, secret: names.secret, version: VERSION }), there);
  return name;
}

/** Writes the page and the files `write` answers under the names (#shared/token-page publish). */
const publish = (write: (names: Names) => string[], rotated = false, hidden = linksHidden()): Promise<Names> =>
  page.publish(async (n) => [await writePage(n), ...write(n)], rotated, hidden);

/** Brings the names in line with the switch (#shared/page-links) at the start of a skill's call that
 *  may show no page (#shared/token-page settleCall): what the section's page posted under the old
 *  secret is applied first (with `drain`). Nothing without a Vault. */
export const settle = (section: Section, drain: () => Promise<void>): Promise<void> =>
  page.settleCall(() => inTurn(titleOf(section), drain), (hidden) => publish(() => [], true, hidden));

/** Writes the Vault's page and the section's `state` (nothing secret), and applies the section's
 *  events with `drain` as they come for a while (#shared/pages watch); answers the page's address,
 *  from AnythingLLM's address `base` (null: from the root of the host the link is opened on). */
export async function show(section: Section, state: unknown, drain: () => Promise<void>, base: string | null): Promise<string> {
  const hidden = linksHidden();
  const rotated = await page.settle(() => inTurn(titleOf(section), drain), hidden);
  const names = await publish((n) => [page.put(`${n.token}-${section}.json`, JSON.stringify(state))], rotated, hidden);
  watchFor(section, drain);
  return `${base ?? ""}/${pub(`${names.token}.html`)}`;
}

/** Applies the section's events with `drain` as they come for a while (#shared/pages watch), as
 *  show does for the section it writes. */
export function watchFor(section: Section, drain: () => Promise<void>): void {
  const until = Date.now() + WATCH_MS;
  watch(titleOf(section), drain, () => until);
}

/** The Vault's names, or null where there's no Vault; an error where they can't be read. */
export const names = (): Names | null => page.read();

/** The page's address, as show answers it, when there's a Vault; else null. */
export function linkOf(base: string | null): string | null {
  const n = page.read();
  return n && `${base ?? ""}/${pub(`${n.token}.html`)}`;
}

/** Writes the section's state again, when there's a Vault. */
export const refresh = (section: Section, state: unknown): void => page.refresh((n) => [page.put(`${n.token}-${section}.json`, JSON.stringify(state))]);

/** The section's events posted since the last time, oldest first: only those with the Vault's secret. */
export function take(section: Section): Record<string, unknown>[] {
  // The events first, the names after: a rotation in between leaves the names newer than the events,
  // which are then dropped (they carry the old secret), never the other way round.
  const events = takeEvents(titleOf(section), MARKER);
  const n = page.read();
  return events.filter((e) => !!n && sameSecret(e.secret, n.secret));
}

/** Runs `pass` in turn with the section's watch (#shared/pages inTurn). */
export const inTurnFor = (section: Section, pass: () => Promise<void>): Promise<void> => inTurn(titleOf(section), pass);

/** A new link: new names; the old page goes, and each section's state moves under the new name. */
export async function rotate(): Promise<void> {
  const hidden = linksHidden();
  await page.rotate(undefined, hidden);
  await publish(() => [], true, hidden);
}
