// The page as the agent reads it (view.ts): its visible interactive elements, each tagged with a ref
// (data-bw-ref) that act targets, then its visible text. A ref stays with its element for the life
// of the page, so refs from an earlier read still work while the element is there. Open shadow
// roots are walked; frames aren't. An open dialog's elements come first, and those behind it
// say so. A password field is marked (data-bw-secret) and stays one in every read after, even once
// "Show password" makes it a text field. It also gives where each field one types into sits in
// view, for the tab's page to put an input over while the user holds the tab. `snapshot` runs in
// the page (page.evaluate), so it uses nothing outside itself.

import type { Page } from "./host";
import { firstLine } from "./state";

/** A field in view one types into: its ref, its box in the page's CSS pixels, its input type. */
export interface Field {
  ref: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: string;
  filled: boolean;
}

export interface Snap {
  elements: string[];
  text: string;
  more: boolean;
  fields: Field[];
}

/** The input types one doesn't type into; act.ts's notTyped is given the same list. */
export const NOT_TYPED = ["checkbox", "radio", "hidden", "button", "submit", "reset", "image", "file", "range", "color"];

function snapshot({ snapshot: maxElements, notTyped, dialog }: { snapshot: number; notTyped: string[]; dialog: string }): Snap {
  const { document, window, getComputedStyle, innerWidth, innerHeight } = globalThis as any;
  const INTERACTIVE = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"]);
  const ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "combobox", "textbox", "searchbox", "slider", "spinbutton"]);
  const clip = (s: string, n: number) => {
    s = (s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };
  const visible = (el: any) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  };
  const interactive = (el: any) => {
    if (INTERACTIVE.has(el.tagName)) {
      if (el.tagName === "A") return el.hasAttribute("href");
      if (el.tagName === "INPUT") return el.type !== "hidden";
      return true;
    }
    const role = el.getAttribute("role");
    return (role && ROLES.has(role)) || (el.isContentEditable && el.parentElement?.isContentEditable !== true);
  };
  const name = (el: any) =>
    clip(
      el.getAttribute("aria-label") ||
        el.labels?.[0]?.innerText ||
        el.getAttribute("title") ||
        el.getAttribute("alt") ||
        (["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) ? "" : el.innerText) ||
        el.getAttribute("placeholder") ||
        el.getAttribute("name") ||
        "",
      80,
    );
  // Open dialogs (a cookie one, say): their elements are listed first, and those behind one are
  // marked, as act.ts's coverOf refuses them: under an inert ancestor, or under a dialog at their
  // middle; a click or typing there doesn't reach them.
  const dialogs = [...document.querySelectorAll(dialog)].filter((d: any) => !d.closest("[inert]") && visible(d));
  const behind = (el: any) => {
    if (el.closest("[inert]")) return true;
    if (!dialogs.length) return false;
    const r = el.getBoundingClientRect();
    const over = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(dialog);
    return !!over && !over.contains(el);
  };
  // A password field (or one that says it takes a password) is marked, and stays one once read,
  // even after "Show password" makes it a text field: act.ts's isPassword reads the mark. Its text
  // is drawn as dots for good, so the tab's picture, which anyone with its link sees, never shows it.
  const secret = (el: any) => el.getAttribute("data-bw-secret") === "1";
  const mark = (el: any) => {
    if (el.tagName === "INPUT" && !secret(el) && (el.type === "password" || /^(current|new)-password$/.test(el.getAttribute("autocomplete") || ""))) {
      el.setAttribute("data-bw-secret", "1");
      el.style.setProperty("-webkit-text-security", "disc", "important");
    }
  };
  const describe = (el: any) => {
    const tag = el.tagName.toLowerCase();
    let kind = el.getAttribute("role") || (tag === "a" ? "link" : tag === "summary" ? "button" : tag);
    if (tag === "input") kind = secret(el) ? "input[password]" : `input[${el.type}]`;
    let line = `${kind} "${name(el)}"`;
    if (tag === "a") {
      const href = el.getAttribute("href") || "";
      if (href && !href.startsWith("javascript:")) line += ` -> ${clip(href, 100)}`;
    }
    if (tag === "input" && (el.type === "checkbox" || el.type === "radio")) line += el.checked ? " (checked)" : " (unchecked)";
    else if (secret(el)) {
      if (el.value) line += " (filled)";
    } else if (tag === "input" || tag === "textarea") {
      if (el.value) line += ` value="${clip(el.value, 80)}"`;
      else if (el.placeholder) line += ` placeholder="${clip(el.placeholder, 60)}"`;
    } else if (tag === "select") {
      const options = [...el.options].slice(0, 12).map((o: any) => (o.selected ? `*${clip(o.text, 40)}` : clip(o.text, 40)));
      line += ` options: ${options.join(" | ")}${el.options.length > 12 ? " | …" : ""}`;
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") line += " (disabled)";
    if (behind(el)) line += " (behind a dialog)";
    return line;
  };
  const MAX_FIELDS = 60;
  const field = (el: any, ref: string): Field | null => {
    const typed = (el.tagName === "INPUT" && !notTyped.includes(el.type)) || el.tagName === "TEXTAREA" || (el.isContentEditable && el.parentElement?.isContentEditable !== true);
    if (!typed || el.disabled || el.readOnly) return null;
    const r = el.getBoundingClientRect();
    if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return null;
    const kind = secret(el) ? "password" : el.tagName === "INPUT" ? el.type || "text" : el.tagName === "TEXTAREA" ? "textarea" : "text";
    return { ref, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), kind, filled: !!("value" in el ? el.value : el.textContent) };
  };
  let next: number = window.__bwNext || 1;
  const lines: string[] = [];
  const fields: Field[] = [];
  const seen = new Set();
  const walk = (root: any) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) walk(el.shadowRoot);
      if (lines.length >= maxElements) return;
      if (seen.has(el) || !interactive(el) || !visible(el)) continue;
      seen.add(el);
      let ref = el.getAttribute("data-bw-ref");
      if (!ref) {
        ref = `e${next++}`;
        el.setAttribute("data-bw-ref", ref);
      }
      mark(el);
      lines.push(`[${ref}] ${describe(el)}`);
      const f = field(el, ref);
      if (f && fields.length < MAX_FIELDS) fields.push(f);
    }
  };
  for (const d of dialogs) walk(d);
  walk(document);
  window.__bwNext = next;
  const text = String(document.body ? document.body.innerText : "")
    .split("\n")
    .map((l: string) => l.replace(/\s+/g, " ").trim())
    .filter((l: string, i: number, all: string[]) => l || (i > 0 && all[i - 1]))
    .join("\n")
    .trim();
  return { elements: lines, text, more: lines.length >= maxElements, fields };
}

