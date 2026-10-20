// The library's pages, the user's own view of it on any device, served by AnythingLLM from its
// public folder (#shared/pages):
// - The Vault's keys section (#shared/vault-page, the page every skill that keeps secrets shares):
//   the API keys, OAuth sign-ins and signing keys by name, never their values. The user adds a key
//   there, sealed on their device with the vault's public key, and deletes a key or a sign-in; makes
//   a signing key or imports its seed, sealed the same way (signing.ts). It's where the
//   user gives a key, from any chat (AnywhereLLM Lite too): the agent asks, the need shows at the
//   top of Keys, and the user enters it there.
// - The Library page (static/pages/library.html): the toolkits, their functions' sources and the
//   recent runs; the user deletes a function or a toolkit there.
// What the user does is applied at once while a page is open, and at the start of the agent's next
// call; library then shows it (a key saved).
//
// The Library page's address holds a random token, and each event it posts carries a secret:
// anyone with the link can read what it shows and act on it, so it's shared as a signed-in session
// would be, and rotated (a new token and secret) from the page. The Vault has names of its own.

import fs from "node:fs";
import path from "node:path";
import { updateJson } from "#shared/atomic";
import { Told } from "#shared/errors";
import { inTurn, newSecret, pageHtml, removePublic, sameSecret, takeEvents, watch, writePublic } from "#shared/pages";
import * as vault from "#shared/vault";
import * as vaultPage from "#shared/vault-page";
import { LibraryError } from "./errors";
import * as listing from "./listing";
import { outcomeOf, recentRuns } from "./runs";
import * as secrets from "./secrets";
import * as signing from "./signing";
import * as store from "./store";

const TITLE = "library-lean-event";
/** How long the page is watched for events after it was last shown. */
const WATCH_MS = 30 * 60 * 1000;
/** How long the agent's request for a key shows in the Vault. */
const NEED_MS = 30 * 60 * 1000;

interface Need {
  label: string;
  site: string;
  until: number;
}

interface PageFile {
  token: string;
  secret: string;
  needs: Need[];
  watchUntil: number;
}

const pageFile = () => path.join(store.libraryDir(), "page.json");
const fresh = (): PageFile => ({ token: newSecret(), secret: newSecret(), needs: [], watchUntil: 0 });
/** A file of the skill's in AnythingLLM's public folder. */
const pub = (name: string) => `library-lean/${name}`;

/** page.json as it is now, to read; changes go through `change`, under its lock. */
function read(): PageFile | null {
  try {
    return JSON.parse(fs.readFileSync(pageFile(), "utf8")) as PageFile;
  } catch {
    return null;
  }
}

const change = <T,>(fn: (p: PageFile) => T): Promise<T> => updateJson(pageFile(), fresh, fn);

/** The Library page's template in static/pages, as shipped or as tuned on this instance. */
function template(): string {
  const file = store.statics().get("pages/library.html");
  if (!file) throw new LibraryError("the page library.html is missing from the skill");
  return file.text;
}

/** Writes `text` to the public file `name` unless it holds it already. */
const putPublic = (name: string, text: string) => writePublic(pub(name), text);

/** The Library page's state, as it reads it: nothing secret. */
function state(base: string | null) {
  return {
    vault: vaultPage.linkOf(base),
    toolkits: store.services().map((service) => {
      const kit = store.toolkit(service)!;
      return { service, title: kit.title, base_urls: kit.base_urls, secrets: kit.secrets.map((s) => s.label), functions: store.functions(service).map((f) => ({ name: f.name, description: f.description, version: f.version, source: f.source })) };
    }),
    runs: recentRuns(20).map((r) => ({ id: r.id, fn: r.fn, status: r.status, trigger: r.trigger, ended: r.ended, ms: r.ms, error: r.error ? outcomeOf(r) : null, result: r.status === "ok" ? outcomeOf(r).slice(0, 500) : null })),
  };
}

/** The Vault's keys section, as the Vault reads it: nothing secret. */
function keysState(p: PageFile | null) {
  const now = Date.now();
  return {
    needs: (p?.needs ?? []).filter((n) => n.until > now).map(({ label, site }) => ({ label, site })),
    secrets: secrets.secrets(),
    signing: signing.signingKeys(),
  };
}

const writeState = (p: PageFile, base: string | null) => putPublic(`${p.token}.json`, JSON.stringify(state(base)));

/** Writes the Library page and its state into AnythingLLM's public folder, watches for its events
 *  for a while, and answers its address (absolute when AnythingLLM's address, `base`, is known). */
export async function show(base: string | null): Promise<string> {
  const kept = read();
  const p = kept && kept.watchUntil - Date.now() > WATCH_MS / 2 ? kept : await change((p) => ((p.watchUntil = Date.now() + WATCH_MS), p));
  putPublic(`${p.token}.html`, await pageHtml(template(), { token: p.token, secret: p.secret, title: TITLE }));
  writeState(p, base);
  watch(TITLE, () => drain(base), () => read()?.watchUntil ?? 0);
  return `${base ?? ""}/${pub(`${p.token}.html`)}`;
}

