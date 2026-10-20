// What the library calls with, kept in the instance's vault (#shared/vault), whose values the model
// never reads: an API key (kind "key": the site it may go to, a name, its value) or an OAuth sign-in
// (oauth.ts: how to sign in, the suite's client and the tokens it got). The user gives a
// key on the Vault (page.ts), sealed on their device; not on AnythingLLM's question card, which shows
// its answers in the chat. A secret goes with a request only to its own site (or a site under
// it), only over https (or plain http to a host the user lets through), put where the API wants it
// (as a bearer token, by HTTP Basic, in a header or in the query), and at most PER_MINUTE times a
// minute from one process (a scheduled job's child process counts its own).

import { perProcess } from "#shared/anythingllm";
import { NOT_SET } from "#shared/answer";
import { allowedHosts, alwaysAllowedHosts, bareHost, onSite, secureFor, siteOf } from "#shared/fence";
import type { Headers } from "#shared/net";
import * as vault from "#shared/vault";
import { LibraryError } from "./errors";
import { accessToken, isSignIn, stateOf, type Definition, type SignIn, type SignInState } from "./oauth";

/** How a secret goes with a request: as a bearer token, by HTTP Basic (the key the password, with a
 *  user name or none), as Authorization with another scheme, in a header, or in the query. */
const AS = /^(bearer|basic(:[^:\s]{1,100})?|authorization:[A-Za-z][\w-]{0,30}|header:[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}|query:[\w.-]{1,64})$/i;
const LABEL = /^[\w .@:-]{1,60}$/;
const PER_MINUTE = 60;

/** A saved secret as the agent and the page see it: never its value. */
export interface Secret {
  site: string;
  label: string;
  kind: "key" | "oauth";
  /** "saved" (a key), or where a sign-in is, in words (statusText). */
  status: string;
  /** A sign-in's Vault tag, and whether it is signed in; its scopes. */
  tag?: { text: string; ok: boolean };
  scopes?: string;
}

/** `as`, checked. */
export function asOf(as: unknown): string {
  const text = String(as ?? "bearer").trim();
  if (!AS.test(text)) throw new LibraryError('a key goes "bearer", "basic", "basic:<user>", "authorization:<scheme>", "header:<name>" or "query:<name>", as the API\'s docs say');
  if (/^header:/i.test(text) && NOT_SET.test(text.slice(7))) throw new LibraryError(`a key can't go in ${text.slice(7)}: send it as "authorization:<scheme>", or in a header of the API's own`);
  return text;
}

/** A secret's name, checked. */
export function labelOf(label: unknown): string {
  const name = String(label ?? "").trim();
  if (!LABEL.test(name)) throw new LibraryError("a key's name is letters, digits, spaces and . _ - @ :, at most 60");
  return name;
}

/** A site or host as a person writes it ("https://API.example.com/v1"), as a host: a public name,
 *  a host the user lets through (FENCE_ALLOW), or the host of an origin they let through for good;
 *  null when it's none of these. */
export function publicSite(raw: unknown): string | null {
  const want = siteOf(raw);
  if (!want) return null;
  return /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(want) || allowedHosts().includes(want) || alwaysAllowedHosts().includes(want) ? want : null;
}

/** The site a secret goes to, checked. */
export function siteChecked(site: unknown): string {
  const want = publicSite(site);
  if (!want) throw new LibraryError('a key needs site, the site it is sent to, like "api.example.com"');
  return want;
}

/** Whether an entry is a secret (a key or a sign-in) named `label` (any case), or any secret. */
const named = (label?: string) => (e: Readonly<vault.Entry>) => (e.kind === "key" || e.kind === "oauth") && (label === undefined || e.user.toLowerCase() === label.toLowerCase());

/** Where a sign-in is, in words, for the agent and the pages. */
function statusText(state: SignInState): string {
  switch (state.at) {
    case "signed in":
      return "signed in";
    case "code waits":
      return "waiting for the user to enter its code";
    case "ran out":
      return "its sign-in ran out and can't be renewed: start it again with secret";
    case "failed":
      return `its last sign-in didn't finish: ${state.why}`;
    case "ready":
      return "ready to sign in";
  }
}

/** A sign-in as the agent and the pages see it. */
function signInSecret(e: Readonly<SignIn>): Secret {
  const state = stateOf(e);
  const tag = { text: state.at === "signed in" ? "Signed in" : state.at === "code waits" ? "Enter the code" : "Not signed in", ok: state.at === "signed in" };
  return { site: e.site, label: e.user, kind: "oauth", status: statusText(state), tag, scopes: e.oauth.scopes };
}

/** The saved secrets, without their values. */
export const secrets = (): Secret[] =>
  vault
    .entries()
    .filter(named())
    .map((e): Secret => (isSignIn(e) ? signInSecret(e) : { site: e.site, label: e.user, kind: "key", status: "saved" }));

/** The sign-in named `label`, as the vault keeps it; null when there's none. */
export const signIn = (label: string): Readonly<SignIn> | null => (vault.entries().find((e) => named(label)(e) && isSignIn(e)) as SignIn | undefined) ?? null;

/** The name of the secret a request to `host` goes with when it names none: the one saved for the
 *  host's site, the closest site first; a LibraryError when there's none, or no one. */
export function labelForHost(host: string): string {
  const found = secrets()
    .filter((k) => onSite(host, k.site))
    .sort((a, b) => b.site.length - a.site.length);
  if (!found.length) throw new LibraryError(`no key is saved for ${host}: ask the user for one with secret`);
  if (found.length > 1 && found[0].site === found[1].site) throw new LibraryError(`several keys are saved for ${found[0].site} (${found.filter((k) => k.site === found[0].site).map((k) => k.label).join(", ")}): name one with auth's key`);
  return found[0].label;
}

