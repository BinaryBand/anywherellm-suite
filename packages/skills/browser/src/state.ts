// What the skill's modules share: the state that must outlive a reload of handler.js (AnythingLLM
// loads it afresh for each agent run, so the browsers, their tabs and what the user typed are kept
// per process), where the skill keeps things in AnythingLLM's storage, and the screen a tab draws.

import path from "node:path";
import { perProcess, storageDir } from "#shared/anythingllm";
import type { makeFence } from "#shared/fence";
import type { Credential } from "#shared/logins";
import { staticFiles, type StaticFiles } from "#shared/static";
import { BrowserError } from "./errors";
import type { Browser, CDPSession, Page, Viewport } from "./host";

/** A tab's screen until its page says how much room it has: a phone's, drawn sharp. */
export const VIEWPORT = { width: 430, height: 932, deviceScaleFactor: 2 };
/** The screens a tab's page may ask for, in CSS pixels; wider than phoneMax is drawn at 1x, so a
 *  picture stays a few hundred kilobytes. */
const SCREEN = { minWidth: 320, maxWidth: 1920, minHeight: 400, maxHeight: 1600, phoneMax: 900 };
/** How long a workspace's browser stays open unused; its tabs' states say when it closes (`until`). */
export const IDLE_MS = 20 * 60 * 1000;
/** How long the user holds a tab without a step before it's the agent's again. */
const HOLD_MS = 10 * 60 * 1000;
/** How long a login or a passkey waits to be saved, or for the user's answer to the offer. */
export const OFFER_MS = 10 * 60 * 1000;

/** What a page sent, as text of at most `n` characters. */
export const clip = (v: unknown, n: number): string => String(v ?? "").slice(0, n);

/** `n` as a number kept between `lo` and `hi`; `lo` when it isn't one. */
export const clamp = (n: unknown, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Number(n) || lo));

/** The screen a tab's page asks for (its width, height and pixel ratio), kept within SCREEN. */
export function screenFor(w: unknown, h: unknown, dpr: unknown): Viewport {
  const width = Math.round(clamp(w, SCREEN.minWidth, SCREEN.maxWidth));
  const height = Math.round(clamp(h, SCREEN.minHeight, SCREEN.maxHeight));
  return { width, height, deviceScaleFactor: width > SCREEN.phoneMax ? 1 : clamp(dpr, 1, 2) };
}

/** The user holding a tab, taken over on its page: when they last did a step, and what they typed
 *  on the site they're on (a login the page may offer to save). */
export interface Hold {
  last: number;
  typed: { host: string; user: string; pass: string } | null;
}

/** A login to keep: one the user agreed to save when they entered it for the agent (saved once the
 *  page no longer asks for a password), or one the page offers them, a password they typed or a
 *  passkey a site made while they held the tab. Dropped when it runs out or the tab leaves its site. */
export type Offer = { site: string; user: string; until: number } & ({ kind: "password"; pass: string; agreed: boolean } | { kind: "passkey"; credential: Credential });

/** A tab page's passkey authenticator (passkey.ts): its DevTools session and its id. */
export interface Authenticator {
  cdp: CDPSession;
  id: string;
}

/** What the agent asked the user to enter on the tab's page: a login or a code, typed into the
 *  fields by their refs once the user gives it there, while the page is still on `host`. */
export interface Need {
  kind: "login" | "code";
  host: string;
  text: string;
  label?: string;
  userRef?: string;
  secretRef: string;
  /** What the secret's field is (snapshot.ts fieldOf) as it was asked, to know it again after. */
  field?: string;
  /** A new account's "Confirm password": the same secret goes there too. */
  confirmRef?: string;
  submitRef?: string;
  until: number;
}

