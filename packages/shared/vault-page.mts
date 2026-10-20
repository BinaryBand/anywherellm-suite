// The Vault: one page where the user sees every secret the instance's vault keeps, by name and
// never by value, and deletes it: the browser's logins and passkeys, the library's API keys and
// OAuth sign-ins. Each skill that keeps secrets bundles this module and serves the page itself, so
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

import fs from "node:fs";
import path from "node:path";
import { readJson, updateJson } from "./atomic.mts";
import { inTurn, listPublic, newSecret, pageHtml, publicPath, removePublic, sameSecret, takeEvents, watch, writePublic } from "./pages.mts";
import { vaultDir } from "./vault.mts";
import template from "./vault.html";

/** A section of the Vault, and the skill that owns it: logins (the browser), keys (the library). */
export type Section = "logins" | "keys";

/** The page's version: a skill writes the page unless the one there is newer. */
const VERSION = 2;
/** How long a section's events are watched for after the page was last shown for it. */
const WATCH_MS = 30 * 60 * 1000;
const MARKER = "vault_lean_event";

interface Names {
  token: string;
  secret: string;
}

const namesFile = () => path.join(vaultDir(), "vault-page.json");
const fresh = (): Names => ({ token: newSecret(), secret: newSecret() });
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

/** Writes the Vault's page and the section's `state` (nothing secret), and applies the section's
 *  events with `drain` as they come for a while (#shared/pages watch); answers the page's address,
 *  from AnythingLLM's address `base` (null: from the root of the host the link is opened on). */
export async function show(section: Section, state: unknown, drain: () => Promise<void>, base: string | null): Promise<string> {
  const names = readNames() ?? (await updateJson(namesFile(), fresh, (n) => n));
  await writePage(names);
  writePublic(pub(`${names.token}-${section}.json`), JSON.stringify(state));
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

/** The section's events posted since the last time, oldest first: only those with the Vault's
 *  secret, but for the kinds in `open`, which carry a check of their own (a provider's redirect). */
export function take(section: Section, open: ReadonlySet<string> = new Set()): Record<string, unknown>[] {
  const names = readNames();
  return takeEvents(titleOf(section), MARKER).filter((e) => open.has(String(e.ev)) || (!!names && sameSecret(e.secret, names.secret)));
}

/** Runs `pass` in turn with the section's watch (#shared/pages inTurn). */
export const inTurnFor = (section: Section, pass: () => Promise<void>): Promise<void> => inTurn(titleOf(section), pass);

/** A new link: new names; the old page goes, and each section's state moves under the new name. */
export async function rotate(): Promise<void> {
  const old = readNames();
  const now = await updateJson(namesFile(), fresh, (n) => Object.assign(n, fresh()));
  if (old) {
    for (const file of listPublic(pub("")).filter((f) => f.startsWith(`${old.token}-`) && f.endsWith(".json"))) {
      fs.renameSync(publicPath(pub(file)), publicPath(pub(`${now.token}${file.slice(old.token.length)}`)));
    }
    removePublic(pub(`${old.token}.html`));
  }
  await writePage(now);
}
