// The library's pages, the user's own view of it on any device, served by AnythingLLM from its
// public folder (#shared/pages):
// - The Vault's keys section (#shared/vault-page, the page every skill that keeps secrets shares):
//   the API keys, OAuth sign-ins and signing keys by name, never their values. The user adds a key
//   there, sealed on their device with the vault's public key, and deletes a key or a sign-in; makes
//   a signing key or imports its seed, sealed the same way (signing.ts). It's where the
//   user gives a key, from any chat (AnywhereLLM Lite too): the agent asks, the need shows at the
//   top of Keys, and the user enters it there.
// - The Library page (static/pages/library.html): the targets (machines the functions run commands
//   on over SSH; the user registers one there, with a key pasted or made, sealed on their device
//   with the vault's public key), the toolkits, their functions' sources and the recent runs; the
//   user deletes a function, a toolkit or a target there.
// What the user does is applied at once while a page is open, and at the start of the agent's next
// call; library then shows it (a key saved, a target tried).
//
// The Library page's address holds a random token, and each event it posts carries a secret:
// anyone with the link can read what it shows and act on it, so it's shared as a signed-in session
// would be, and rotated (a new token and secret) from the page. The Vault has names of its own.
//
// The owner can keep the Library page's and the Vault's links from the agent (#shared/page-links:
// `anywherellm-suite pages --hide`). Names made while that switch was off, or before it existed,
// may have been given to the agent, so the first time the page is shown after the switch goes on
// they are replaced once (settle), and the page's names are marked `hidden`. Either way the page's
// path is kept in the links file, for whoever shows it to the user.

import path from "node:path";
import * as addresses from "#shared/addresses";
import { mask } from "#shared/answer";
import { Told } from "#shared/errors";
import { inTurn, pageHtml, sameSecret, takeEvents, watch, writePublic } from "#shared/pages";
import { linksHidden } from "#shared/page-links";
import { type Names, tokenPage } from "#shared/token-page";
import * as vault from "#shared/vault";
import * as vaultPage from "#shared/vault-page";
import { LibraryError } from "./errors";
import * as listing from "./listing";
import { outcomeOf, recentRuns } from "./runs";
import * as secrets from "./secrets";
import * as signing from "./signing";
import * as store from "./store";
import * as targets from "./targets";

const TITLE = "library-lean-event";
/** How long the page is watched for events after it was last shown. */
const WATCH_MS = 30 * 60 * 1000;
/** How long the agent's request for a key shows in the Vault, or for a target on the Library page. */
const NEED_MS = 30 * 60 * 1000;

interface Need {
  label: string;
  site: string;
  /** A key is given on the Vault; a target is registered on the Library page. */
  kind: "key" | "target";
  until: number;
}

/** How the last thing the page was asked to do that it can show went: a refusal (the skill's own
 *  words), or a target saved. `n` counts them, so the page knows one is new. */
interface Result {
  n: number;
  ev: string;
  label: string;
  error: string | null;
}

interface PageFile extends Names {
  needs: Need[];
  watchUntil: number;
  result?: Result;
}

const pageFile = () => path.join(store.libraryDir(), "page.json");
/** A file of the skill's in AnythingLLM's public folder. */
const pub = (name: string) => `library-lean/${name}`;

/** The page's names and what it keeps beside them (#shared/token-page): its files are <token>.html
 *  and <token>.json; anything else in its folder (the targets' reach-*.txt) isn't the page's. */
const names = tokenPage<PageFile>({
  kind: "library",
  folder: "library-lean",
  file: pageFile,
  what: "the Library page",
  fresh: (n) => ({ ...n, needs: [], watchUntil: 0 }),
  pattern: /^([\w-]{12,})(\.html|\.json)$/,
});

/** page.json as it is now, to read (null where it can't be); changes go through `change`, under its lock. */
function read(): PageFile | null {
  try {
    return names.read();
  } catch {
    return null;
  }
}

const change = names.change;

/** The Library page's template in static/pages, as shipped or as tuned on this instance. */
function template(): string {
  const file = store.statics().get("pages/library.html");
  if (!file) throw new LibraryError("the page library.html is missing from the skill");
  return file.text;
}

/** Writes `text` to the public file `name` unless it holds it already; answers the name. */
const put = (name: string, text: string): string => (writePublic(pub(name), text), name);

/** The Library page's state, as it reads it: nothing secret. */
function state(p: PageFile, base: string | null) {
  const now = Date.now();
  return {
    vault: vaultPage.linkOf(base),
    needs: p.needs.filter((n) => n.kind === "target" && n.until > now).map(({ label, site }) => ({ label, site })),
    targets: targets.targets().map((m) => ({ ...m, held: store.heldBy(m.label) })),
    result: p.result ?? null,
    toolkits: store.services().map((service) => {
      const kit = store.toolkit(service)!;
      return { service, title: kit.title, locked: kit.locked === true, reach: store.reach(kit), secrets: kit.secrets.map((s) => s.label), functions: store.functions(service).map((f) => ({ name: f.name, description: f.description, version: f.version, source: f.source })) };
    }),
    runs: recentRuns(20).map((r) => ({ id: r.id, fn: r.fn, status: r.status, trigger: r.trigger, ended: r.ended, ms: r.ms, error: r.error ? outcomeOf(r) : null, result: r.status === "ok" ? outcomeOf(r).slice(0, 500) : null })),
  };
}