/** A workspace's browser and its tabs, one per chat thread. */
export interface Entry {
  browser?: Browser;
  ready: Promise<Browser>;
  tabs: Map<string, Page>;
  /** What happened in a tab since its last read, for the agent. */
  notes: Map<string, string[]>;
  needs: Map<string, Need>;
  offers: Map<string, Offer>;
  /** The line each tab's page shows (say). */
  msgs: Map<string, { text: string; id: number; until: number }>;
  /** The tabs the user holds. */
  holds: Map<string, Hold>;
  /** The screen each tab's page asked for, given to every page the tab has. */
  screens: Map<string, Viewport>;
  /** Each tab page's passkey authenticator (passkey.ts). */
  authenticators: Map<Page, Authenticator>;
  /** What was typed into its pages that only the user may know, hidden from every read. */
  secrets: Set<string>;
  fence: ReturnType<typeof makeFence>;
  last: number;
  timer: NodeJS.Timeout | null;
  /** The save of its cookies to come (browser.ts), and what's saved now (sessions.ts). */
  saving: NodeJS.Timeout | null;
  saved: string | null;
  /** Keeps the browser open IDLE_MS from now (browser.ts). */
  touch: () => void;
  /** Saves its cookies a while from now, after a step that may have changed them (browser.ts). */
  changed: () => void;
  /** The tabs the agent is doing a step in, which the user can't take over meanwhile. */
  busy: Set<string>;
}

export const state = () =>
  perProcess("browser-lean.state", () => ({
    browsers: new Map<string, Entry>(),
    /** A thread-less run's tab, by its agent (scope.ts). */
    runs: new WeakMap<object, string>(),
    leases: new Map<string, Map<string, { run: WeakRef<object>; last: number }>>(),
  }));

/** How long the agent's request for a login or a code waits on the page. */
export const NEED_MS = 10 * 60 * 1000;

/** A tab's own name when the chat has no thread (the workspace's default chat). */
export const NO_THREAD = "_";
export const threadKey = (thread: string | number | undefined): string => (thread === undefined ? NO_THREAD : String(thread));

/** The skill's folder in AnythingLLM's storage. */
const skillDir = (): string => path.join(storageDir(), "browser-lean");

/** The skill's static files (guide, pages), as shipped or as tuned on this instance, under
 *  <storage>/browser-lean/static/. */
export const statics = (): StaticFiles => staticFiles(STATIC_FILES, path.join(skillDir(), "static"));

/** The skill's folder for a workspace in AnythingLLM's storage. */
export function workspaceDir(workspace: string): string {
  if (!/^[\w-]{1,100}$/.test(workspace) || workspace === "static") throw new BrowserError(`"${workspace}" isn't a workspace name the browser keeps`);
  return path.join(skillDir(), workspace);
}

/** Notes `text` for the next read of a thread's tab. */
export function note(entry: Entry, key: string, text: string): void {
  if (!entry.notes.has(key)) entry.notes.set(key, []);
  entry.notes.get(key)!.push(text);
}

/** What happened in a thread's tab since the last read, taken. */
export function takeNotes(entry: Entry, key: string): string[] {
  const notes = entry.notes.get(key) ?? [];
  entry.notes.set(key, []);
  return notes;
}

/** The user's hold on a thread's tab, or null; one with no step for HOLD_MS lapses, and the agent
 *  is told. */
export function holder(entry: Entry, key: string): Hold | null {
  const hold = entry.holds.get(key);
  if (hold && Date.now() - hold.last > HOLD_MS) {
    entry.holds.delete(key);
    note(entry, key, "the user took the tab over but did nothing on it for 10 minutes, so it's yours again. Read the page before going on");
  }
  return entry.holds.get(key) ?? null;
}

/** A chat's tab: its workspace's browser entry, its page, and its thread's key. */
export interface Tab {
  workspace: string;
  entry: Entry;
  page: Page;
  key: string;
}

/** What `map` holds for `key` while it lasts (its `until`); one that ran out is dropped. */
export function live<V extends { until: number }>(map: Map<string, V>, key: string): V | null {
  const value = map.get(key);
  if (value && value.until <= Date.now()) map.delete(key);
  return map.get(key) ?? null;
}

/** How long a line for a tab's page stays in its state: past the next few writes, so the page
 *  doesn't miss it. The page shows each line once, by its id. */
const SAY_MS = 60 * 1000;

/** Puts `text` on the page of `key`'s tab, in place of the line before. */
export function say(entry: Entry, key: string, text: string): void {
  const now = Date.now();
  entry.msgs.set(key, { text, id: Math.max(now, (entry.msgs.get(key)?.id ?? 0) + 1), until: now + SAY_MS });
}

