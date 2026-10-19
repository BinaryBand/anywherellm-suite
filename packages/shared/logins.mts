// The logins the browser signs in with, kept in the instance's vault (#shared/vault), which the
// model never reads: a site, a username and its password (kind "password"), or a passkey a site made
// (kind "passkey", its credential as Chrome's authenticator gives it). Shared by every workspace, as
// the library's keys are.
//
// library-lean manages them: its Vault page lists them, never their passwords or keys, and deletes
// them. browser-lean uses them in its tabs and saves the ones the user agrees to keep as they sign
// in there.

import { onSite } from "./fence.mts";
import * as vault from "./vault.mts";

const PASSWORD = "password" as const;
const PASSKEY = "passkey" as const;

/** A passkey as Chrome's virtual authenticator gives it and takes it back. */
export interface Credential {
  credentialId: string;
  rpId: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
  isResidentCredential: boolean;
}

export interface Login {
  id: string;
  site: string;
  user: string;
  pass: string;
}

/** The saved logins and passkeys, without their passwords or keys. */
export const list = (): { id: string; site: string; user: string; kind: string }[] =>
  vault
    .entries()
    .filter((e) => e.kind === PASSWORD || e.kind === PASSKEY)
    .map(({ id, site, user, kind }) => ({ id, site, user, kind }));

/** The saved passkeys' credentials, for an authenticator. */
export const passkeys = (): Credential[] =>
  vault
    .entries()
    .filter((e) => e.kind === PASSKEY && e.credential)
    .map((e) => e.credential as Credential);

/** The login for `host` (its site or a parent's; the closest wins), password and all; null when
 *  there's none. With `kind` "passkey", whether a passkey is saved for it. */
export function forHost(host: string, kind: string = PASSWORD): Login | null {
  const matching = vault.entries().filter((e) => e.kind === kind && onSite(host, e.site));
  const found = matching.sort((a, b) => b.site.length - a.site.length)[0];
  return found ? { id: found.id, site: found.site, user: found.user, pass: String(found.pass ?? "") } : null;
}

/** Saves a login, replacing the one for the same site and username. */
export const save = (site: string, user: string, pass: string): Promise<void> =>
  vault.update((v) => {
    const at = v.entries.findIndex((e) => e.kind === PASSWORD && e.site === site && e.user === user);
    if (at >= 0) v.entries[at] = { ...v.entries[at], pass };
    else v.entries.push({ id: vault.newId(), kind: PASSWORD, site, user, pass });
  });

/** Saves a passkey a site made, for `site` (its rpId) and the username the user typed, if any. */
export const savePasskey = (site: string, user: string, credential: Credential): Promise<void> =>
  vault.update((v) => {
    v.entries.push({ id: vault.newId(), kind: PASSKEY, site, user, credential });
  });

/** Keeps a passkey's signature count after a sign-in, only ever going up; answers its credential as
 *  kept, or null when it isn't saved or its count didn't go up (the vault isn't written then). */
export async function counted(credentialId: string, signCount: number): Promise<Credential | null> {
  const ofIt = (e: vault.Entry) => e.kind === PASSKEY && (e.credential as Credential | undefined)?.credentialId === credentialId;
  const now = vault.entries().find(ofIt)?.credential as Credential | undefined;
  if (!now || signCount <= now.signCount) return null;
  return vault.update((v) => {
    const found = v.entries.find(ofIt);
    if (!found) return null;
    const credential = found.credential as Credential;
    if (signCount > credential.signCount) found.credential = { ...credential, signCount };
    return found.credential as Credential;
  });
}

/** Deletes a login or a passkey; answers what it was (a passkey with its credential id), or null
 *  when there was none. A deleted passkey leaves the browser's open tabs at their next step. */
export const remove = (id: string): Promise<{ kind: "password" } | { kind: "passkey"; credentialId: string } | null> =>
  vault.update((v) => {
    const found = v.entries.find((e) => (e.kind === PASSWORD || e.kind === PASSKEY) && e.id === id);
    if (!found) return null;
    v.entries = v.entries.filter((e) => e !== found);
    return found.kind === PASSKEY ? { kind: PASSKEY, credentialId: (found.credential as Credential).credentialId } : { kind: PASSWORD };
  });
