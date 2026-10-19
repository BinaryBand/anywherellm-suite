// The user taking a tab over on its page: they take it (take) and hand it back (give); while they
// hold it they tap, scroll, type and go back or reload, and the agent reads but doesn't act. What
// they type is hidden from the agent like a login, and a password comes sealed with the vault's
// public key. After they sign in, the page offers to save the login, and a passkey a site makes
// while they hold the tab is offered the same way (passkey.ts). The page also says how much room it
// has (size), and the tab's screen follows it, so the tab fills a phone or a desktop window.
//
// The events come through page.ts, checked against the tab's secret. Ported from the lean
// browser's takeover.js.

import { Told } from "#shared/errors";
import { hostOf, onSite } from "#shared/fence";
import * as logins from "#shared/logins";
import * as vault from "#shared/vault";
import { act, element, fill, fillOn, isPassword, settle, settled } from "./act";
import { BrowserError, StaleRef } from "./errors";
import * as passkey from "./passkey";
import { type Entry, type Hold, OFFER_MS, type Tab, clamp, clip, holder, note, say, screenFor } from "./state";

const MAX_TEXT = 2000;
const MAX_SCROLL = 3000;
/** The events of a takeover. */
export const EVENTS = new Set(["take", "give", "tap", "scroll", "type", "nav", "size", "offer"]);
/** What the user does only while they hold the tab. */
const NEEDS_HOLD = new Set(["tap", "scroll", "type", "nav"]);

/** A BrowserError while the user holds the tab: the agent reads it, and acts once it's handed back. */
export function free(entry: Entry, key: string): void {
  if (holder(entry, key)) throw new BrowserError("the user has taken the tab over on its page: you can read it, but not act in it until they hand it back. Wait for them, then read the page");
}

/** Applies a takeover event to the tab `at`; answers whether the tab changed. What can't be done is
 *  said to the user, on the page. */
export async function apply(e: Record<string, unknown>, at: Tab): Promise<boolean> {
  try {
    return await step(e, at);
  } catch (err) {
    if (!(err instanceof Told)) throw err;
    say(at.entry, at.key, err instanceof StaleRef ? "That field changed on the page: tap it again" : err.message);
    return true;
  }
}

async function step(e: Record<string, unknown>, at: Tab): Promise<boolean> {
  const { entry, page, key } = at;
  const hold = holder(entry, key);
  if (NEEDS_HOLD.has(String(e.ev)) && !hold) throw new BrowserError("Take over the tab first");
  if (hold) hold.last = Date.now();
  switch (e.ev) {
    case "take":
      if (hold) return false;
      if (entry.busy.has(key)) throw new BrowserError("The agent is in the middle of a step: take over again in a moment");
      entry.holds.set(key, { last: Date.now(), typed: null });
      await passkey.reconcile();
      return true;
    case "give":
      if (!hold) return false;
      entry.holds.delete(key);
      note(entry, key, "the user had the tab and handed it back to you; what they typed stays hidden. Read the page before going on");
      say(at.entry, at.key, "Handed back to the agent");
      return true;
    case "tap": {
      const { width, height } = page.viewport() ?? { width: 1, height: 1 };
      await page.mouse.click(clamp(e.x, 0, width - 1), clamp(e.y, 0, height - 1));
      await settle(page); // a tap may load another page
      return true;
    }
    case "scroll":
      await page.mouse.wheel({ deltaY: clamp(e.dy, -MAX_SCROLL, MAX_SCROLL) });
      return true;
    case "type":
      await typed(at, hold!, e);
      await settle(page);
      return true;
    case "nav": {
      const action = e.do === "back" ? "back" : "reload";
      await act(page, action, "", "").catch(() => {}); // a page that doesn't finish loading is still drawn
      await settled(page, action);
      return true;
    }
    case "size": {
      const want = screenFor(e.w, e.h, e.dpr);
      entry.screens.set(key, want); // for every page the tab has from now on (browser.ts adopt)
      const now = page.viewport();
      if (now && now.width === want.width && now.height === want.height && now.deviceScaleFactor === want.deviceScaleFactor) return false;
      await page.setViewport(want);
      return true;
    }
    case "offer":
      return answerOffer(at, e.save === true);
    default:
      return false;
  }
}

