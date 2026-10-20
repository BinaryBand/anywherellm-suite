// OAuth 2.0 sign-in, for an API with no key to paste (mail, calendars, big platforms): the agent works
// out from the provider's docs where its sign-in is (authorize_url, token_url, the scopes the task
// needs) and saves that; the user makes an OAuth client at the provider, with the redirect address
// this names, and gives its ID and secret; the sign-in link then opens in the user's own browser,
// and the provider sends it back to the Library's oauth page (static/pages/oauth.html), which posts
// the code back as an event (page.ts). This skill trades the code for tokens at token_url, with PKCE,
// and keeps them in the vault, renewing them as they run out; nothing of them, nor of the client,
// reaches the model. A sign-in waiting for the provider is kept in the vault too, so whichever
// process takes the code back (the chat's, or a scheduled job's) can finish it, once. Nothing here
// knows any provider (presets.ts does). Ported from the lean browser skill's oauth.js, which caught the
// redirect in its own Chrome. A provider that signs in with a code the user enters, and no redirect,
// signs in through device.ts.

import crypto from "node:crypto";
import { isIP } from "node:net";
import { objectOf } from "#shared/answer";
import { perProcess } from "#shared/anythingllm";
import { bareHost, hostOf, onSite, secureFor } from "#shared/fence";
import * as net from "#shared/net";
import { newSecret } from "#shared/pages";
import * as vault from "#shared/vault";
import { LibraryError } from "./errors";

/** Where the provider sends the user back: the Library's oauth page on AnythingLLM's address, or,
 *  when that isn't https (a provider refuses plain http but on this machine), an address on this
 *  machine where nothing answers, whose address the user pastes into the Vault. */
export const OAUTH_PAGE = "library-lean/oauth.html";
export const LOOPBACK = "http://127.0.0.1/library-lean/oauth";
/** How long a sign-in waits for the provider to send the user back. */
export const PENDING_MS = 10 * 60 * 1000;
/** A sign-in's own parameters, which a definition's params can't set. */
const RESERVED = new Set(["response_type", "client_id", "redirect_uri", "state", "scope", "code_challenge", "code_challenge_method"]);
const MAX_PARAMS = 10;
/** A token this close to running out is renewed first. */
const RENEW_MS = 60 * 1000;

export interface Definition {
  authorize_url: string;
  token_url: string;
  scopes: string;
  pkce: boolean;
  params: Record<string, string>;
  client_auth: "body" | "basic";
  /** The provider's device authorization address (RFC 8628), for a sign-in with a code the user
   *  enters at the provider and no redirect (device.ts). */
  device_url?: string;
}

export interface Tokens {
  access_token: string;
  refresh_token: string | null;
  expires_at: number | null;
}

/** A sign-in waiting for the provider to send the user back with `state`. */
interface Pending {
  state: string;
  verifier: string;
  redirect: string;
  until: number;
}

/** A device-flow sign-in waiting for the user to enter its code: the provider's device code, how
 *  many seconds apart it said to ask for the tokens, when the code runs out, and what the user was
 *  shown (the code they enter and where), so a second call shows the same. */
export interface DeviceWait {
  code: string;
  interval: number;
  until: number;
  user_code: string;
  link: string;
}

/** An OAuth sign-in as the vault keeps it. */
export interface SignIn extends vault.Entry {
  kind: "oauth";
  oauth: Definition;
  client_id: string | null;
  client_secret: string | null;
  tokens: Tokens | null;
  pending?: Pending | null;
  device?: DeviceWait | null;
  /** Whether its client is the suite's own, from a preset (presets.ts). */
  shared?: boolean;
  /** Why the last sign-in didn't finish, until one does. */
  error?: string | null;
}

export const isSignIn = (e: Readonly<vault.Entry>): e is SignIn => e.kind === "oauth";

/** An https address (or plain http to a host the user lets through), as the definition's `what`. */
function secureUrl(value: unknown, what: string): string {
  let url: URL;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new LibraryError(`${what} is the provider's address for it, like https://auth.example.com/oauth/authorize`);
  }
  if (!secureFor(url)) throw new LibraryError(`${what} is an https address`);
  return url.href;
}

/** The domain `host` stands for: the host less its first label (accounts.google.com: google.com);
 *  an IP address, a host of two labels (github.com) or one under a registry's two (co.uk) is its
 *  own. Why, and what it can't tell apart: docs/notes/skills/library, "Where a sign-in's client goes". */
