// The OAuth device flow (RFC 8628), for a provider that signs in with a code the user enters and no
// redirect (GitHub): the skill asks the provider's device_url for a code, the user enters it at the
// provider's page on any device and agrees, and the skill asks the token address until the provider
// says they did. With no redirect address it works wherever AnythingLLM runs, https or not, and a
// client needs no secret. The code waiting is kept in the vault, so whichever process asks next
// (its own loop, or a chat's call) finishes it, once; when each process asks next is its own, so
// asking writes the vault only when the sign-in ends. The device code never reaches the model,
// only the code the user enters.

import { perProcess } from "#shared/anythingllm";
import { secureFor } from "#shared/fence";
import * as vault from "#shared/vault";
import { LibraryError } from "./errors";
import { isSignIn, postForm, refusal, tokenAnswer, tokensOf, type ProviderAnswer, type SignIn, type Tokens } from "./oauth";

const GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** How many seconds apart to ask, when the provider doesn't say (RFC 8628 3.2). */
const INTERVAL_S = 5;
/** How long a code lasts, when the provider doesn't say. */
const EXPIRES_S = 15 * 60;
/** What a provider asking to slow down adds to the interval (RFC 8628 3.5). */
const SLOWER_S = 5;
/** The loop's least pause between rounds. */
const PAUSE_MS = 500;
const RAN_OUT = { error: "the code ran out before the user entered it: start the sign-in again" };

/** Where the device flow tells a sign-in ended: the handler's logger, and what writes the pages'
 *  state again, since the loop asks with no call of its own to do it. */
export interface Report {
  log: (message: string) => void;
  ended: () => void;
}

/** What the user is shown: the code to enter, where, and for how many minutes. */
export interface DeviceCode {
  user_code: string;
  link: string;
  minutes: number;
}

/** When this process asks next for each waiting code, and how many seconds apart, by device code. */
const schedule = () => perProcess("library-lean.device.schedule", () => new Map<string, { next: number; interval: number }>());

/** Starts the device-flow sign-in `given`: asks the provider for a code, keeps its device code in
 *  the vault, starts asking for the tokens, and answers what the user is shown. */
export async function startDevice(given: Readonly<SignIn>, report: Report): Promise<DeviceCode> {
  const o = given.oauth;
  if (!o.device_url) throw new LibraryError(`"${given.user}" signs in with a redirect, not a code`);
  if (!given.client_id) throw new LibraryError(`"${given.user}" is waiting for the user's OAuth client: its ID`);
  const answer = await postForm(o.device_url, { client_id: given.client_id, ...(o.scopes ? { scope: o.scopes } : {}) });
  const { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval } = answer.data;
  if (!device_code || !user_code || !verification_uri) throw new LibraryError(refusal(o.device_url, answer, "sign-in code"));
  const link = String(verification_uri_complete || verification_uri);
  if (!secureFor(new URL(link))) throw new LibraryError(`the provider's sign-in page isn't an https address: ${link.slice(0, 200)}`);
  const seconds = Number(expires_in) > 0 ? Number(expires_in) : EXPIRES_S;
  const every = Number(interval) >= 0 ? Number(interval) : INTERVAL_S;
  await vault.update((v) => {
    const found = v.entries.find((e) => e.id === given.id) as SignIn | undefined;
    if (!found) throw new LibraryError(`there's no sign-in "${given.user}"`);
    Object.assign(found, { device: { code: String(device_code), interval: every, until: Date.now() + seconds * 1000, user_code: String(user_code), link }, error: null });
  });
  schedule().set(String(device_code), { next: Date.now() + every * 1000, interval: every });
  keepAsking(report);
  return { user_code: String(user_code), link, minutes: Math.max(1, Math.round(seconds / 60)) };
}

/** The code `signIn` showed the user that still waits, with the minutes it has left; null when
 *  none waits, it ran out, or it was kept before the vault kept what the user is shown. */
export function waitingCode(signIn: Readonly<SignIn>): DeviceCode | null {
  const d = signIn.device;
  const left = d ? d.until - Date.now() : 0;
  if (!d?.user_code || !d.link || left <= 0) return null;
  return { user_code: d.user_code, link: d.link, minutes: Math.max(1, Math.round(left / 60_000)) };
}

