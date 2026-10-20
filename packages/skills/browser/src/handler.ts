// Tasks on the web for the agent: it researches (search, look: research.ts) or clicks through a
// site in a real Chrome, run by this skill inside AnythingLLM with a tab per chat (browser.ts). In
// the tab the agent opens an address, reads the page as text with a ref on each element, and acts by
// those refs; call sends a request from the tab, with its signed-in session, for a site's own JSON.
// Each answer about the tab ends with its card, which opens the tab's page (page.ts), where the user
// can also take the tab over (takeover.ts): the agent then reads but doesn't act until it's handed
// back. A login comes from the saved logins (#shared/logins, in the instance's vault) or from the user on
// the tab's page, straight to this skill, which types it into the page: the model never sees it. A
// saved passkey signs in by itself (passkey.ts). An API with a key is the library skill's.
//
// esbuild bundles this into the one handler.js AnythingLLM loads.

import { BINARY, answerText, bodyOf, headersOf, keepOf, methodOf, withParams } from "#shared/answer";
import { baseUrlOf, workspaceOf } from "#shared/anythingllm";
import { foreground, grantsOf, letThrough } from "#shared/ask";
import { Told } from "#shared/errors";
import { checkUrl, hostOf, onSite } from "#shared/fence";
import * as logins from "#shared/logins";
import { entryOf } from "#shared/static";
import { act, checkAct, element, isPassword, notTyped, reachable, settle, settled, submitted, typeIn } from "./act";
import { type Ask, existing, load, tab, through } from "./browser";
import { BrowserError } from "./errors";
import type { HandlerContext } from "./host";
import { card, caughtUp } from "./page";
import * as research from "./research";
import { type Scope, scopeOf } from "./scope";
import { type Read, type Snap, asksCode, asksPassword, fieldAt, readPage } from "./snapshot";
import { NEED_MS, type Need, type Tab, firstLine, holder, note, state, statics, takeNotes, threadKey } from "./state";
import { free } from "./takeover";
import { render } from "./view";

type Args = Record<string, unknown>;

const clean = (v: unknown): string => String(v ?? "").trim();
/** A field's ref the agent gave, or undefined. */
const refOf = (v: unknown): string | undefined => clean(v) || undefined;
/** At most this many steps in one act. */
const MAX_ACT_STEPS = 20;
/** What a login asks the user for, by what: the wording is fixed here, never the model's, so a page
 *  can't steer the agent into asking the user for something else. */
const CODES: Record<string, string> = {
  code: "The verification code",
  authenticator: "The code from your authenticator app",
  sms: "The code sent to your phone",
  email: "The code sent to your email",
};

/** The page as the agent reads it, then its card; `page` false when the tab has no page the user
 *  could answer on. While the user is asked for something there, the card comes first, before the
 *  read, so it isn't lost at the end of a long one. */
async function reply(self: HandlerContext, at: Tab, lead: string, find = "", from: unknown = 0, read?: Read): Promise<{ text: string; page: boolean; snap: Snap }> {
  const { snap, title, url } = read ?? (await readPage(at.page));
  const drawn = await card(at, baseUrlOf(self), { snap, title });
  const held = holder(at.entry, at.key);
  const asking = at.entry.needs.has(at.key);
  const shown = render({ title, url, snap, notes: takeNotes(at.entry, at.key), find, from, secrets: at.entry.secrets });
  // A sign-in or a code on the page is login's: act never types one, and the user's is theirs to give.
  const hint = held ? "" : asksPassword(snap) ? "This page has a password field: to sign in or confirm it's you, use login." : asksCode(snap) ? 'This page asks for a code: use login with what ("sms", "email", "authenticator" or "code") and ref. Telling the user isn\'t enough: the tab\'s page asks them for it only once login has.' : "";
  const put = "Answer the user in words first, then put the card below in your reply exactly as given, with no label or heading: tapping it opens the tab's page, where the user watches it, gives what you ask them for, or takes it over.";
  const top = (held ? "The user has taken this tab over on its page: read it, but don't act in it until they hand it back.\n" : "") + lead;
  const cardPart = [put, ...drawn.lines];
  const readPart = asking ? [shown] : [shown, ...(hint ? ["", hint] : [])];
  const text = [top, "", ...(asking ? [...cardPart, "", ...readPart] : [...readPart, "", ...cardPart])];
  return { text: text.join("\n"), page: drawn.page, snap };
}