function domainOf(host: string): string {
  const parent = host.slice(host.indexOf(".") + 1);
  return isIP(host) || !parent.includes(".") || /^[a-z]{1,3}\.[a-z]{2}$/.test(parent) ? host : parent;
}

/** `url`, the definition's `what`, when it's on the domain of authorize_url or of `site`: the client's
 *  secret and the code go there, so only to the provider or to where the tokens go already. */
function onOwnDomain(url: string, what: string, authorize: string, site: string): string {
  const hostIn = (u: string) => bareHost(new URL(u)).replace(/\.+$/, ""); // github.com. is github.com
  const host = hostIn(url);
  const domains = [...new Set([hostIn(authorize), site].map(domainOf))];
  if (!domains.some((d) => onSite(host, d))) throw new LibraryError(`${what} is at ${host}, but the client and the code go only to authorize_url's or the site's domain (${domains.join(", ")}): give the provider's own address from its docs`);
  return url;
}

/** A sign-in as the agent worked it out from the docs, for its tokens to go to `site`, checked. */
export function define(given: Record<string, unknown>, site: string): Definition {
  const scopes = Array.isArray(given.scopes) ? given.scopes.join(" ") : String(given.scopes ?? "").trim();
  if (scopes.length > 1000) throw new LibraryError("scopes are at most 1000 characters");
  const params = objectOf(given.params, "params");
  if (Object.keys(params).length > MAX_PARAMS) throw new LibraryError(`params are at most ${MAX_PARAMS}`);
  for (const [k, v] of Object.entries(params)) {
    if (RESERVED.has(k) || !/^[\w.-]{1,40}$/.test(k)) throw new LibraryError(`params can't set ${k}: the sign-in sets it`);
    if (typeof v !== "string" || v.length > 200) throw new LibraryError(`the param ${k} is text of at most 200 characters`);
  }
  const clientAuth = String(given.client_auth ?? "body");
  if (clientAuth !== "body" && clientAuth !== "basic") throw new LibraryError('client_auth is "body" (the client\'s secret sent in the form) or "basic" (in an Authorization header)');
  const authorize = secureUrl(given.authorize_url, "authorize_url");
  const own = (what: string) => onOwnDomain(secureUrl(given[what], what), what, authorize, site);
  const device = given.device_url ? { device_url: own("device_url") } : {};
  return { authorize_url: authorize, token_url: own("token_url"), scopes, pkce: given.pkce !== false, params: params as Record<string, string>, client_auth: clientAuth, ...device };
}

/** The redirect address to register for the client, for AnythingLLM's address `base`; null while
 *  it isn't set, since the address depends on it. */
export const redirectFor = (base: string | null): string | null => (!base ? null : base.startsWith("https://") ? `${base}/${OAUTH_PAGE}` : LOOPBACK);

/** The states of the sign-ins waiting for the provider, in every process. */
export const waiting = (): string[] =>
  vault
    .entries()
    .filter(isSignIn)
    .flatMap((e) => (e.pending && e.pending.until > Date.now() ? [e.pending.state] : []));

/** Starts the sign-in `given`: answers the provider's sign-in address and the state it comes back
 *  with, which the vault keeps (with the PKCE verifier) until the code comes back or it runs out. */
export async function start(given: Readonly<SignIn>, redirect: string): Promise<SignInLink> {
  const state = newSecret(24);
  const verifier = newSecret(32);
  const signIn = await vault.update((v) => {
    const found = v.entries.find((e) => e.id === given.id) as SignIn | undefined;
    if (!found) throw new LibraryError(`there's no sign-in "${given.user}"`);
    if (!found.client_id) throw new LibraryError(`"${given.user}" is waiting for the user's OAuth client: its ID and secret`);
    found.pending = { state, verifier, redirect, until: Date.now() + PENDING_MS };
    return structuredClone(found);
  });
  return { url: signInLink(signIn, redirect, state, verifier), state, minutes: PENDING_MS / 60_000 };
}

