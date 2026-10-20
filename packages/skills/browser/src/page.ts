// A tab's card and its page. After each step the tab's picture is taken and written into
// AnythingLLM's public folder (public/browser-lean/, served to any browser), with a small state file
// beside it (its title and address, what the agent asks the user for, where the Vault is) and
// the tab's page (static/pages/tab.html), all under a random name kept for the chat's tab. The card
// the agent puts in its reply is a crop of the picture that opens the page.
//
// The page is where the user gives what only they may know: a login or a code the agent asked for,
// sealed on their device with the vault's public key, posted through AnythingLLM's browser-extension
// upload (#shared/pages), checked against the tab's secret and typed into the tab here; never on
// AnythingLLM's question card, which shows its answers in the chat. There they also take the tab
// over to use it themselves (takeover.ts) and save what it offers. The saved logins are listed and
// deleted on the Vault (#shared/vault-page), whose logins section this skill writes and applies,
// and which the tab's page links to.
// Events are applied as they come while a page was shown lately, and at the start of each call.

import fs from "node:fs";
import path from "node:path";
import { writeAtomic } from "#shared/atomic";
import { Told } from "#shared/errors";
import { hostOf } from "#shared/fence";
import * as logins from "#shared/logins";
import { inTurn, newSecret, pageHtml, publicPath, removePublic, sameSecret, takeEvents, watch, writePublic } from "#shared/pages";
import * as vault from "#shared/vault";
import * as vaultPage from "#shared/vault-page";
import { isUnsent, submitted, typeIn } from "./act";
import * as passkey from "./passkey";
import { type Snap, asksPassword, fieldOf, isPasswordLine, lineOf, readPage } from "./snapshot";
import { type Entry, NEED_MS, type Need, OFFER_MS, type Tab, VIEWPORT, clip, holder, live, note, say, state, statics, workspaceDir } from "./state";
import * as takeover from "./takeover";

const TITLE = "browser-lean-event";
/** How long the pages' events are watched for after one was last shown. */
const WATCH_MS = 30 * 60 * 1000;
const QUALITY = 70;
/** A tab's files: its picture, the card's crop, its state and its page. */
const ENDINGS = [".jpg", "-card.jpg", ".json", ".html"];
const MAX_TEXT = 500;

/** The page as just read, for drawing it: its title, and its elements and fields. */
type Read = { snap: Snap; title: string };

type Names = { token: string; secret: string };

const tabsFile = (workspace: string) => path.join(workspaceDir(workspace), "tabs.json");
/** A tab's file in the public folder, by one of ENDINGS. */
const pub = (token: string, ending: string) => `browser-lean/${token}${ending}`;

function readTabs(workspace: string): Record<string, Names> {
  try {
    return JSON.parse(fs.readFileSync(tabsFile(workspace), "utf8"));
  } catch {
    return {};
  }
}

const saveTabs = (workspace: string, tabs: Record<string, Names>) => writeAtomic(tabsFile(workspace), JSON.stringify(tabs, null, 2), 0o600);

/** A thread's tab's names, kept in tabs.json: its token names its files; its secret goes with every
 *  event its page posts. Made the first time unless `make` is false (then null). */
function namesOf(workspace: string, key: string, make = true): Names | null {
  const tabs = readTabs(workspace);
  if (tabs[key]?.token && tabs[key]?.secret) return tabs[key];
  if (!make) return null;
  tabs[key] = { token: newSecret(), secret: newSecret(24) };
  saveTabs(workspace, tabs);
  return tabs[key];
}

/** When a thread's tab closes: its files go, its state says so, for its page to show, and its names
 *  are dropped, so a link to it opens nothing again and the next tab gets new ones. */
export function forgetTab(workspace: string, key: string): void {
  const tabs = readTabs(workspace);
  const token = tabs[key]?.token;
  if (!token) return;
  delete tabs[key];
  try {
    saveTabs(workspace, tabs);
    for (const ending of ENDINGS) removePublic(pub(token, ending));
    writePublic(pub(token, ".json"), JSON.stringify({ closed: true }));
  } catch {
    // no folder to write in
  }
}