/** What snapshot lists at most; view.ts shows fewer and says there are more. */
const SNAPSHOT_ELEMENTS = 400;

/** Whether a line of a read is a password field. */
export const isPasswordLine = (line: string): boolean => line.includes("input[password]");

/** Whether the page as read asks for a password. */
export const asksPassword = (snap: Snap): boolean => snap.elements.some(isPasswordLine);

/** Whether the page as read has a field for a code (a one-time, verification or authenticator code). */
export const asksCode = (snap: Snap): boolean => snap.elements.some((l) => /^\[e\d+\] input\[(text|tel|number)\] "[^"]*\b(code|one-time|otp|passcode|verification)/i.test(l));

/** The page as read, with its title and address (readPage). */
export type Read = { snap: Snap; title: string; url: string };

/** A dialog, as a read lists it first and act checks what it covers. */
export const DIALOG = 'dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"]';

/** The line of a read for `ref`, if it has one. */
export const lineOf = (snap: Snap, ref: string): string | undefined => snap.elements.find((l) => l.startsWith(`[${ref}] `));

/** What a read's line says the element is, its kind and label, without its ref or value: the same
 *  field on a page read again, where a ref alone may name another element on a new page. */
export const fieldOf = (line: string): string => line.match(/^\[e\d+\] (\S+ "[^"]*")/)?.[1] ?? line;

/** What the field `ref` is in a read (fieldOf), if the read has it. */
export const fieldAt = (snap: Snap, ref: string): string | undefined => {
  const line = lineOf(snap, ref);
  return line && fieldOf(line);
};

/** The page now: { snap, title, url }, with a snap saying why when it can't be read. */
export async function readPage(page: Page): Promise<Read> {
  const [snap, title] = await Promise.all([
    page.evaluate(snapshot, { snapshot: SNAPSHOT_ELEMENTS, notTyped: NOT_TYPED, dialog: DIALOG }).catch((e): Snap => ({ elements: [], text: `(couldn't read the page: ${firstLine(e)})`, more: false, fields: [] })),
    page.title().catch(() => ""),
  ]);
  return { snap, title, url: page.url() };
}
