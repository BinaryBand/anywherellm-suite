// The Library page: the user's own view of the library, on any device, served by AnythingLLM from
// its public folder (#shared/pages). It shows the secrets by name (never their values) and lets the
// user add a key or an OAuth client, sealed on their device with the vault's public key, and
// register a target (a machine the functions run commands on, with a key pasted or made here); it shows
// the toolkits, their functions' sources and the recent runs, and lets the user delete a function or
// a toolkit. It's where the user gives a key or an OAuth client, from any chat (AnywhereLLM Lite
// too): the agent asks, the need shows at the top of the page, and the user enters it there. What the user does is
// applied at once while the page is open, and at the start of the agent's next call; library then
// shows it (a key saved, a sign-in signed in).
//
// The page's address holds a random token, and each event it posts carries a secret: anyone with
// the link can read what it shows and act on it, so it's shared as a signed-in session would be,
// and rotated (a new token and secret) from the page. An OAuth provider sends the user back to
// oauth.html, a fixed address; its event is taken only for a sign-in waiting with that state.

import fs from "node:fs";
import path from "node:path";
import { updateJson, writeAtomicIfChanged } from "#shared/atomic";
import { Told } from "#shared/errors";
import { listPublic, newSecret, pageHtml, pageKey, publicDir, removePublic, sameSecret, takeEvents, watch, inTurn } from "#shared/pages";
import * as vault from "#shared/vault";
import { LibraryError } from "./errors";
import * as listing from "./listing";
import { OAUTH_PAGE, PENDING_MS, finish, redirectFor, waiting } from "./oauth";
import * as secrets from "./secrets";
import { recentRuns } from "./runs";
import * as store from "./store";
import * as targets from "./targets";

export const TITLE = "library-lean-event";
/** How long the page is watched for events after it was last shown. */
const WATCH_MS = 30 * 60 * 1000;
/** How long the agent's request for a key shows on the page. */
const NEED_MS = 30 * 60 * 1000;