/** Types what the user typed into a field: a password only sealed. It's hidden from the agent's
 *  reads from then on, and kept (with the username typed before it) for the offer to save. */
async function typed(at: Tab, hold: Hold, e: Record<string, unknown>): Promise<void> {
  const target = await element(at.page, clip(e.ref, 20));
  const password = await isPassword(target);
  if (password && !e.sealed) throw new BrowserError("A password has to come sealed: reload the page");
  const value = e.sealed ? vault.openSealed(clip(e.sealed, 20000)) : clip(e.text, MAX_TEXT);
  const host = hostOf(at.page.url());
  if (hold.typed?.host !== host) hold.typed = { host, user: "", pass: "" };
  hold.typed[password ? "pass" : "user"] = value;
  at.entry.secrets.add(value);
  await (password ? fillOn(target, value, host) : fill(target, value)); // a password only into the page's own document, never as keystrokes
  if (e.then === "Tab" || e.then === "Enter") await at.page.keyboard.press(e.then);
}

/** The user's answer to the login or passkey the page offered to save. */
async function answerOffer(at: Tab, save: boolean): Promise<boolean> {
  const offer = at.entry.offers.get(at.key);
  if (!offer || (offer.kind === "password" && offer.agreed)) return false;
  at.entry.offers.delete(at.key);
  if (offer.kind === "passkey") {
    if (!save) {
      await passkey.forget(offer.credential.credentialId);
      say(at.entry, at.key, "Not saved: remove the passkey in the site's own settings too");
      return true;
    }
    await logins.savePasskey(offer.site, offer.user, offer.credential);
    await passkey.spread(offer.credential, at.page);
    note(at.entry, at.key, `the user saved the passkey ${offer.site} made; the next time its sign-in asks for a passkey, it signs in by itself`);
  } else if (save) await logins.save(offer.site, offer.user, offer.pass);
  say(at.entry, at.key, save ? `Saved for ${offer.site}` : "Not saved");
  return true;
}

/** Before a tab is drawn: a login the user agreed to save is saved once its page no longer asks for a
 *  password (`asksPassword`: the login took), and one they typed while holding the tab is then
 *  offered on the page. An offer runs out, or goes when the tab leaves its site. */
export async function keepOffer(at: Tab, asksPassword: boolean): Promise<void> {
  const { entry, key } = at;
  const host = hostOf(at.page.url());
  const hold = holder(entry, key);
  if (!entry.offers.has(key) && hold?.typed?.pass && !asksPassword && onSite(host, hold.typed.host)) {
    const { host: site, user, pass } = hold.typed;
    hold.typed = null;
    const saved = logins.forHost(site);
    if (saved?.user !== user || saved?.pass !== pass) entry.offers.set(key, { kind: "password", site, user, pass, agreed: false, until: Date.now() + OFFER_MS });
  }
  const offer = entry.offers.get(key);
  if (!offer) return;
  if (offer.until <= Date.now() || !onSite(host, offer.site)) return void entry.offers.delete(key);
  if (offer.kind !== "password" || !offer.agreed || asksPassword) return;
  entry.offers.delete(key);
  await logins.save(offer.site, offer.user, offer.pass);
  note(entry, key, `the login the user entered was saved for ${offer.site}, for next time`);
}

/** The offer the tab's page shows the user, without its password or key; null for none. */
export function shownOffer(entry: Entry, key: string): { kind: string; site: string; user: string } | null {
  const offer = entry.offers.get(key);
  return offer && !(offer.kind === "password" && offer.agreed) && offer.until > Date.now() ? { kind: offer.kind, site: offer.site, user: offer.user } : null;
}