/** What the token address said: tokens, wait (asking `interval` seconds apart), or stop with why. */
type Outcome = { tokens: Tokens } | { wait: number } | { error: string };

function outcomeOf(signIn: Readonly<SignIn>, answer: ProviderAnswer, interval: number): Outcome {
  if (answer.data.access_token) return { tokens: tokensOf(signIn, answer) };
  switch (answer.data.error) {
    case "authorization_pending":
      return { wait: interval };
    case "slow_down":
      return { wait: interval + SLOWER_S };
    case "expired_token":
      return RAN_OUT;
    case "access_denied":
      return { error: "the user didn't agree at the provider" };
    default:
      return { error: refusal(signIn.oauth.token_url, answer, "token") };
  }
}

/** The sign-ins whose code waits. */
const waiting = (): Readonly<SignIn>[] => vault.entries().filter((e): e is SignIn => isSignIn(e) && !!e.device);

/** Asks the token address once for the sign-in `id`, when its code waits and it's time to (or,
 *  with `wait`, once it's time). Waiting keeps when to ask next in this process; tokens or why it
 *  ended go in the vault, and `report` says so. One ask at a time in this process. */
function askOnce(id: string, wait: boolean, report: Report): Promise<void> {
  const asking = perProcess("library-lean.device.asking", () => new Map<string, Promise<void>>());
  const flight = asking.get(id);
  if (flight) return flight;
  const read = () => waiting().find((e) => e.id === id) ?? null;
  const ask = (async () => {
    let signIn = read();
    if (!signIn) return;
    const when = schedule().get(signIn.device!.code) ?? { next: 0, interval: signIn.device!.interval };
    if (when.next > Date.now() && signIn.device!.until > Date.now()) {
      if (!wait) return;
      await new Promise((r) => setTimeout(r, when.next - Date.now()).unref());
      signIn = read();
      if (!signIn) return;
    }
    const { code, until } = signIn.device!;
    let outcome: Outcome;
    if (until <= Date.now()) outcome = RAN_OUT;
    else {
      try {
        outcome = outcomeOf(signIn, await tokenAnswer(signIn, { grant_type: GRANT, device_code: code }), when.interval);
      } catch (e) {
        outcome = e instanceof LibraryError ? { error: e.message } : { wait: when.interval }; // no answer: ask again later
      }
    }
    if ("wait" in outcome) return void schedule().set(code, { next: Date.now() + outcome.wait * 1000, interval: outcome.wait });
    schedule().delete(code);
    const ended = outcome;
    const wrote = await vault.update((v) => {
      const kept = v.entries.find((e) => e.id === id) as SignIn | undefined;
      if (kept?.device?.code !== code) return false; // started again meanwhile
      Object.assign(kept, { device: null, ...("tokens" in ended ? { tokens: ended.tokens, error: null } : { error: ended.error }) });
      return true;
    });
    if (!wrote) return;
    report.log(`library-lean: the sign-in "${signIn.user}" ${"tokens" in ended ? "signed in" : `ended: ${ended.error}`}`);
    report.ended();
  })().finally(() => asking.delete(id));
  asking.set(id, ask);
  return ask;
}

/** Asks once for every sign-in whose code waits: those due now, or, with `wait`, each once it's
 *  due, so a chat's call after the user agreed finds it signed in. Makes sure this process goes on
 *  asking while one waits, as after a restart. A failure is only logged. */
export async function askDevices(wait: boolean, report: Report): Promise<void> {
  const ids = waiting().map((e) => e.id);
  if (!ids.length) return;
  keepAsking(report);
  try {
    await Promise.all(ids.map((id) => askOnce(id, wait, report)));
  } catch (e) {
    report.log(`library-lean couldn't finish a device sign-in: ${(e as Error)?.message || e}`);
  }
}

/** Asks in this process while a code waits, each when it's due, reporting to the call that started
 *  it; timers that never hold the process open. */
function keepAsking(report: Report): void {
  const loop = perProcess("library-lean.device.loop", () => ({ on: false }));
  if (loop.on) return;
  loop.on = true;
  const tick = async () => {
    await askDevices(true, report);
    if (waiting().length) setTimeout(tick, PAUSE_MS).unref();
    else loop.on = false;
  };
  setTimeout(tick, PAUSE_MS).unref();
}
