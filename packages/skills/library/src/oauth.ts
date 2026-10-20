// OAuth sign-in, for an API with no key to paste (GitHub): a preset (presets.ts) names where the
// provider's token and device addresses are and the suite's own client there, a public one with the
// device flow on; the user enters the code device.ts shows them at the provider and agrees. This
// file is what comes after: the tokens the provider gave, kept in the vault and renewed as they run
// out, and where a sign-in is. Nothing of them, nor of the code the provider keeps for the sign-in,
// reaches the model. (Sign-ins with a client of the user's own: branch archive/generic-oauth.)

import { perProcess } from "#shared/anythingllm";
import { hostOf } from "#shared/fence";
import * as net from "#shared/net";
import * as vault from "#shared/vault";
import { LibraryError } from "./errors";

/** A token this close to running out is renewed first. */
const RENEW_MS = 60 * 1000;

export interface Definition {
  token_url: string;
  /** The provider's device authorization address (RFC 8628). */
  device_url: string;
  scopes: string;
}

export interface Tokens {
  access_token: string;
  refresh_token: string | null;
  expires_at: number | null;
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
  client_id: string;
  tokens: Tokens | null;
  device?: DeviceWait | null;
  /** Why the last sign-in didn't finish, until one does. */
  error?: string | null;
}

/** Why a sign-in of the removed kind (no device address) is never used: its token address was the
 *  agent's to write, so nothing is sent to it. */
export const REMOVED = "it was made by a sign-in the suite no longer has: the user deletes it on the Vault, or you ask for it again with preset github under the same label";

export const isSignIn = (e: Readonly<vault.Entry>): e is SignIn => e.kind === "oauth";

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

/** Where a sign-in is, as every part of the library reads it: signed in (with a token it can call
 *  with now, or renew), waiting on the code the user was given, ran out (a token, but neither fresh
 *  nor renewable), its last sign-in failed, or ready to sign in. */
export type SignInState = { at: "signed in" } | { at: "code waits"; code: DeviceCode } | { at: "ran out" } | { at: "failed"; why: string } | { at: "ready" };

export function stateOf(signIn: Readonly<SignIn>): SignInState {
  if (!signIn.oauth.device_url) return { at: "failed", why: REMOVED };
  const t = signIn.tokens;
  if (t?.access_token && (fresh(t) || t.refresh_token)) return { at: "signed in" };
  const code = waitingCode(signIn);
  if (code) return { at: "code waits", code };
  if (t?.access_token) return { at: "ran out" };
  return signIn.error ? { at: "failed", why: signIn.error } : { at: "ready" };
}

/** Whether `tokens`' access token can be sent as it is: it doesn't run out, or not soon. */
const fresh = (tokens: Readonly<Tokens>): boolean => !tokens.expires_at || tokens.expires_at - RENEW_MS > Date.now();

/** A provider's answer: JSON (what a body that isn't leaves is `data` with nothing in it). */
export interface ProviderAnswer {
  status: number;
  data: Record<string, unknown>;
}

/** Posts `fields` as a form to the provider's `url`, and answers what it said. */
export async function postForm(url: string, fields: Record<string, string>): Promise<ProviderAnswer> {
  const answer = await net.send({ method: "POST", url, headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(), next: () => null });
  try {
    return { status: answer.status, data: JSON.parse(answer.body.toString("utf8")) };
  } catch {
    return { status: answer.status, data: {} };
  }
}

/** Asks the sign-in's token_url with `form`, the grant. The client is public: an ID and no secret. */
export const tokenAnswer = (signIn: Readonly<SignIn>, form: Record<string, string>): Promise<ProviderAnswer> => postForm(signIn.oauth.token_url, { ...form, client_id: signIn.client_id });

/** Why the provider at `url` said no, in its words. */
export const refusal = (url: string, { status, data }: ProviderAnswer, what: string): string => `${hostOf(url)} gave no ${what} (${status}${data.error ? `: ${String(data.error_description || data.error).slice(0, 200)}` : ""})`;

/** The tokens to keep from the token address's answer; a LibraryError when it gave none. */
export function tokensOf(signIn: Readonly<SignIn>, answer: ProviderAnswer): Tokens {
  const { data } = answer;
  if (!data.access_token) throw new LibraryError(refusal(signIn.oauth.token_url, answer, "token"));
  const seconds = Number(data.expires_in);
  return { access_token: String(data.access_token), refresh_token: data.refresh_token ? String(data.refresh_token) : (signIn.tokens?.refresh_token ?? null), expires_at: seconds > 0 ? Date.now() + seconds * 1000 : null };
}

/** The access token to send for `signIn`, renewed first when it has run out or is about to. In this
 *  process, requests that find it running out wait on one renewal; it's made outside the vault's
 *  lock, and kept only if no other process renewed it first with the same refresh token, else that
 *  one's tokens are used. So a refresh token is spent once, as providers that rotate them require. */
export async function accessToken(signIn: Readonly<SignIn>): Promise<string> {
  const state = stateOf(signIn);
  if (state.at === "ran out") throw new LibraryError(`the sign-in "${signIn.user}" has run out and can't be renewed: start it again with secret`);
  if (state.at !== "signed in") throw new LibraryError(`"${signIn.user}" isn't signed in yet${state.at === "failed" ? ` (${state.why})` : ""}: start its sign-in with secret, label "${signIn.user}"`);
  const t = signIn.tokens!;
  if (fresh(t)) return t.access_token;
  const renewing = perProcess("library-lean.oauth.renewing", () => new Map<string, Promise<string>>());
  const flight = renewing.get(signIn.id);
  if (flight) return flight;
  const used = t.refresh_token!; // signed in and not fresh: it can be renewed
  const renewal = (async () => {
    const renewed = tokensOf(signIn, await tokenAnswer(signIn, { grant_type: "refresh_token", refresh_token: used }));
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