const answer = async (self: HandlerContext, at: Tab, lead: string, find = "", from: unknown = 0) => (await reply(self, at, lead, find, from)).text;

/** The steps of an act: `steps` ([{ do, ref, text }], or that as JSON), else the one step given by
 *  do, ref and text; each checked before any is done. */
function actSteps(args: Args): { do: string; ref: string; text: string }[] {
  let steps: unknown = args.steps;
  if (steps === undefined || steps === null || steps === "") steps = [{ do: args.do, ref: args.ref, text: args.text }];
  if (typeof steps === "string") {
    try {
      steps = JSON.parse(steps);
    } catch {
      throw new BrowserError('steps is a list, as [{ "do": "click", "ref": "e4" }]');
    }
  }
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_ACT_STEPS) throw new BrowserError(`steps is a list of 1 to ${MAX_ACT_STEPS}, as [{ "do": "click", "ref": "e4" }]`);
  return steps.map((s: Args) => {
    const step = { do: clean(s?.do), ref: clean(s?.ref), text: s?.text === undefined || s?.text === null ? "" : String(s.text) };
    checkAct(step.do, step.ref, step.text);
    return step;
  });
}

const stepName = (s: { do: string; ref: string }) => `${s.do}${s.ref ? ` ${s.ref}` : ""}`;

/** Does the steps of an act in order, stopping at the first that fails. */
async function actAll(self: HandlerContext, scope: Scope, args: Args): Promise<string> {
  const steps = actSteps(args);
  const at = existing(scope.workspace, scope.thread);
  for (const [done, step] of steps.entries()) {
    try {
      await act(at.page, step.do, step.ref, step.text);
      await settled(at.page, step.do);
    } catch (e) {
      const why = e instanceof BrowserError ? e.message : `${step.do} failed: ${firstLine(e)}`;
      if (steps.length === 1) throw new BrowserError(why);
      await settle(at.page);
      return answer(self, at, `Did ${done} of ${steps.length} steps (${steps.slice(0, done).map(stepName).join(", ") || "none"}); step ${done + 1}, ${stepName(step)}, failed: ${why}. Nothing after it was done; read the page below before going on.`);
    }
  }
  return answer(self, at, `Did ${steps.length === 1 ? "" : `all ${steps.length} steps: `}${steps.map(stepName).join(", ")}.`);
}

/** The page's host, checked against `site` when the agent gave one. */
function hostChecked(at: Tab, site: unknown): string {
  const host = hostOf(at.page.url());
  if (!host) throw new BrowserError("the page has no site to sign in to");
  if (clean(site) && !onSite(host, site)) throw new BrowserError(`the page is on ${host}, not ${clean(site)}; nothing was asked`);
  return host;
}

/** Asks the user on the tab's page for what only they may know; the agent's turn doesn't wait: it
 *  ends with the tab's card, the user enters it there, and the skill types it into the page (page.ts).
 *  `need.text` is the page's words, to the user; `told` is the agent's. */
async function askOnPage(self: HandlerContext, at: Tab, need: Omit<Need, "until">, told: string, read?: Read): Promise<string> {
  const asking: Need = { ...need, until: Date.now() + NEED_MS };
  at.entry.needs.set(at.key, asking);
  const asked = await reply(self, at, `The user is asked on the tab's page: ${told}. Tell them to tap the card below and enter it there: it goes into the page without you seeing it. Never ask for it in the chat. When they say they're done, read the page; it says whether it was typed.`, "", 0, read);
  asking.field = fieldAt(asked.snap, need.secretRef); // the stored request, from the read it was asked with
  if (asked.page) return asked.text;
  at.entry.needs.delete(at.key);
  throw new BrowserError(`${told}, and this AnythingLLM can't show the tab's page, where the user would enter it (its public folder can't be written, or no page key is set: anywherellm-suite install --page-key)`);
}

/** Which code a page asks for when the agent said only "code": by where its text says it went. */
function codeOnPage(text: string): string {
  return /\b(text message|sms|your phone)\b/i.test(text) ? "sms" : /\b(your email|inbox|emailed)\b/i.test(text) ? "email" : "code";
}

