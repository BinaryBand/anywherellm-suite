// What act does to a page, by an element's ref from the last read. A ref looks like e12; press
// sends one plain key and never a shortcut, so nothing reaches the clipboard; nothing is ever typed
// into a password field but what login types, which only the user gave.

import { hostOf } from "#shared/fence";
import { BrowserError, StaleRef } from "./errors";
import type { ElementHandle, Page } from "./host";
import { DIALOG, NOT_TYPED } from "./snapshot";
import type { Tab } from "./state";

const ACTIONS = ["click", "fill", "type", "press", "select", "check", "uncheck", "hover", "scroll_down", "scroll_up", "back", "forward", "reload", "wait"];
const NEEDS_REF = new Set(["click", "fill", "type", "select", "check", "uncheck", "hover"]);
const NEEDS_TEXT = new Set(["fill", "type", "press", "select"]);
const REF = /^e\d{1,6}$/;
const KEYS = new Set(["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Space"]);
const SHIFTED = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
export const ACT_MS = 10 * 1000;
export const NAVIGATE_MS = 30 * 1000;
/** The steps that may load another page, after which a read waits a moment for it. */
const NAVIGATES = new Set(["click", "press", "back", "forward", "reload"]);
const SCROLL_PX = 600;
const MAX_WAIT_S = 10;
const SETTLE_MS = 3000;

/** Whether press sends `key`: one of KEYS, one printable character, or Shift+ one of SHIFTED. */
function keyAllowed(key: string): boolean {
  if (KEYS.has(key) || ([...key].length === 1 && /\P{C}/u.test(key))) return true;
  const [modifier, rest] = key.split("+");
  return modifier === "Shift" && SHIFTED.has(rest);
}

/** A BrowserError unless `action` gets what it needs. */
export function checkAct(action: string, ref: string, text: string): void {
  if (!ACTIONS.includes(action)) throw new BrowserError(`do is one of ${ACTIONS.join(", ")}`);
  if (NEEDS_REF.has(action) && !REF.test(ref)) throw new BrowserError(`${action} needs the ref of an element from the last read, like e12`);
  if (ref && !REF.test(ref)) throw new BrowserError(`"${ref.slice(0, 20)}" isn't a ref; they look like e12`);
  if (NEEDS_TEXT.has(action) && !text) throw new BrowserError(`${action} needs text`);
  if (action === "press" && !keyAllowed(text)) throw new BrowserError(`"${text.slice(0, 40)}" isn't a key press sends: one key (Enter, Tab, Escape, Backspace, an arrow, a character…) or Shift with Tab or an arrow; shortcuts with Control, Meta or Alt aren't sent`);
}

/** The element `ref` names on `page`, inside open shadow roots too (as snapshot walks them), or a
 *  BrowserError saying to read again. */
export async function element(page: Page, ref: string): Promise<ElementHandle> {
  const found = await page.$(`pierce/[data-bw-ref="${ref}"]`);
  if (!found) throw new StaleRef(`${ref} isn't on the page any more; read it again for current refs`);
  return found;
}

/** Whether `target` is a password field: one now, or one a read marked as one (snapshot.ts), so
 *  "Show password" turning it into a text field doesn't change that. */
export const isPassword = (target: ElementHandle): Promise<boolean> => target.evaluate((el) => el.type === "password" || el.getAttribute("data-bw-secret") === "1");

/** What `target` is when it isn't a field one types into (a link, a button…), else null; and its
 *  input type, if it's an input. */
const fieldKind = (target: ElementHandle): Promise<{ what: string | null; type: string }> =>
  target.evaluate((el, skip: string[]) => {
    const tag = el.tagName.toLowerCase();
    const type = tag === "input" ? String(el.type) : "";
    if ((tag === "input" && !skip.includes(type)) || tag === "textarea" || el.isContentEditable) return { what: null, type };
    return { what: tag === "input" ? `input[${type}]` : tag === "a" ? "link" : tag, type };
  }, NOT_TYPED);

/** What `target` is when it isn't a field one types into (a link, a button…), else null. */
export const notTyped = async (target: ElementHandle): Promise<string | null> => (await fieldKind(target)).what;

/** The open dialog `target` sits behind, so a click or typing would land on the dialog or nowhere:
 *  its title and buttons; else null. Behind is what snapshot.ts marks so too: under an inert ancestor
 *  (a cookie dialog that makes the rest of the page inert), or under a dialog (DIALOG) at its middle. */