/** The refusal for a name that is the other kind of secret already: a name is one secret. */
const nameTaken = (e: Readonly<vault.Entry>): LibraryError => new LibraryError(`"${e.user}" is ${isSignIn(e) ? "a sign-in" : "a key"} already: use another name, or the user deletes it on the Vault first`);

/** Refuses a key's name that is a sign-in's already (before the user is asked for the key). */
export function assertKeyName(label: string): void {
  const taken = signIn(label);
  if (taken) throw nameTaken(taken);
}

/** Saves `entry` under its label, replacing whole the secret of that name (keeping only its id), when
 *  that is the same kind of secret. */
function put(v: vault.Vault, entry: { kind: string; site: string; user: string; [field: string]: unknown }): void {
  const at = v.entries.findIndex(named(entry.user));
  const there = v.entries[at];
  if (!there) return void v.entries.push({ id: vault.newId(), ...entry });
  if (there.kind !== entry.kind) throw nameTaken(there);
  v.entries[at] = { id: there.id, ...entry };
}

/** Saves a key under `label`, replacing a key of that name. */
export async function saveKey(site: string, label: string, value: string): Promise<void> {
  await vault.update((v) => put(v, { kind: "key", site, user: label, value }));
}

/** Whether `signIn` signs in as `oauth` and `clientId` say (fields it may carry from before are no matter). */
const signsInAs = (signIn: Readonly<SignIn>, oauth: Definition, clientId: string): boolean =>
  signIn.client_id === clientId && signIn.oauth.token_url === oauth.token_url && signIn.oauth.device_url === oauth.device_url && signIn.oauth.scopes === oauth.scopes;

/** Saves how a sign-in signs in, with the suite's client `clientId` (a preset's); one of the same
 *  name keeps its tokens and the code it waits on while how it signs in is unchanged (and the vault
 *  isn't written then). One sign-in per provider: a new name for a provider signed in at already is
 *  refused, naming the one there. */
export async function saveSignIn(site: string, label: string, oauth: Definition, clientId: string): Promise<void> {
  const there = vault.entries().find(named(label));
  if (there && isSignIn(there) && signsInAs(there, oauth, clientId)) return;
  await vault.update((v) => {
    const host = new URL(oauth.token_url).host;
    const other = v.entries.find((e) => isSignIn(e) && !named(label)(e) && new URL(e.oauth.token_url).host === host) as SignIn | undefined;
    if (other) throw new LibraryError(`there's a sign-in at ${host} already: "${other.user}" (${statusText(stateOf(other))}; scopes: ${other.oauth.scopes || "none"}). Use it: call secret with label "${other.user}"; to change its scopes, give its preset again with the scopes. For another account, the user deletes it on the Vault first`);
    put(v, { kind: "oauth", site, user: label, oauth, client_id: clientId, tokens: null, device: null, error: null });
  });
}

/** Deletes a secret; whether there was one. */
export const removeSecret = (label: string): Promise<boolean> =>
  vault.update((v) => {
    const before = v.entries.length;
    v.entries = v.entries.filter((e) => !named(label)(e));
    return v.entries.length < before;
  });

/** Whether a secret for `site` may go to `url`: on its site, over https (or plain http to a host
 *  the user lets through). */
const mayGo = (site: string, url: URL): boolean => onSite(bareHost(url), site) && secureFor(url);

export interface Credentialed {
  url: string;
  headers: Headers;
  /** What was sent, to hide in whatever is said of the answer. */
  value: string;
  /** The headers a redirect may go on with: the secret's, only to where it may go. */
  next: (to: string) => Headers | null;
}

/** A request with the secret `label` put where `as` says, when it may go to `url`: a key's value, or
 *  a sign-in's access token, renewed first when it runs out. */
export async function credentialed(label: string, as: string, url: string, headers: Headers): Promise<Credentialed> {
  const secret = vault.entries().find(named(label));
  if (!secret) throw new LibraryError(`no key named "${label}" is saved: ask the user for it with secret`);
  const target = new URL(url);
  if (!mayGo(secret.site, target)) throw new LibraryError(`the key "${label}" is for ${secret.site} over https, and goes nowhere else: not to ${target.origin}`);
  const now = Date.now();
  const recent = perProcess("library-lean.key-calls", () => new Map<string, number[]>());
  const times = (recent.get(secret.id) || []).filter((t) => now - t < 60 * 1000);
  if (times.length >= PER_MINUTE) throw new LibraryError(`the key "${label}" was used ${PER_MINUTE} times in the last minute: wait a minute, and make fewer requests`);
  recent.set(secret.id, [...times, now]);
  const value = isSignIn(secret) ? await accessToken(secret) : String(secret.value);
  const sent = { ...headers };
  const [kind, ...rest] = as.split(":");
  const arg = rest.join(":");
  switch (kind.toLowerCase()) {
    case "bearer":
      sent.Authorization = `Bearer ${value}`;
      break;
    case "basic":
      sent.Authorization = `Basic ${Buffer.from(`${arg}:${value}`).toString("base64")}`;
      break;
    case "authorization":
      sent.Authorization = `${arg} ${value}`;
      break;
    case "header":
      sent[arg] = value;
      break;
    case "query":
      target.searchParams.set(arg, value);
      break;
  }
  return { url: target.href, headers: sent, value, next: (to) => (mayGo(secret.site, new URL(to)) ? sent : null) };
}