/** Asks the user for a code (`what`) to go into the field `ref`. */
async function askCode(self: HandlerContext, at: Tab, args: Args): Promise<string> {
  let what = clean(args.what).toLowerCase();
  if (!CODES[what]) throw new BrowserError(`login asks for a code with what: ${Object.keys(CODES).join(", ")}`);
  const ref = refOf(args.ref);
  if (!ref) throw new BrowserError("login with what needs ref, the field the code goes into");
  await reachable(await element(at.page, ref), ref);
  const host = hostChecked(at, args.site);
  const read = await readPage(at.page);
  if (what === "code") what = codeOnPage(read.snap.text);
  const label = CODES[what];
  return askOnPage(self, at, { kind: "code", host, label, secretRef: ref, submitRef: refOf(args.submit_ref), text: `For ${host}.` }, `${label} for ${host}`, read);
}

/** Signs in: the login saved for the site typed in, or the user asked for one on the tab's page. */
async function signIn(self: HandlerContext, at: Tab, args: Args): Promise<string> {
  const [userRef, passRef, confirmRef, submitRef] = [refOf(args.user_ref), refOf(args.pass_ref), refOf(args.confirm_ref), refOf(args.submit_ref)];
  const here = hostOf(at.page.url());
  if (here && !logins.forHost(here) && logins.forHost(here, "passkey")) throw new BrowserError(`no password is saved for ${here}, but a passkey is: click the site's passkey sign-in with act (a "Sign in with a passkey" button, say) and it signs in by itself`);
  if (!passRef) throw new BrowserError("login needs pass_ref, the password field's ref (and user_ref, the username's); or what and ref, for a code");
  const pass = await element(at.page, passRef);
  if (!(await isPassword(pass))) throw new BrowserError(`${passRef} isn't a password field`);
  await reachable(pass, passRef);
  const what = userRef ? await notTyped(await element(at.page, userRef)) : null;
  if (what) throw new BrowserError(`${userRef} is a ${what}, not a field for the username: give user_ref only where the page asks for the username, and leave it out on a page that asks only for the password`);
  if (confirmRef && !(await isPassword(await element(at.page, confirmRef)))) throw new BrowserError(`${confirmRef} isn't a password field; confirm_ref is a new account's "Confirm password"`);
  const host = hostChecked(at, args.site);
  // A new account's password is the user's to choose, whatever is saved for the site.
  const saved = confirmRef ? null : logins.forHost(host);
  const [text, told] = confirmRef
    ? [`For a new account on ${host}.`, `${host} needs a password for the new account, which the user chooses`]
    : [`No login is saved for ${host}.`, `${host} needs the user to sign in, and no login is saved for it`];
  if (!saved) return askOnPage(self, at, { kind: "login", host, userRef, secretRef: passRef, confirmRef, submitRef, text }, told);
  self.introspect?.(`Signing in to ${host} with the saved login`);
  const left = await typeIn(at, host, { userRef, user: saved.user, secretRef: passRef, secret: saved.pass }, submitRef);
  return answer(self, at, `Typed the login the user saved for ${saved.site} into the page${submitted(submitRef, left)}. It's hidden from you; read the page below to see whether it worked.`);
}

/** A request from inside the tab, on its site's own origin, so the browser's signed-in session goes
 *  with it: for a site's own JSON, as its pages fetch it. */
async function call(self: HandlerContext, scope: Scope, args: Args): Promise<string> {
  if (clean(args.auth) !== "session") throw new BrowserError('the browser\'s call goes with the tab\'s signed-in session: give auth "session". A call to an API with a key is the library skill\'s');
  const method = methodOf(args.method);
  const url = withParams(new URL(checkUrl(args.url)), args.params).href;
  const headers = headersOf(args.headers);
  const body = bodyOf(method, args.body, headers);
  const keep = keepOf(args.keep);
  const at = existing(scope.workspace, scope.thread);
  await through(at.entry, url, "isn't reached", askOf(self, (o) => `Send a request to ${o} from the browser`));
  const origin = new URL(url).origin;
  if (!at.page.url().startsWith(origin + "/")) await load(at.entry, at.page, origin + "/");
  const got = await at.page.evaluate(
    async ({ url, method, headers, body, max }: { url: string; method: string; headers: Record<string, string>; body?: string; max: number }) => {
      const r = await fetch(url, { method, credentials: "include", headers, body });
      const shown: Record<string, string> = {};
      r.headers.forEach((v: string, k: string) => (shown[k] = v));
      const text = await r.text();
      return { status: r.status, headers: shown, text: text.slice(0, max), cut: text.length > max };
    },
    { url, method, headers, body, max: 2 * 1024 * 1024 },
  );
  const binary = BINARY.test(String(got.headers["content-type"] ?? ""));
  return answerText({ ...got, text: binary ? "" : got.text, bytes: got.text.length, binary }, `${method} ${url} (with the tab's session)`, keep, [...at.entry.secrets]);
}

