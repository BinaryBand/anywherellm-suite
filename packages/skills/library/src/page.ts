// The library's pages, the user's own view of it on any device, served by AnythingLLM from its
// public folder (#shared/pages):
// - The Vault's keys section (#shared/vault-page, the page every skill that keeps secrets shares):
//   the API keys and OAuth sign-ins by name, never their values. The user adds a key or an OAuth
//   client there, sealed on their device with the vault's public key, and deletes one. It's where
//   the user gives a key or an OAuth client, from any chat (AnywhereLLM Lite too): the agent asks,
//   the need shows at the top of Keys, and the user enters it there.
// - The Library page (static/pages/library.html): the toolkits, their functions' sources and the
//   recent runs; the user deletes a function or a toolkit there.
// What the user does is applied at once while a page is open, and at the start of the agent's next
// call; library then shows it (a key saved, a sign-in signed in).
//
// The Library page's address holds a random token, and each event it posts carries a secret:
// anyone with the link can read what it shows and act on it, so it's shared as a signed-in session
// would be, and rotated (a new token and secret) from the page. The Vault has names of its own. An
// OAuth provider sends the user back to oauth.html, a fixed address; its event is taken only for a
// sign-in waiting with that state.
//
// The Vault also tells the skill AnythingLLM's address when ANYTHINGLLM_URL is unset: the https
// address it was opened at, sent with the client the user saves, which is the redirect address
// it showed them to register.

import fs from "node:fs";
import path from "node:path";
import { updateJson } from "#shared/atomic";
import { Told } from "#shared/errors";
import { inTurn, listPublic, newSecret, pageHtml, pageKey, removePublic, sameSecret, takeEvents, watch, writePublic } from "#shared/pages";
import * as vault from "#shared/vault";
import * as vaultPage from "#shared/vault-page";
import { LibraryError } from "./errors";
import * as listing from "./listing";
import { OAUTH_PAGE, PENDING_MS, finish, isState, redirectFor, waiting, type SignInState } from "./oauth";
import { outcomeOf, recentRuns } from "./runs";
import * as secrets from "./secrets";
import * as store from "./store";

const TITLE = "library-lean-event";
/** How long the page is watched for events after it was last shown. */
const WATCH_MS = 30 * 60 * 1000;
/** How long the agent's request for a key shows in the Vault. */
const NEED_MS = 30 * 60 * 1000;

interface Need {
  label: string;
  site: string;
  kind: "key" | "client";
  until: number;
}