interface Need {
  label: string;
  site: string;
  kind: "key" | "client" | "target";
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

/** A template of static/pages, as shipped or as tuned on this instance. */
function template(name: "library" | "oauth"): string {
  const file = store.statics().get(`pages/${name}.html`);
  if (!file) throw new LibraryError(`the page ${name}.html is missing from the skill`);
  return file.text;
}

/** Writes `text` to the public file `name` unless it holds it already. */
const putPublic = (name: string, text: string) => writeAtomicIfChanged(path.join(publicDir(), pub(name)), text, 0o644);

/** The page's state, as it reads it: nothing secret. */
function state(p: PageFile, base: string | null) {
  const now = Date.now();
  return {
    redirect: redirectFor(base),
    needs: p.needs.filter((n) => n.until > now).map(({ label, site, kind }) => ({ label, site, kind })),
    secrets: secrets.secrets(),
    targets: targets.targets(),
    toolkits: store.services().map((service) => {
      const kit = store.toolkit(service)!;
      return { service, title: kit.title, secrets: kit.secrets.map((s) => s.label), reach: store.reach(kit), functions: store.functions(service).map((f) => ({ name: f.name, description: f.description, version: f.version, source: f.source })) };
    }),
    runs: recentRuns(20).map((r) => ({ id: r.id, fn: r.fn, status: r.status, trigger: r.trigger, ended: r.ended, ms: r.ms, error: r.error ? `${r.error.name}: ${r.error.message}` : null, result: r.status === "ok" ? (JSON.stringify(r.result) ?? "null").slice(0, 500) : null })),
  };
}

const writeState = (p: PageFile, base: string | null) => putPublic(`${p.token}.json`, JSON.stringify(state(p, base)));

/** Writes the page and its state into AnythingLLM's public folder, watches for its events for a
 *  while, and answers its address (absolute when AnythingLLM's address, `base`, is known). */
export async function show(base: string | null): Promise<string> {
  const kept = read();
  const p = kept && kept.watchUntil - Date.now() > WATCH_MS / 2 ? kept : await change((p) => ((p.watchUntil = Date.now() + WATCH_MS), p));
  putPublic(`${p.token}.html`, await pageHtml(template("library"), store.libraryDir(), { token: p.token, secret: p.secret, title: TITLE }));
  writeState(p, base);
  watch(TITLE, () => drain(base), () => read()?.watchUntil ?? 0);
  return `${base ?? ""}/${pub(`${p.token}.html`)}`;
}

/** Writes the page's state again, when there's a page, as a run ends. */
export function refresh(base: string | null): void {
  const p = read();
  if (p) writeState(p, base);
}

/** Writes the oauth page, where a provider sends the user back, and the file it posts with for
 *  `state`; removes those of sign-ins no longer waited for, and watches while one is. */
export async function oauthPage(state: string): Promise<void> {
  putPublic(path.basename(OAUTH_PAGE), template("oauth"));
  putPublic(`s-${state}.json`, JSON.stringify({ key: await pageKey(store.libraryDir()), title: TITLE }));
  const keep = new Set(waiting().map((s) => `s-${s}.json`));
  for (const old of listPublic(pub("")).filter((f) => f.startsWith("s-") && !keep.has(f))) removePublic(pub(old));
  await change((p) => void (p.watchUntil = Math.max(p.watchUntil, Date.now() + PENDING_MS + 60 * 1000)));
}

/** Shows a need at the top of the page: the agent asked for a key or a client the user gives there. */
export const need = (label: string, site: string, kind: Need["kind"]): Promise<void> =>
  change((p) => {
    p.needs = [...p.needs.filter((n) => !(n.kind === kind && n.label === label) && n.until > Date.now()), { label, site, kind, until: Date.now() + NEED_MS }];
  });

const text = (v: unknown, n = 500) => String(v ?? "").trim().slice(0, n);

/** What applying an event did beyond the vault and the store: a need it met, a new link, a
 *  function gone from the skill's description, or a target to try signing in to. */
type Applied = { met?: string; rotate?: true; relist?: true; check?: string } | null;

/** Applies one event the page posted. */
async function apply(e: Record<string, unknown>, secret: string): Promise<Applied> {
  if (e.ev === "oauth-code") {
    // A provider's redirect: taken only for a sign-in waiting with its state, which is the check.
    const state = text(e.state, 200);
    await finish(state, text(e.code, 4000) || null, text(e.error) || null);
    removePublic(pub(`s-${state}.json`));
    return null;
  }
  if (!sameSecret(e.secret, secret)) return null; // not this page's: an old link's, or a forgery
  const label = text(e.label, 60);
  switch (e.ev) {
    case "key-save":
      await secrets.saveKey(secrets.siteChecked(e.site), secrets.labelOf(label), vault.openSealed(text(e.sealed, 20000)));
      return { met: `key:${label}` };
    case "oauth-client": {
      const sealed = text(e.sealed, 20000);
      await secrets.saveClient(label, text(e.client_id), sealed ? vault.openSealed(sealed) : null);
      return { met: `client:${label}` };
    }
    case "key-delete":
      await secrets.removeSecret(label);
      return null;
    case "target-save": {
      const sealed = text(e.sealed, 20000);
      const name = await targets.save({ label, host: e.host, port: e.port, login: e.login, fingerprint: e.fingerprint, private: e.private, unattended: e.unattended, key: sealed ? vault.openSealed(sealed) : "" });
      return { met: `target:${name}`, check: name };
    }
    case "target-check":
      return { check: targets.nameOf(label) };
    case "target-delete":
      await targets.remove(label);
      return null;
    case "fn-delete": {
      const { service, name } = store.qualified(e.fn);
      store.removeFn(service, name);
      return { relist: true };
    }
    case "toolkit-delete":
      store.removeToolkit(store.serviceOf(e.service));
      return { relist: true };
    case "rotate":
      return { rotate: true };
    default:
      return null;
  }
}

/** Applies what the page posted, for a call, in its turn with the watch's (#shared/pages inTurn). */
export const caughtUp = (base: string | null): Promise<void> => inTurn(TITLE, () => drain(base));

/** Applies every event the page posted since the last time, in order, then writes the page's state
 *  again (or a new page, after a rotate). One that fails is skipped; the page shows the state. */
async function drain(base: string | null): Promise<void> {
  const events = takeEvents(TITLE, "library_lean_event");
  if (!events.length) return;
  const page = read() ?? (await change((p) => p));
  const applied: Applied[] = [];
  for (const e of events) {
    try {
      applied.push(await apply(e, page.secret));
    } catch (err) {
      if (!(err instanceof Told)) throw err;
    }
  }
  const met = new Set(applied.flatMap((a) => (a?.met ? [a.met] : [])));
  const rotate = applied.some((a) => a?.rotate);
  if (applied.some((a) => a?.relist)) listing.refresh();
  const now = await change((p) => {
    p.needs = p.needs.filter((n) => !met.has(`${n.kind}:${n.label}`));
    if (rotate) Object.assign(p, { token: newSecret(), secret: newSecret() });
    return p;
  });
  if (rotate) {
    removePublic(pub(`${page.token}.html`));
    removePublic(pub(`${page.token}.json`));
    await show(base);
  } else writeState(now, base);
  // A sign-in takes up to 20 s: tried after the turn, so neither the page nor the agent waits on it.
  const checks = new Set(applied.flatMap((a) => (a?.check ? [a.check] : [])));
  if (checks.size) void Promise.all([...checks].map(targets.check)).then(() => refresh(base), (e) => console.error(`library-lean couldn't try a target: ${(e as Error).message}`));
}