const coverOf = (target: ElementHandle): Promise<{ title: string; buttons: string[] } | null> =>
  target.evaluate((el, selector: string) => {
    const doc = el.ownerDocument;
    let dialog: any = null;
    if (el.closest("[inert]")) dialog = [...doc.querySelectorAll(selector)].find((d: any) => !d.closest("[inert]") && d.getClientRects().length) ?? doc.body;
    else {
      const r = el.getBoundingClientRect();
      dialog = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(selector) ?? null;
      if (dialog?.contains(el)) dialog = null;
    }
    if (!dialog) return null;
    const clip = (s: unknown, n: number) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
    const labelled = dialog.getAttribute("aria-labelledby");
    const title = clip(dialog.getAttribute("aria-label") || (labelled && doc.getElementById(labelled)?.innerText) || dialog.querySelector("h1, h2, h3")?.innerText, 60);
    const buttons = [...dialog.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')]
      .slice(0, 6)
      .map((b: any) => [b.getAttribute("data-bw-ref"), `"${clip(b.innerText || b.value || b.getAttribute("aria-label"), 40)}"`].filter(Boolean).join(" "));
    return { title, buttons };
  }, DIALOG);

/** A BrowserError when `target` (`ref`) is behind an open dialog, naming it and its buttons. */
export async function reachable(target: ElementHandle, ref: string): Promise<void> {
  const cover = await coverOf(target);
  if (!cover) return;
  const named = [cover.title && `"${cover.title}"`, cover.buttons.length && `its buttons: ${cover.buttons.join(", ")}`].filter(Boolean).join("; ");
  throw new BrowserError(`${ref} is behind a dialog${named ? ` (${named})` : ""}, so nothing reaches it: close the dialog first (a cookie one with the choice that shares least, unless the user said otherwise), read again, then try again`);
}

/** The words of a check that a person is at the browser, which is the user's to pass. */
const HUMAN_CHECK = /verify (that )?you('| a)re (a )?human|i'?m not a robot|human (check|verification)|captcha/i;

/** A BrowserError when `target` (`ref`) is a check that a person is at the browser ("Verify you are
 *  human"), by its own name: ticking it for them is passing as them. */
async function notHumanCheck(target: ElementHandle, ref: string): Promise<void> {
  const words: string = await target.evaluate((el) => [el.getAttribute("aria-label"), el.labels?.[0]?.innerText, el.innerText, el.value].filter(Boolean).join(" "));
  const said = words.match(HUMAN_CHECK)?.[0];
  if (said) throw new BrowserError(`${ref} is a check that a person is at the browser ("${said}"): that's the user's to do, never yours. Tell them to tap the card, take the tab over, do it, and hand it back`);
}

/** The input types a value is set into whole, as a picker would, rather than typed: Chrome types
 *  them by segments, in the user's locale's order. Each with the format its value takes. */
const SET_WHOLE: Record<string, string> = { date: "YYYY-MM-DD", time: "HH:MM", month: "YYYY-MM", week: "YYYY-Www", "datetime-local": "YYYY-MM-DDTHH:MM" };

/** In the page: sets `value` into the field `el` whole, through the input's own setter, as a picker
 *  sets it, so the page's framework sees the change. With `host`, only when the field is in the
 *  tab's own window (not a frame inside it) and that window is on `host`: "frame" or "moved" when
 *  it isn't. A null `value` only checks. Answers where the field is, and what it holds after. */
const setWhole = (el: any, value: string | null, host: string | null): { where: "" | "frame" | "moved"; now: string } => {
  if (host !== null) {
    const view = el.ownerDocument?.defaultView;
    if (!view || view !== view.top) return { where: "frame", now: "" };
    if (view.location.hostname !== host) return { where: "moved", now: "" };
  }
  if (value === null) return { where: "", now: "" };
  el.focus?.();
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
  if (set) set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { where: "", now: el.value };
};

/** Replaces what's in a field with `text`, typed as a person would, so the page sees it; never
 *  anything else (filling a link would click it). A date or time field is set whole (SET_WHOLE). */
export async function fill(target: ElementHandle, text: string): Promise<void> {
  const { what, type: kind } = await fieldKind(target);
  if (what) throw new BrowserError(`a ${what} isn't a field one types into`);
  if (SET_WHOLE[kind]) {
    const { now: took } = await target.evaluate(setWhole, text, null);
    if (!took) throw new BrowserError(`a ${kind} field takes its value as ${SET_WHOLE[kind]}; "${text.slice(0, 40)}" isn't that`);
    return;
  }
  await target.click({ clickCount: 3 });
  await target.evaluate((el) => {
    if ("value" in el) el.value = "";
    else if (el.isContentEditable) el.textContent = "";
  });
  await target.type(text);
}

/** Lets a page a step started load for a moment, so the read or the picture after shows it;
 *  `pause` waits first for a navigation the step may have started. */
export async function settle(page: Page, pause = 400): Promise<void> {
  if (pause) await new Promise((resolve) => setTimeout(resolve, pause));
  await page.waitForFunction(() => (globalThis as any).document.readyState !== "loading", { timeout: SETTLE_MS }).catch(() => {});
}

/** settle after the step `action`: a pause only after a step that may load another page. */
export const settled = (page: Page, action: string): Promise<void> => settle(page, NAVIGATES.has(action) ? 400 : 0);

/** A field that keeps a form from being sent (empty but required, say): its ref, if a read gave it
 *  one, and its label. */
export interface Missing {
  ref: string | null;
  label: string;
}

/** Why typeIn didn't send the form: the fields it still needs, or the page keeping its submit
 *  disabled (it wants something else first, a check only a person passes, say). */
export interface Unsent {
  missing: Missing[];
  disabled: boolean;
}

/** Whether typeIn left the form unsent. */
export const isUnsent = (u: Unsent): boolean => u.disabled || u.missing.length > 0;

/** How long typeIn waits for a submit the page enables once its fields are filled (some check on a
 *  timer rather than on input). */
const ENABLE_MS = 1500;

const isDisabled = (el: ElementHandle): Promise<boolean> => el.evaluate((e) => !!e.disabled || e.getAttribute("aria-disabled") === "true");

/** Waits up to ENABLE_MS for `submit` to be enabled; answers whether it still isn't. */
async function staysDisabled(submit: ElementHandle): Promise<boolean> {
  for (const end = Date.now() + ENABLE_MS; await isDisabled(submit); ) {
    if (Date.now() >= end) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** The fields of `submit`'s form that keep it from being sent; none when it has no form or the
 *  form may be sent. */
const unsent = (submit: ElementHandle): Promise<Missing[]> =>
  submit.evaluate((el) => {
    const form = el.form ?? el.closest("form");
    if (!form || form.checkValidity()) return [];
    return [...form.elements]
      .filter((f: any) => f.willValidate && !f.checkValidity())
      .map((f: any) => ({
        ref: f.getAttribute("data-bw-ref"),
        label: String(f.labels?.[0]?.innerText || f.getAttribute("aria-label") || f.getAttribute("placeholder") || f.name || "").replace(/\s+/g, " ").trim().slice(0, 60),
      }));
  });

/** For the agent, after typeIn: how the submit went, as a clause that follows "typed into the page". */
export function submitted(submitRef: string | undefined, { missing, disabled }: Unsent): string {
  if (!submitRef) return ", but nothing was submitted: submit it with act (press Enter in the field, or click the button)";
  if (disabled) return `, but ${submitRef} wasn't clicked: the page keeps it disabled, so it wants something else first. Read the page: fill what's left with act, or for a check only a person passes ("verify you are human", a CAPTCHA), have the user take the tab over and send it`;
  if (!missing.length) return ` and ${submitRef} clicked`;
  const needs = missing.map((m) => [m.ref, m.label && `"${m.label}"`].filter(Boolean).join(" ") || "a field").join(", ");
  return `, but ${submitRef} wasn't clicked: the page still needs ${needs} first. Fill it with act, or for a check only a person passes (a CAPTCHA), have the user take the tab over and send it`;
}

/** Puts `text` into the field `target` of a page on `host`, in one call into the page that first
 *  checks the field is in the tab's own document (not a frame inside it) and that document is still
 *  on `host`, then sets the value whole through the input's own setter, as a picker does. So a login
 *  never reaches a frame from another site or a page the tab moved to meanwhile, and no keystroke
 *  carries it, which a page moving the focus could send elsewhere. With `keys` it's typed as a person
 *  would instead, after the same check: a code's one-digit boxes may need the keystrokes. */
export async function fillOn(target: ElementHandle, text: string, host: string, keys = false): Promise<void> {
  const { where, now } = await target.evaluate(setWhole, keys ? null : text, host);
  if (where === "frame") throw new BrowserError(`that field is in a frame inside the page, not on ${host}'s page itself; nothing was typed`);
  if (where === "moved") throw new BrowserError(`the page moved off ${host} meanwhile; nothing was typed`);
  if (keys) return fill(target, text);
  if (now !== text) throw new BrowserError(`${host}'s page didn't take the value set into the field. Have the user take the tab over and sign in there`);
}

/** Types a login or a code into the tab `at`: `secret` (the password or the code, hidden from every
 *  read after) into `secretRef`, and into `confirmRef` too (a new account's "Confirm password"), and a
 *  username first, if given; each only into a field on `host`'s own page (fillOn), a code with
 *  keystrokes (`keys`). Then clicks `submitRef`, unless the form still has fields keeping it from
 *  being sent (a CAPTCHA, say), or the page keeps it disabled: answers why it's unsent. */
export async function typeIn(at: Tab, host: string, { userRef, user, secretRef, confirmRef, secret, keys = false }: { userRef?: string; user?: string; secretRef: string; confirmRef?: string; secret: string; keys?: boolean }, submitRef?: string): Promise<Unsent> {
  const now = hostOf(at.page.url());
  if (now !== host) throw new BrowserError(`the page moved to ${now || "another page"} meanwhile; nothing was typed`);
  const into = async (ref: string, text: string) => {
    const target = await element(at.page, ref);
    await reachable(target, ref);
    await fillOn(target, text, host, keys);
  };
  if (userRef && user) await into(userRef, user);
  at.entry.secrets.add(secret);
  await into(secretRef, secret);
  if (confirmRef) await into(confirmRef, secret);
  const left: Unsent = { missing: [], disabled: false };
  if (submitRef) {
    const submit = await element(at.page, submitRef);
    left.missing = await unsent(submit);
    left.disabled = !left.missing.length && (await staysDisabled(submit));
    if (!isUnsent(left)) await submit.click();
  }
  await settle(at.page);
  return left;
}

async function pressKey(page: Page, target: ElementHandle | null, key: string): Promise<void> {
  const [modifier, rest] = key.split("+");
  if (target) await target.focus();
  if (modifier === "Shift" && rest) {
    await page.keyboard.down("Shift");
    await page.keyboard.press(rest);
    await page.keyboard.up("Shift");
  } else await page.keyboard.press(key);
}

async function select(target: ElementHandle, text: string): Promise<void> {
  const value = await target.evaluate((el, wanted: string) => {
    const option = [...(el.options || [])].find((o: { text: string; value: string }) => o.text.trim() === wanted || o.value === wanted);
    return option ? option.value : null;
  }, text);
  if (value === null) throw new BrowserError(`no option "${text}" in that list`);
  await target.select(value);
}

/** The actions that type (press: into the focused field when no ref is given), never into a password field. */
const TYPES = new Set(["fill", "type", "press"]);
/** The actions that reach an element by clicking or typing, which a dialog over it would catch. */
const REACHES = new Set(["click", "fill", "type", "select", "check", "uncheck"]);
/** The actions that would pass a check that a person is at the browser. */
const TICKS = new Set(["click", "check"]);

/** Does `action` on `page`; `ref` and `text` as checkAct allows them. */
export async function act(page: Page, action: string, ref: string, text: string): Promise<unknown> {
  checkAct(action, ref, text);
  const target = ref ? await element(page, ref) : null;
  const typesInto = TYPES.has(action) ? (target ?? (await page.evaluateHandle(() => (globalThis as any).document.activeElement))) : null;
  if (typesInto && (await isPassword(typesInto))) {
    throw new BrowserError(`${ref || "the focused field"} is a password field, which act never types into, even with a password the page or the chat shows: use login, which types a saved login or what the user enters on the tab's page`);
  }
  if (target && REACHES.has(action)) await reachable(target, ref);
  if (target && TICKS.has(action)) await notHumanCheck(target, ref);
  const navigation = { waitUntil: "domcontentloaded", timeout: NAVIGATE_MS };
  switch (action) {
    case "click":
      return target!.click();
    case "fill":
      return fill(target!, text);
    case "type":
      return target!.type(text, { delay: 20 });
    case "press":
      return pressKey(page, target, text);
    case "select":
      return select(target!, text);
    case "check":
    case "uncheck": {
      const checked = await target!.evaluate((el) => el.checked ?? el.getAttribute("aria-checked") === "true");
      return checked !== (action === "check") ? target!.click() : undefined;
    }
    case "hover":
      return target!.hover();
    case "scroll_down":
    case "scroll_up":
      if (target) return target.evaluate((el) => el.scrollIntoView({ block: "center" }));
      return page.mouse.wheel({ deltaY: action === "scroll_down" ? SCROLL_PX : -SCROLL_PX });
    case "back":
      return page.goBack(navigation);
    case "forward":
      return page.goForward(navigation);
    case "reload":
      return page.reload(navigation);
    case "wait":
      return new Promise((resolve) => setTimeout(resolve, Math.min(MAX_WAIT_S, Math.max(0, Number(text) || 2)) * 1000));
    default:
      return undefined;
  }
}