/** The provider's sign-in address for `signIn`, coming back to `redirect` with `state`. */
function signInLink(signIn: Readonly<SignIn>, redirect: string, state: string, verifier: string): string {
  const o = signIn.oauth;
  const url = new URL(o.authorize_url);
  for (const [k, v] of Object.entries(o.params)) url.searchParams.set(k, v);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", signIn.client_id!);
  url.searchParams.set("redirect_uri", redirect);
  if (o.scopes) url.searchParams.set("scope", o.scopes);
  url.searchParams.set("state", state);
  if (o.pkce) {
    url.searchParams.set("code_challenge", crypto.createHash("sha256").update(verifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.href;
}

/** The whole minutes left until `until`; null when less than one is, too little to give the user. */
function minutesLeft(until: number): number | null {
  const left = until - Date.now();
  return left >= 60_000 ? Math.round(left / 60_000) : null;
}

/** What the user is shown for a device-flow sign-in: the code to enter, where, and for how many
 *  minutes. */
export interface DeviceCode {
  user_code: string;
  link: string;
  minutes: number;
}

/** The code `signIn` showed the user that still waits, with the minutes it has left; null when
 *  none waits or it (nearly) ran out. */
function waitingCode(signIn: Readonly<SignIn>): DeviceCode | null {
  const d = signIn.device;
  const minutes = d ? minutesLeft(d.until) : null;
  return d && minutes ? { user_code: d.user_code, link: d.link, minutes } : null;
}

/** A sign-in link the user is given: where it goes, its state, and the minutes it's good for. */
export interface SignInLink {
  url: string;
  state: string;
  minutes: number;
}

/** The link `signIn` gave the user, made again from what the vault keeps (stateOf says whether one
 *  waits, and its minutes). */
export function givenLink(signIn: Readonly<SignIn>, minutes: number): SignInLink {
  const p = signIn.pending!;
  return { url: signInLink(signIn, p.redirect, p.state, p.verifier), state: p.state, minutes };
}

/** Where a sign-in is, as every part of the library reads it: signed in (with a token it can call
 *  with now, or renew), waiting on the code or link the user was given, waiting for its client, ran
 *  out (a token, but neither fresh nor renewable), its last sign-in failed, or ready to sign in. */
export type SignInState =
  | { at: "signed in" }
  | { at: "code waits"; code: DeviceCode }
  | { at: "link waits"; redirect: string; minutes: number }
  | { at: "no client" }
  | { at: "ran out" }
  | { at: "failed"; why: string }
  | { at: "ready" };

/** Where `signIn` is. A link that waits says the address it goes back to, for a caller that needs
 *  that one (signIn makes a new link for another). */
export function stateOf(signIn: Readonly<SignIn>): SignInState {
  const t = signIn.tokens;
  if (t?.access_token && (fresh(t) || t.refresh_token)) return { at: "signed in" };
  const code = waitingCode(signIn);
  if (code) return { at: "code waits", code };
  const p = signIn.pending;
  const minutes = p ? minutesLeft(p.until) : null;
  if (p && minutes) return { at: "link waits", redirect: p.redirect, minutes };
  if (!signIn.client_id) return { at: "no client" };
  if (t?.access_token) return { at: "ran out" };
  return signIn.error ? { at: "failed", why: signIn.error } : { at: "ready" };
}

/** Whether `tokens`' access token can be sent as it is: it doesn't run out, or not soon. */
const fresh = (tokens: Readonly<Tokens>): boolean => !tokens.expires_at || tokens.expires_at - RENEW_MS > Date.now();

/** A provider's answer: JSON, or a form as some token addresses answer. */
export interface ProviderAnswer {
  status: number;
  data: Record<string, unknown>;
}

/** Posts `fields` as a form to the provider's `url`, and answers what it said. */
export async function postForm(url: string, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<ProviderAnswer> {
  const answer = await net.send({ method: "POST", url, headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString(), next: () => null });
  const text = answer.body.toString("utf8");
  try {
    return { status: answer.status, data: JSON.parse(text) };
  } catch {
    return { status: answer.status, data: Object.fromEntries(new URLSearchParams(text)) };
  }
}

/** Asks the sign-in's token_url with `form`, the grant, and the client as the provider wants it. */
export function tokenAnswer(signIn: Readonly<SignIn>, form: Record<string, string>): Promise<ProviderAnswer> {
  const o = signIn.oauth;
  const headers: Record<string, string> = {};
  const fields: Record<string, string> = { ...form, client_id: signIn.client_id ?? "" };
  if (signIn.client_secret && o.client_auth === "basic") headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(signIn.client_id ?? "")}:${encodeURIComponent(signIn.client_secret)}`).toString("base64")}`;
  else if (signIn.client_secret) fields.client_secret = signIn.client_secret;
  return postForm(o.token_url, fields, headers);
}

/** Why the provider at `url` said no, in its words. */
export const refusal = (url: string, { status, data }: ProviderAnswer, what: string): string => `${hostOf(url)} gave no ${what} (${status}${data.error ? `: ${String(data.error_description || data.error).slice(0, 200)}` : ""})`;

/** The tokens to keep from the token address's answer; a LibraryError when it gave none. */
export function tokensOf(signIn: Readonly<SignIn>, answer: ProviderAnswer): Tokens {
  const { data } = answer;
  if (!data.access_token) throw new LibraryError(refusal(signIn.oauth.token_url, answer, "token"));
  const seconds = Number(data.expires_in);
  return { access_token: String(data.access_token), refresh_token: data.refresh_token ? String(data.refresh_token) : (signIn.tokens?.refresh_token ?? null), expires_at: seconds > 0 ? Date.now() + seconds * 1000 : null };
}

/** Trades at the sign-in's token_url: `form` is the grant. Answers the tokens to keep. */
const tokenRequest = async (signIn: Readonly<SignIn>, form: Record<string, string>): Promise<Tokens> => tokensOf(signIn, await tokenAnswer(signIn, form));

/** After the provider sent the user back with `code` (or `error`) for `state`: takes the sign-in
 *  waiting with that state (once: a state no sign-in waits for is ignored), trades the code for
 *  tokens and keeps them, or keeps why it didn't work, for library and the page to show. */
export async function finish(state: string, code: string | null, error: string | null): Promise<void> {
  const taken = await vault.update((v) => {
    const found = v.entries.find((e) => isSignIn(e) && e.pending?.state === state && e.pending.until > Date.now()) as SignIn | undefined;
    if (!found) return null;
    const copy = structuredClone(found);
    found.pending = null;
    return copy;
  });
  if (!taken?.pending) return;
  let outcome: { tokens: Tokens } | { error: string };
  try {
    if (error || !code) throw new LibraryError(`the provider didn't give a code${error ? `: ${error.slice(0, 200)}` : ""}`);
    outcome = { tokens: await tokenRequest(taken, { grant_type: "authorization_code", code, redirect_uri: taken.pending.redirect, ...(taken.oauth.pkce ? { code_verifier: taken.pending.verifier } : {}) }) };
  } catch (e) {
    outcome = { error: (e as Error).message };
  }
  await vault.update((v) => {
    const kept = v.entries.find((e) => e.id === taken.id);
    if (kept) Object.assign(kept, "tokens" in outcome ? { tokens: outcome.tokens, error: null } : { error: outcome.error });
  });
}

/** The access token to send for `signIn`, renewed first when it has run out or is about to. In this
 *  process, requests that find it running out wait on one renewal; it's made outside the vault's
 *  lock, and kept only if no other process renewed it first with the same refresh token, else that
 *  one's tokens are used. So a refresh token is spent once, as providers that rotate them require. */
export async function accessToken(signIn: Readonly<SignIn>): Promise<string> {
  const { at } = stateOf(signIn);
  if (at === "ran out") throw new LibraryError(`the sign-in "${signIn.user}" has run out and can't be renewed: start it again with secret`);
  if (at !== "signed in") throw new LibraryError(`"${signIn.user}" isn't signed in yet: start its sign-in with secret, kind "oauth", label "${signIn.user}"`);
  const t = signIn.tokens!;
  if (fresh(t)) return t.access_token;
  const renewing = perProcess("library-lean.oauth.renewing", () => new Map<string, Promise<string>>());
  const flight = renewing.get(signIn.id);
  if (flight) return flight;
  const used = t.refresh_token!; // signed in and not fresh: it can be renewed
  const renewal = (async () => {
    const renewed = await tokenRequest(signIn, { grant_type: "refresh_token", refresh_token: used });
    return vault.update((v) => {
      const kept = v.entries.find((e) => e.id === signIn.id) as SignIn | undefined;
      if (!kept) throw new LibraryError(`"${signIn.user}" was deleted meanwhile`);
      if (kept.tokens?.refresh_token === used) kept.tokens = renewed;
      return kept.tokens!.access_token;
    });
  })().finally(() => renewing.delete(signIn.id));
  renewing.set(signIn.id, renewal);
  return renewal;
}