/** The Vault's keys section, as the Vault reads it: nothing secret. */
function keysState(p: PageFile | null) {
  const now = Date.now();
  return {
    needs: (p?.needs ?? []).filter((n) => n.kind === "key" && n.until > now).map(({ label, site }) => ({ label, site })),
    secrets: secrets.secrets(),
    signing: signing.signingKeys(),
  };
}

/** Writes the page's state again under the names as they are, where there is a page. */
const writeState = (base: string | null): void => names.refresh((p) => [put(`${p.token}.json`, JSON.stringify(state(p, base)))]);

/** Writes the Library page and its state into AnythingLLM's public folder, watches for its events
 *  for a while, and answers its address (absolute when AnythingLLM's address, `base`, is known). */
export async function show(base: string | null): Promise<string> {
  const hidden = linksHidden();
  return write(base, await names.settle(() => inTurn(TITLE, () => drain(base)), hidden), hidden);
}

/** What every library call does before its own work, with or without a page to show: the page's names
 *  made to fit the switch (#shared/token-page settleCall), so that the links the agent held go dead at
 *  the first call after the switch went on, not at the next one that shows the page. */
export const settle = (base: string | null): Promise<void> => names.settleCall(() => inTurn(TITLE, () => drain(base)), (hidden) => write(base, true, hidden));

/** show without settle: what a drain calls, being in its turn already (settle waits for the turn).
 *  `rotated` says the token was just replaced, which the links file records. */
async function write(base: string | null, rotated = false, hidden = linksHidden()): Promise<string> {
  const kept = read();
  if (!kept || kept.watchUntil - Date.now() <= WATCH_MS / 2) await change((p) => void (p.watchUntil = Date.now() + WATCH_MS));
  const p = await names.publish(async (n) => [put(`${n.token}.html`, await pageHtml(template(), { token: n.token, secret: n.secret, title: TITLE })), put(`${n.token}.json`, JSON.stringify(state(n, base)))], rotated, hidden);
  watch(TITLE, () => drain(base), () => read()?.watchUntil ?? 0);
  return `${base ?? ""}/${pub(`${p.token}.html`)}`;
}

/** Writes the Vault with its keys and addresses sections, watches for their events for a while, and
 *  answers its address (absolute when AnythingLLM's address is known). */
export async function showVault(base: string | null): Promise<string> {
  const link = await vaultPage.show("keys", keysState(read()), () => drainKeys(), base);
  addresses.show(base);
  return link;
}

/** Writes both pages' state again, where there are pages, as a run ends; a hint, so a failure is
 *  only logged. */
export function refresh(base: string | null): void {
  try {
    writeState(base);
    vaultPage.refresh("keys", keysState(read()));
  } catch (e) {
    console.error(`library-lean couldn't refresh the pages: ${(e as Error).message}`);
  }
  addresses.refresh(); // a refusal of the run's
}

/** Writes the Vault's keys section again, where there is a Vault, as a sign-in starts or ends. */
export const refreshKeys = (): void => vaultPage.refresh("keys", keysState(read()));

/** What makes a need the same as another: a key and a target can share a label. */
const needId = (kind: Need["kind"], label: string) => `${kind}:${label}`;

/** Shows a need: at the top of the Vault's keys, where the agent asked for a key the user gives, or
 *  of the Library page's Targets, where it asked for a machine the user registers. */
export const need = (label: string, site: string, kind: Need["kind"] = "key"): Promise<void> =>
  change((p) => {
    p.needs = [...p.needs.filter((n) => needId(n.kind, n.label) !== needId(kind, label) && n.until > Date.now()), { label, site, kind, until: Date.now() + NEED_MS }];
  });

const text = (v: unknown, n = 500) => String(v ?? "").trim().slice(0, n);

/** What applying an event did beyond the store: a need it met, a new link, a function gone from the
 *  skill's description, a target to try signing in to, or a change the page shows. */
type Applied = { met?: string; rotate?: true; relist?: true; check?: string; changed?: true } | null;