/** What the agent waits for the user to enter on the tab's page, or null: one that ran out goes. */
const pendingNeed = (entry: Entry, key: string): Need | null => live(entry.needs, key);

/** Text a card's Markdown can hold: no brackets or line breaks. */
const plain = (text: string, n = 120) => text.replace(/[[\]()\n\r|*_`<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

/** The tab's state, as its page reads it: nothing secret. Who has the tab; while the user does, the
 *  fields in view, for the page to type into. */
function tabState(at: Tab, title: string, url: string, snap: Snap, vaultLink: string | null) {
  const host = hostOf(url);
  const need = pendingNeed(at.entry, at.key);
  const screen = at.page.viewport() ?? VIEWPORT;
  const held = !!holder(at.entry, at.key);
  const msg = live(at.entry.msgs, at.key);
  return {
    title: title.slice(0, 200),
    url: url.slice(0, 2000),
    host,
    shot: Date.now(),
    size: { w: screen.width, h: screen.height },
    who: held ? "user" : "agent",
    fields: held ? snap.fields : [],
    need: need ? { kind: need.kind, host: need.host, text: need.text, label: need.label ?? null, hasUser: !!need.userRef, confirm: !!need.confirmRef, until: need.until } : null,
    offer: takeover.shownOffer(at.entry, at.key),
    msg: msg && { text: msg.text, id: msg.id },
    vault: vaultLink,
  };
}

/** Takes the tab's picture (and with `card`, the card's crop) and writes its state, from the page as
 *  just read, and its page (with the card, or when it has none); answers the page's token, or null
 *  where AnythingLLM's public folder can't be written (AnythingLLM Desktop) or no page key is set. */
async function draw(at: Tab, card: boolean, { snap, title }: Read): Promise<string | null> {
  await takeover.keepOffer(at, asksPassword(snap)); // before the state shows the offer
  const names = namesOf(at.workspace, at.key)!;
  try {
    const shot = publicPath(pub(names.token, ""));
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    await at.page.screenshot({ path: `${shot}.jpg`, type: "jpeg", quality: QUALITY });
    if (card) {
      const { width, height } = at.page.viewport() ?? VIEWPORT;
      await at.page.screenshot({ path: `${shot}-card.jpg`, type: "jpeg", quality: QUALITY, clip: { x: 0, y: 0, width, height: Math.min(height, Math.round(width * 1.2)), scale: 0.5 } });
    }
    writePublic(pub(names.token, ".json"), JSON.stringify(tabState(at, title, at.page.url(), snap, await showVault())));
    if (card || !fs.existsSync(`${shot}.html`)) writePublic(pub(names.token, ".html"), await pageHtml(statics().get("pages/tab.html")!.text, { token: names.token, secret: names.secret, title: TITLE, workspace: at.workspace, tab: at.key }));
  } catch {
    return null;
  }
  const until = Date.now() + WATCH_MS;
  watch(TITLE, drain, () => until);
  return names.token;
}

/** Draws the tab `at` for the agent's answer, from the page as just read: its card's Markdown lines
 *  (a crop of its picture that opens its page, then its title and address; those alone where there's
 *  no picture) and whether it has a page the user can answer on. `base` is the address the user's
 *  browser reaches AnythingLLM at (null: links from its own root). */
export async function card(at: Tab, base: string | null, read: Read): Promise<{ lines: string[]; page: boolean }> {
  const token = await draw(at, true, read);
  const { title } = read;
  const url = at.page.url();
  const host = hostOf(url);
  const name = plain(title) || plain(host || url);
  const lines = [`**${name}** · ${plain(host || url, 200)}`];
  if (!token) return { lines, page: false };
  const link = `${base ?? ""}/browser-lean/${token}`;
  return { lines: [`[![${name}](${link}-card.jpg?v=${Date.now().toString(36)})](${link}.html)`, "", ...lines], page: true };
}

const NOTHING_READ: Snap = { elements: [], text: "", more: false, fields: [] };

/** Draws `at` for its page alone: read only when the user holds it (its fields) or an offer waits on
 *  the page asking for a password; the picture and the title otherwise. */
async function redrawn(at: Tab): Promise<void> {
  const read = holder(at.entry, at.key) || at.entry.offers.has(at.key) ? await readPage(at.page) : { snap: NOTHING_READ, title: await at.page.title().catch(() => "") };
  await draw(at, false, read);
}

/** Draws a thread's tab again, for its page, in turn with the events' passes: what changed there came
 *  from outside a step (a passkey a site made, say). */
export const redraw = (workspace: string, entry: Entry, key: string): Promise<void> =>
  inTurn(TITLE, async () => {
    const page = entry.tabs.get(key);
    if (page && !page.isClosed()) await redrawn({ workspace, entry, page, key });
  });

const text = (v: unknown, n = MAX_TEXT) => clip(v, n);

/** Applies one event the page of `at` posted; answers whether the tab changed. */
async function apply(e: Record<string, unknown>, at: Tab): Promise<boolean> {
  if (takeover.EVENTS.has(String(e.ev))) return takeover.apply(e, at);
  const need = pendingNeed(at.entry, at.key);
  if (e.ev === "need-cancel") {
    const instead = e.reason === "takeover";
    if (need) note(at.entry, at.key, instead ? "the user is taking the tab over to enter it themselves instead; wait for them to hand it back, then read the page" : "the user chose not to enter it now, so nothing was typed; tell them you can't go on without it");
    at.entry.needs.delete(at.key);
    return !!need;
  }
  if (e.ev !== "need-answer" || !need) return false;
  const login = need.kind === "login";
  const secret = login ? vault.openSealed(text(e.sealed, 20000)) : text(e.text).trim();
  const user = login ? text(e.user).trim() : "";
  if (!secret || (need.userRef && !user)) return false;
  at.entry.needs.delete(at.key);
  const left = await typeIn(at, need.host, { userRef: need.userRef, user, secretRef: need.secretRef, confirmRef: need.confirmRef, secret, keys: !login }, need.submitRef);
  if (login && need.userRef && e.save === true) at.entry.offers.set(at.key, { kind: "password", site: need.host, user, pass: secret, agreed: true, until: Date.now() + OFFER_MS });
  const sent = `the user entered ${login ? "the login" : "the code"} you asked for on the tab's page and it was typed into the page${submitted(need.submitRef, left)}`;
  const hidden = "it stays hidden from you. Read the page to see whether it worked";
  if (isUnsent(left)) {
    // Not sent, so nothing was refused: the form needs something else first (a CAPTCHA, say).
    const [needs, verb] = left.disabled ? ["something else", "finish"] : [left.missing.map((m) => (m.label ? `"${m.label}"` : "another field")).join(", "), "fill"];
    say(at.entry, at.key, `${login ? "Your login is" : "The code is"} in; the page still needs ${needs} before it can be sent: take the tab over to ${verb} it`);
  }
  const asking = need.submitRef && !isUnsent(left) ? await stillAsks(at, need) : null;
  if (!asking) return note(at.entry, at.key, `${sent}; ${hidden}`), true;
  // Likely refused: a login the user asked to save isn't kept; they're asked again where the same
  // field is still there, else told on the page.
  at.entry.offers.delete(at.key);
  const it = login ? "a password" : "the code";
  const told = `${need.host} still asks for ${it}: it may not have been accepted.`;
  const refused = `${sent}, but the page still asks for ${it}: the site may have refused it.`;
  if (asking === "same") {
    at.entry.needs.set(at.key, { ...need, text: `${told} Check it and enter it again`, until: Date.now() + NEED_MS });
    note(at.entry, at.key, `${refused} The user is asked again on the tab's page; wait for them, then read the page`);
  } else {
    say(at.entry, at.key, `${told} Take the tab over to try again, or ask the agent to.`);
    note(at.entry, at.key, `${refused} Read the page, tell the user, and use login again if they want to retry`);
  }
  return true;
}

/** After a login or a code was typed and submitted: whether its site still asks for it. "same" when
 *  the field it went into is still there under its ref (the same kind and label: a new page numbers
 *  its refs again; a login: still a password field), so the same request can go again; "other" when
 *  that field is there under another ref (the page moved it), or a login's page shows another
 *  password field; else null. A guess, not proof: a site that refuses a login usually keeps asking,
 *  and one that takes it moves on. */
async function stillAsks(at: Tab, need: Need): Promise<"same" | "other" | null> {
  if (hostOf(at.page.url()) !== need.host) return null;
  const { snap } = await readPage(at.page);
  const line = lineOf(snap, need.secretRef);
  if (line && (!need.field || fieldOf(line) === need.field) && (need.kind === "code" || isPasswordLine(line))) return "same";
  if (need.field && snap.elements.some((l) => fieldOf(l) === need.field)) return "other";
  return need.kind === "login" && asksPassword(snap) ? "other" : null;
}

/** Applies what the tabs' pages posted, for a call, in its turn with the watch's (#shared/pages inTurn). */
export const caughtUp = async (): Promise<void> => {
  await inTurn(TITLE, drain);
  await vaultPage.inTurnFor("logins", drainLogins);
};

/** The saved logins and passkeys, as the Vault's logins section shows them: never a password or a key. */
const loginsState = () => ({ logins: logins.list() });

/** Writes the Vault with its logins section and watches for the section's events for a while;
 *  answers its path on this host, for the tab's page to link to. */
const showVault = (): Promise<string> => vaultPage.show("logins", loginsState(), drainLogins, null);

/** Applies what the user did in the Vault's logins section since the last time (#shared/vault-page
 *  take checked its secret): a deleted passkey leaves every tab's authenticator at once. Then writes
 *  the section again. */
async function drainLogins(): Promise<void> {
  const events = vaultPage.take("logins");
  if (!events.length) return;
  for (const e of events) {
    if (e.ev === "login-delete") {
      const gone = await logins.remove(text(e.id, 100));
      if (gone?.kind === "passkey") await passkey.forget(gone.credentialId);
    } else if (e.ev === "rotate") await vaultPage.rotate();
  }
  vaultPage.refresh("logins", loginsState());
}

/** Applies every event the tabs' pages posted since the last time, in order, each only with its
 *  tab's secret; then draws each tab that changed. One that fails is skipped, and its tab says so. */
async function drain(): Promise<void> {
  const changed = new Set<Tab>();
  for (const e of takeEvents(TITLE, "browser_lean_event")) {
    const workspace = text(e.workspace, 100);
    const key = text(e.tab, 100);
    let names: Names | null;
    try {
      names = namesOf(workspace, key, false);
    } catch {
      continue; // no such workspace
    }
    if (!names || !sameSecret(e.secret, names.secret)) continue; // not this tab's: an old link's, or a forgery
    const entry = state().browsers.get(workspace);
    const page = entry?.tabs.get(key);
    if (!entry || !page || page.isClosed()) continue; // the tab closed meanwhile
    const at = [...changed].find((t) => t.page === page) ?? { workspace, entry, page, key };
    entry.touch(); // the browser isn't closed under the user
    try {
      if (await apply(e, at)) changed.add(at);
    } catch (err) {
      if (!(err instanceof Told)) throw err;
      note(at.entry, at.key, `what the user entered on the tab's page couldn't be used: ${err.message}`);
      changed.add(at);
    }
  }
  for (const at of changed) at.entry.changed(); // a login typed, a takeover's step: its cookies may have changed
  await Promise.all([...changed].map(redrawn));
}
