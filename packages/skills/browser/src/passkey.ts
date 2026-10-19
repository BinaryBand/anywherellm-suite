// Passkeys, a kind of saved login. Every chat's tab has a virtual authenticator, Chrome's software
// passkey store reached through the DevTools Protocol's WebAuthn domain, holding the saved passkeys:
// a site's passkey sign-in then works for the agent as a saved password does, and Chrome itself
// keeps each passkey to its own site. A tab without one would hang when a site asks for a passkey,
// since headless Chrome has no dialog to show.
//
// A passkey a site makes while the user holds the tab is offered to them for saving, as a typed
// password is; one made while the agent has it is taken out again, so only the user adds passkeys.
// After a sign-in the passkey's signature count is kept, and given to the other tabs, so it never
// goes back. Ported from the lean browser's passkey.js.

import { perProcess } from "#shared/anythingllm";
import { onSite } from "#shared/fence";
import * as logins from "#shared/logins";
import type { Credential } from "#shared/logins";
import type { Page } from "./host";
import { type Authenticator, type Entry, OFFER_MS, firstLine, holder, note, state } from "./state";

const OPTIONS = { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true };
const send = (a: Authenticator, method: string, params: Record<string, unknown>) => a.cdp.send(method, { authenticatorId: a.id, ...params }).catch(() => {});

/** What Chrome gives as a credential, as addCredential takes it back. */
const asCredential = (c: Partial<Credential>): Credential => ({ isResidentCredential: true, signCount: 0, ...c }) as Credential;

/** Gives `page`, a tab of thread `key` in `entry`'s browser, an authenticator holding the saved
 *  passkeys. `changed` draws the tab again when its page has something new to show the user. */
export async function attach(entry: Entry, key: string, page: Page, changed: () => void): Promise<void> {
  let a: Authenticator;
  try {
    const cdp = await page.target().createCDPSession();
    await cdp.send("WebAuthn.enable", { enableUI: false });
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: OPTIONS });
    a = { cdp, id: authenticatorId };
  } catch (e) {
    return note(entry, key, `passkeys don't work in this tab (${firstLine(e)}): a site's passkey sign-in won't answer, so use its password sign-in`);
  }
  entry.authenticators.set(page, a);
  page.once("close", () => entry.authenticators.delete(page));
  let saved: Credential[] = [];
  try {
    saved = logins.passkeys();
  } catch {
    // the vault can't be opened: the tab works, without passkeys
  }
  await Promise.all(saved.map((credential) => send(a, "WebAuthn.addCredential", { credential })));
  a.cdp.on("WebAuthn.credentialAdded", ({ credential }) => void added(entry, key, a, asCredential(credential), changed));
  a.cdp.on("WebAuthn.credentialAsserted", ({ credential }) => void asserted(entry, key, page, credential));
}

/** A site made a passkey: offered to the user who holds the tab, else taken out again. */
async function added(entry: Entry, key: string, a: Authenticator, credential: Credential, changed: () => void): Promise<void> {
  const hold = holder(entry, key);
  if (hold) {
    const user = hold.typed && onSite(hold.typed.host, credential.rpId) ? hold.typed.user : "";
    entry.offers.set(key, { kind: "passkey", site: credential.rpId, user, credential, until: Date.now() + OFFER_MS });
    return changed();
  }
  await send(a, "WebAuthn.removeCredential", { credentialId: credential.credentialId });
  note(entry, key, `the page made a passkey for ${credential.rpId} while you had the tab, and it was taken out again: only the user adds a passkey, by taking the tab over on its page. Tell them, if they want one`);
}

/** A site signed in with a saved passkey: its count kept and given to the other tabs. */
async function asserted(entry: Entry, key: string, page: Page, credential: Credential): Promise<void> {
  note(entry, key, `the page signed in with the passkey saved for ${credential.rpId}`);
  const kept = await logins.counted(credential.credentialId, credential.signCount).catch(() => null);
  if (kept) await spread(kept, page);
}

/** Every open tab's authenticator, in every workspace's browser, but `except`'s. */
const everyAuthenticator = (except?: Page): Authenticator[] =>
  [...state().browsers.values()].flatMap((entry) => [...entry.authenticators].filter(([page]) => page !== except && !page.isClosed()).map(([, a]) => a));

/** Puts `credential` into every tab's authenticator but `except`'s, replacing an older copy of it. */
export async function spread(credential: Credential, except?: Page): Promise<void> {
  await Promise.all(
    everyAuthenticator(except).map(async (a) => {
      await send(a, "WebAuthn.removeCredential", { credentialId: credential.credentialId });
      await send(a, "WebAuthn.addCredential", { credential });
    }),
  );
}

/** Takes a passkey out of every tab's authenticator. */
export const forget = async (credentialId: string): Promise<void> => void (await Promise.all(everyAuthenticator().map((a) => send(a, "WebAuthn.removeCredential", { credentialId }))));

/** Takes out of every tab's authenticator the passkeys no longer in the vault, deleted on the Vault
 *  page (library-lean's), but not one a page offers the user to save. Run before each step that
 *  changes a tab and when the user takes one over, it asks the tabs only when the passkeys to keep
 *  changed since it last did (a tab opened since got the vault's own); a vault that can't be opened
 *  changes nothing. */
export async function reconcile(): Promise<void> {
  let kept: Set<string>;
  try {
    kept = new Set(logins.passkeys().map((c) => c.credentialId));
  } catch {
    return;
  }
  for (const entry of state().browsers.values()) for (const offer of entry.offers.values()) if (offer.kind === "passkey") kept.add(offer.credential.credentialId);
  const last = perProcess("browser-lean.reconciled", () => ({ kept: null as string | null }));
  const now = [...kept].sort().join("\n");
  if (last.kept === now) return;
  last.kept = now;
  await Promise.all(
    everyAuthenticator().map(async (a) => {
      const held = (await send(a, "WebAuthn.getCredentials", {})) as { credentials?: Partial<Credential>[] } | undefined;
      const gone = (held?.credentials ?? []).map((c) => c.credentialId).filter((id): id is string => !!id && !kept.has(id));
      await Promise.all(gone.map((credentialId) => send(a, "WebAuthn.removeCredential", { credentialId })));
    }),
  );
}