/** Applies one event the Library page posted. */
async function apply(e: Record<string, unknown>, secret: string): Promise<Applied> {
  if (!sameSecret(e.secret, secret)) return null; // not this page's: an old link's, or a forgery
  const label = text(e.label, 60);
  switch (e.ev) {
    case "fn-delete": {
      const { service, name } = store.qualified(e.fn);
      store.removeFn(service, name);
      return { relist: true };
    }
    case "toolkit-delete":
      store.removeToolkit(store.serviceOf(e.service));
      return { relist: true };
    case "toolkit-lock":
    case "toolkit-unlock":
      await store.setLocked(store.serviceOf(e.service), e.ev === "toolkit-lock");
      return { relist: true };
    case "target-save": {
      const sealed = text(e.sealed, 20000);
      const name = await targets.save({ label, host: e.host, port: e.port, login: e.login, fingerprint: e.fingerprint, private: e.private, unattended: e.unattended, key: sealed ? vault.openSealed(sealed) : "" });
      return { met: needId("target", name), check: name };
    }
    case "target-check":
      return { check: targets.nameOf(label) };
    case "target-delete":
      await targets.remove(label);
      return { changed: true };
    case "rotate":
      return { rotate: true };
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

/** The Vault's names made to fit the switch, its keys section's queued events (which this skill's
 *  drain applies) first; with no page to write. */
export const settleVault = (): Promise<void> => vaultPage.settle("keys", drainKeys);

/** Applies what both pages posted, for a call, each in its turn with its watch's (#shared/pages inTurn). */
export const caughtUp = async (base: string | null): Promise<void> => {
  await inTurn(TITLE, () => drain(base));
  await vaultPage.inTurnFor("keys", drainKeys);
  await addresses.caughtUp(base);
};

/** What goes back to the agent when masking the text can't be done: nothing of the error. */
const PAGES_WRONG = "something went wrong with the pages: see the log";

/** `text` fit to go back to the agent: while the links are kept from it, both pages' tokens and
 *  secrets are hidden (a page's path never is in an error: #shared/pages tells a failure by its code);
 *  as it is otherwise. If the names can't be read to hide them, nothing of the text goes back: a
 *  generic line, and the detail is in the log. It never throws. */
export function plain(text: string): string {
  if (!linksHidden()) return text;
  try {
    const known = [names.read(), vaultPage.names()].flatMap((n) => (n ? [n.token, n.secret] : []));
    if (!known.every((s) => typeof s === "string")) throw new Error("a names file holds no token or secret");
    return mask(text, known);
  } catch (e) {
    console.error(`library-lean couldn't hide the pages' names in a text for the agent (${(e as Error)?.message ?? "error"}); it is told only that something went wrong`);
    return PAGES_WRONG;
  }
}

/** Applies every event the Library page posted since the last time, in order, then writes its state
 *  again (or a new page, after a rotate). One the skill refuses is skipped, and its words go to the
 *  page in the state's `result`; so does a target saved, which tells the form it can clear. */
async function drain(base: string | null): Promise<void> {
  const events = takeEvents(TITLE, "library_lean_event");
  if (!events.length) return;
  const page = read() ?? (await change((p) => p));
  const applied: Applied[] = [];
  let result: Omit<Result, "n"> | null = null;
  for (const e of events) {
    try {
      const done = await apply(e, page.secret);
      applied.push(done);
      if (e.ev === "target-save" && done) result = { ev: "target-save", label: text(e.label, 60), error: null }; // a forgery is dropped, and says nothing
    } catch (err) {
      // The events are taken already: one that breaks (not a refusal) is logged, and the rest go on.
      // Whatever breaks is told to the page: a form left waiting for an answer that never comes holds
      // what the user typed and stops the section being drawn. A refusal says its words; anything else
      // is only logged, with a plain line for the page.
      const told = err instanceof Told;
      if (!told) console.error(`library-lean couldn't apply a page event (${text(e.ev, 40)}): ${(err as Error).message}`);
      result = { ev: text(e.ev, 40), label: text(e.label, 60), error: told ? err.message.slice(0, 400) : e.ev === "target-save" ? "couldn't save the target (see the log)" : "couldn't do that (see the log)" };
    }
  }
  const outcome = result;
  if (outcome) await change((p) => void (p.result = { n: (p.result?.n ?? 0) + 1, ...outcome }));
  const met = new Set(applied.flatMap((a) => (a?.met ? [a.met] : [])));
  const rotate = applied.some((a) => a?.rotate);
  if (applied.some((a) => a?.relist)) listing.refresh();
  if (met.size) await change((p) => void (p.needs = p.needs.filter((n) => !met.has(needId(n.kind, n.label)))));
  if (rotate) {
    await names.rotate();
    await write(base, true);
  } else if (result || applied.some(Boolean)) writeState(base);
  // A sign-in takes up to 20 s: tried after the turn, so neither the page nor the agent waits on it.
  const checks = new Set(applied.flatMap((a) => (a?.check ? [a.check] : [])));
  if (checks.size) void Promise.all([...checks].map((l) => targets.check(l, base))).then(() => refresh(base), (e) => console.error(`library-lean couldn't try a target: ${(e as Error).message}`));
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
      if (!(err instanceof Told)) console.error(`library-lean couldn't apply a Vault event (${text(e.ev, 40)}): ${(err as Error).message}`);
    }
  }
  if (met.size) await change((p) => void (p.needs = p.needs.filter((n) => !(n.kind === "key" && met.has(n.label)))));
  vaultPage.refresh("keys", keysState(read()));
}