/** Writes the Vault with its keys section, watches for the section's events for a while, and
 *  answers its address (absolute when AnythingLLM's address is known). */
export function showVault(base: string | null): Promise<string> {
  return vaultPage.show("keys", keysState(read()), () => drainKeys(), base);
}

/** Writes both pages' state again, where there are pages, as a run ends; a hint, so a failure is
 *  only logged. */
export function refresh(base: string | null): void {
  try {
    const p = read();
    if (p) writeState(p, base);
    vaultPage.refresh("keys", keysState(p));
  } catch (e) {
    console.error(`library-lean couldn't refresh the pages: ${(e as Error).message}`);
  }
}

/** Writes the Vault's keys section again, where there is a Vault, as a sign-in starts or ends. */
export const refreshKeys = (): void => vaultPage.refresh("keys", keysState(read()));

/** Shows a need at the top of the Vault's keys: the agent asked for a key the user gives there. */
export const need = (label: string, site: string): Promise<void> =>
  change((p) => {
    p.needs = [...p.needs.filter((n) => n.label !== label && n.until > Date.now()), { label, site, until: Date.now() + NEED_MS }];
  });

const text = (v: unknown, n = 500) => String(v ?? "").trim().slice(0, n);

/** Applies one event the Library page posted; answers whether the functions changed, or the page
 *  asked for a new link. */
async function apply(e: Record<string, unknown>, secret: string): Promise<"relist" | "rotate" | null> {
  if (!sameSecret(e.secret, secret)) return null; // not this page's: an old link's, or a forgery
  switch (e.ev) {
    case "fn-delete": {
      const { service, name } = store.qualified(e.fn);
      store.removeFn(service, name);
      return "relist";
    }
    case "toolkit-delete":
      store.removeToolkit(store.serviceOf(e.service));
      return "relist";
    case "rotate":
      return "rotate";
    default:
      return null;
  }
}

/** Applies one event of the Vault's keys section (#shared/vault-page take checked its secret);
 *  answers the need it met, if any. */
async function applyKeys(e: Record<string, unknown>): Promise<string | null> {
  const label = text(e.label, 60);
  switch (e.ev) {
    case "key-save":
      await secrets.saveKey(secrets.siteChecked(e.site), secrets.labelOf(label), vault.openSealed(text(e.sealed, 20000)));
      return label;
    case "key-delete":
      await secrets.removeSecret(label);
      return null;
    case "signing-new":
      await signing.create(secrets.labelOf(label), signing.namespaceOf(e.namespace));
      return null;
    case "signing-import":
      await signing.importSeed(secrets.labelOf(label), signing.namespaceOf(e.namespace), vault.openSealed(text(e.sealed, 20000)));
      return null;
    case "signing-delete":
      await signing.removeSigning(label);
      return null;
    case "signing-unattended":
      await signing.setUnattended(label, e.on === true);
      return null;
    case "rotate":
      await vaultPage.rotate();
      return null;
    default:
      return null;
  }
}

/** Applies what both pages posted, for a call, each in its turn with its watch's (#shared/pages inTurn). */
export const caughtUp = async (base: string | null): Promise<void> => {
  await inTurn(TITLE, () => drain(base));
  await vaultPage.inTurnFor("keys", drainKeys);
};

/** Applies every event the Library page posted since the last time, in order, then writes its state
 *  again (or a new page, after a rotate). One that fails is skipped; the page shows the state. */
async function drain(base: string | null): Promise<void> {
  const events = takeEvents(TITLE, "library_lean_event");
  if (!events.length) return;
  const page = read() ?? (await change((p) => p));
  const applied: ("relist" | "rotate" | null)[] = [];
  for (const e of events) {
    try {
      applied.push(await apply(e, page.secret));
    } catch (err) {
      if (!(err instanceof Told)) throw err;
    }
  }
  if (applied.includes("relist")) listing.refresh();
  if (applied.includes("rotate")) {
    await change((p) => void Object.assign(p, { token: newSecret(), secret: newSecret() }));
    removePublic(pub(`${page.token}.html`));
    removePublic(pub(`${page.token}.json`));
    await show(base);
  } else if (applied.some(Boolean)) writeState(read() ?? page, base);
}

/** Applies every event of the Vault's keys section since the last time, in order, then writes the
 *  section again, the needs met gone. One that fails is skipped; the Vault shows the state. */
async function drainKeys(): Promise<void> {
  const events = vaultPage.take("keys");
  if (!events.length) return;
  const met = new Set<string>();
  for (const e of events) {
    try {
      const label = await applyKeys(e);
      if (label) met.add(label);
    } catch (err) {
      if (!(err instanceof Told)) throw err;
    }
  }
  if (met.size) await change((p) => void (p.needs = p.needs.filter((n) => !met.has(n.label))));
  vaultPage.refresh("keys", keysState(read()));
}