/** In a chat in AnywhereLLM, how the user is asked to let through a host the fence refuses, for what
 *  `why` says the browser would do at its origin; nothing elsewhere, where it's refused. */
function askOf(self: HandlerContext, why: (origin: string) => string): Ask | undefined {
  if (!foreground(self)) return undefined;
  return (refused) => letThrough(self, "Browser", refused, why(refused.origin));
}

/** The actions that change the tab: refused while the user holds it, and the user can't take it over
 *  while one runs. */
const ON_TAB = new Set(["open", "act", "login", "call"]);

/** Runs an action that changes the thread's tab, unless the user holds it (takeover.ts). */
async function onTab(scope: Scope, run: () => Promise<string> | string): Promise<string> {
  const entry = state().browsers.get(scope.workspace);
  const key = threadKey(scope.thread);
  if (entry) free(entry, key);
  entry?.busy.add(key);
  try {
    return await run();
  } finally {
    entry?.busy.delete(key);
    state().browsers.get(scope.workspace)?.changed();
  }
}

const ACTIONS: Record<string, (self: HandlerContext, scope: Scope, args: Args) => Promise<string> | string> = {
  guide: (self, scope, args) => entryOf(statics(), "guide", ".md", "topic", args.topic, "index").text,
  search: (self, scope, args) => {
    self.introspect?.(`Searching for ${clean(args.query).slice(0, 100)}`);
    return research.search(scope.workspace, args.query, self.runtimeArgs?.SEARCH_URL, askOf(self, (o) => `Search with ${o}`));
  },
  look: (self, scope, args) => {
    if (!clean(args.url)) throw new BrowserError("look needs url, the address to read");
    return research.look(scope.workspace, args.url, { find: clean(args.find), from: args.from, ask: askOf(self, (o) => `Read a page on ${o}`) });
  },
  open: async (self, scope, args) => {
    const url = checkUrl(args.url);
    self.introspect?.(`Opening ${url}`);
    const at = await tab(scope.workspace, scope.thread);
    const failed = await load(at.entry, at.page, url, askOf(self, (o) => `Open ${o} in the browser`));
    if (failed) note(at.entry, at.key, `loading ${url} didn't finish: ${failed}`);
    return answer(self, at, `Opened ${url} in this chat's tab.`);
  },
  read: (self, scope, args) => answer(self, existing(scope.workspace, scope.thread), "This chat's tab as it is now.", clean(args.find), args.from),
  act: actAll,
  login: (self, scope, args) => {
    const at = existing(scope.workspace, scope.thread);
    return clean(args.what) ? askCode(self, at, args) : signIn(self, at, args);
  },
  call: (self, scope, args) => call(self, scope, args),
};

export const runtime = {
  handler: async function (this: HandlerContext, args: Args = {}): Promise<string> {
    const action = clean(args.action).toLowerCase() || "read";
    const fn = ACTIONS[action];
    if (!fn) return `The browser's action is ${Object.keys(ACTIONS).join(", ")}, not "${clean(args.action)}".`;
    try {
      // What the user did on a tab's page since the last call.
      if (workspaceOf(this)) await caughtUp().catch((e) => this.logger?.(`browser-lean couldn't apply the tab pages' events: ${firstLine(e)}`));
      const scope = scopeOf(this);
      // The hosts this run was let through, for its workspace's pages to load meanwhile.
      if (workspaceOf(this) && this.super) state().grants.set(scope.workspace, { hosts: grantsOf(this), last: Date.now() });
      return await (ON_TAB.has(action) ? onTab(scope, () => fn(this, scope, args)) : fn(this, scope, args));
    } catch (e) {
      if (e instanceof Told) return `Browser: ${e.message.replace(/\.$/, "")}.`;
      this.logger?.(`browser-lean ${action} failed: ${(e as Error)?.stack || e}`);
      return `Browser ${action} failed: ${firstLine(e)}. Tell the user what went wrong; don't retry on your own.`;
    }
  },
};