interface PageFile {
  token: string;
  secret: string;
  needs: Need[];
  watchUntil: number;
  /** The https address the user opened the Vault at, as it said with a client it saved. */
  origin?: string | null;
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

/** A template of static/pages, as shipped or as tuned on this instance. */
function template(name: "library" | "oauth"): string {
  const file = store.statics().get(`pages/${name}.html`);
  if (!file) throw new LibraryError(`the page ${name}.html is missing from the skill`);
  return file.text;
}

/** Writes `text` to the public file `name` unless it holds it already. */
const putPublic = (name: string, text: string) => writePublic(pub(name), text);

/** AnythingLLM's address: `base`, the skill's ANYTHINGLLM_URL, or else the https address the
 *  Vault last said it was opened at (from `p`, page.json as read); null when neither is known. */
const resolved = (base: string | null, p: PageFile | null): string | null => base ?? p?.origin ?? null;

/** AnythingLLM's address, for the setting `base`, as the pages' state and links take it. */
export const baseFor = (base: string | null): string | null => resolved(base, read());

/** An address the Vault says it was opened at, when it's an https origin and nothing more. */
function httpsOriginOf(given: unknown): string | null {
  try {
    const url = new URL(String(given ?? ""));
    return url.protocol === "https:" && url.origin === String(given) ? url.origin : null;
  } catch {
    return null;
  }
}

/** The Library page's state, as it reads it: nothing secret. */
function state(base: string | null) {
  return {
    vault: vaultPage.linkOf(baseFor(base)),
    toolkits: store.services().map((service) => {
      const kit = store.toolkit(service)!;
      return { service, title: kit.title, base_urls: kit.base_urls, secrets: kit.secrets.map((s) => s.label), functions: store.functions(service).map((f) => ({ name: f.name, description: f.description, version: f.version, source: f.source })) };
    }),
    runs: recentRuns(20).map((r) => ({ id: r.id, fn: r.fn, status: r.status, trigger: r.trigger, ended: r.ended, ms: r.ms, error: r.error ? outcomeOf(r) : null, result: r.status === "ok" ? outcomeOf(r).slice(0, 500) : null })),
  };
}

/** A sign-in's tag on the Vault, by where it is. */
const TAGS: Record<SignInState["at"], string> = { "signed in": "Signed in", "code waits": "Enter the code", "link waits": "Open the link", "no client": "Needs a client", "ran out": "Not signed in", failed: "Not signed in", ready: "Not signed in" };

/** The Vault's keys section, as the Vault reads it: nothing secret. Each sign-in has its tag, and
 *  whether it's signed in, which the page shows as given. */
function keysState(p: PageFile | null, base: string | null) {
  const now = Date.now();
  return {
    redirect: redirectFor(resolved(base, p)),
    needs: (p?.needs ?? []).filter((n) => n.until > now).map(({ label, site, kind }) => ({ label, site, kind })),
    secrets: secrets.secrets().map((s) => (s.at ? { ...s, tag: { text: TAGS[s.at], ok: s.at === "signed in" } } : s)),
  };
}

const writeState = (p: PageFile, base: string | null) => putPublic(`${p.token}.json`, JSON.stringify(state(base)));

/** Writes the Library page and its state into AnythingLLM's public folder, watches for its events
 *  for a while, and answers its address (absolute when AnythingLLM's address, `base`, is known). */
export async function show(base: string | null): Promise<string> {
  const kept = read();
  const p = kept && kept.watchUntil - Date.now() > WATCH_MS / 2 ? kept : await change((p) => ((p.watchUntil = Date.now() + WATCH_MS), p));
  putPublic(`${p.token}.html`, await pageHtml(template("library"), { token: p.token, secret: p.secret, title: TITLE }));
  writeState(p, base);
  watch(TITLE, () => drain(base), () => read()?.watchUntil ?? 0);
  return `${resolved(base, p) ?? ""}/${pub(`${p.token}.html`)}`;
}

/** Writes the Vault with its keys section, watches for the section's events for a while, and
 *  answers its address (absolute when AnythingLLM's address is known). */
export function showVault(base: string | null): Promise<string> {
  const p = read();
  return vaultPage.show("keys", keysState(p, base), () => drainKeys(base), resolved(base, p));
}

/** Writes both pages' state again, where there are pages, as a run or a sign-in ends; a hint, so a
 *  failure is only logged. */
export function refresh(base: string | null): void {
  try {
    const p = read();
    if (p) writeState(p, base);
    vaultPage.refresh("keys", keysState(p, base));
  } catch (e) {
    console.error(`library-lean couldn't refresh the pages: ${(e as Error).message}`);
  }
}

/** Writes the oauth page, where a provider sends the user back, and the file it posts with for
 *  `state`, which names the sign-in `label` it says the user signed in to; removes those of
 *  sign-ins no longer waited for, and watches while one is. */
export async function oauthPage(state: string, label: string): Promise<void> {
  putPublic(path.basename(OAUTH_PAGE), template("oauth"));
  putPublic(`s-${state}.json`, JSON.stringify({ key: pageKey(), title: TITLE, label }));
  const keep = new Set(waiting().map((s) => `s-${s}.json`));
  for (const old of listPublic(pub("")).filter((f) => f.startsWith("s-") && !keep.has(f))) removePublic(pub(old));
  await change((p) => void (p.watchUntil = Math.max(p.watchUntil, Date.now() + PENDING_MS + 60 * 1000)));
}

/** Shows a need at the top of the Vault's keys: the agent asked for a key or a client the user gives there. */
export const need = (label: string, site: string, kind: Need["kind"]): Promise<void> =>
  change((p) => {
    p.needs = [...p.needs.filter((n) => n.label !== label && n.until > Date.now()), { label, site, kind, until: Date.now() + NEED_MS }];
  });

const text = (v: unknown, n = 500) => String(v ?? "").trim().slice(0, n);

/** A provider's redirect, as oauth.html (or the Vault's Finish a sign-in) posts it: taken only for a
 *  sign-in waiting with its state, which is the check, and the only one: anyone with the pages' key
 *  can post it. The state's file goes with the sign-in it was for. */
async function oauthCode(e: Record<string, unknown>): Promise<void> {
  const state = text(e.state, 200);
  if (isState(state) && (await finish(state, text(e.code, 4000) || null, text(e.error) || null))) removePublic(pub(`s-${state}.json`));
}

/** Applies one event the Library page (or oauth.html) posted; answers whether the functions changed,
 *  or the page asked for a new link. */
async function apply(e: Record<string, unknown>, secret: string): Promise<"relist" | "rotate" | null> {
  if (e.ev === "oauth-code") return (await oauthCode(e), null);
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
    case "oauth-code":
      await oauthCode(e);
      return null;
    case "key-save":
      await secrets.saveKey(secrets.siteChecked(e.site), secrets.labelOf(label), vault.openSealed(text(e.sealed, 20000)));
      return label;
    case "oauth-client": {
      const sealed = text(e.sealed, 20000);
      await secrets.saveClient(label, text(e.client_id), sealed ? vault.openSealed(sealed) : null);
      const at = httpsOriginOf(e.origin);
      if (at) await change((p) => void (p.origin = at));
      return label;
    }
    case "key-delete":
      await secrets.removeSecret(label);
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
  await vaultPage.inTurnFor("keys", () => drainKeys(base));
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
  } else writeState(read() ?? page, base);
  vaultPage.refresh("keys", keysState(read(), base)); // a sign-in oauth.html finished
}

/** Applies every event of the Vault's keys section since the last time, in order, then writes the
 *  section again, the needs met gone. One that fails is skipped; the Vault shows the state. */
async function drainKeys(base: string | null): Promise<void> {
  const events = vaultPage.take("keys", new Set(["oauth-code"]));
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
  vaultPage.refresh("keys", keysState(read(), base));
}
