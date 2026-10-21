// What the browser's tests share: AnythingLLM's storage and public folder standing in, a stand-in
// for the bundled Puppeteer (fixtures/puppeteer), the built handler.js called as AnythingLLM's agent
// calls it, and what a tab's page posts, written as AnythingLLM's collector writes it.

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { pageKeyFile } from "#shared/anythingllm";
import { writeAtomic } from "#shared/atomic";
import { hiddenFile } from "#shared/page-links";

const require = createRequire(import.meta.url);
export const testsDir = path.dirname(fileURLToPath(import.meta.url));
export const skillDir = path.join(testsDir, "..");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "browser-lean-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
export const storage = path.join(tmp, "storage");
export const publicDir = path.join(tmp, "public");
process.env.STORAGE_DIR = storage;
process.env.ANYTHINGLLM_PUBLIC_DIR = publicDir;
writeAtomic(pageKeyFile(storage), "brx-test\n"); // the pages' key, as `install --page-key` keeps it
process.env.BROWSER_LEAN_PUPPETEER = path.join(testsDir, "fixtures", "puppeteer", "index.js");
process.env.BROWSER_LEAN_CHROME = process.execPath; // a file that is there: the stand-in runs no Chrome

export interface Site {
  title?: string;
  text?: string;
  fields?: Record<string, { kind?: string; type?: string; name?: string; value?: string; box?: { x: number; y: number; w: number; h: number }; attrs?: Record<string, string>; blockedBy?: string[]; disabled?: boolean; behind?: { title: string; buttons: { ref: string; label: string }[] }; framed?: string; movedTo?: string }>;
  onclick?: Record<string, string>;
  onenter?: string;
  links?: { title: string; href: string; near: string }[];
}

/** A stand-in page's DevTools session: its authenticator's credentials, and `emit` to play Chrome. */
export interface Session {
  options: Record<string, unknown>;
  credentials: Map<string, Record<string, unknown>>;
  emit(name: string, payload: unknown): Promise<void>;
}

export interface StandInPage {
  clicks: string[];
  taps: [number, number][];
  wheels: number[];
  navs: string[];
  /** The refs typed into with keystrokes. */
  typed: string[];
  fields: Record<string, { value?: string }>;
  session: Session | null;
  url(): string;
  viewport(): { width: number; height: number; deviceScaleFactor: number };
}

export const { world, site } = require(process.env.BROWSER_LEAN_PUPPETEER) as {
  world: { launched: unknown[]; pages: StandInPage[]; apis: Record<string, unknown>; fetched: Record<string, unknown>[]; authenticators: Session[] };
  site: (url: string, s: Site) => void;
};

const bundle = path.join(skillDir, "build", "browser-lean", "handler.js");
const handler = (): ((this: unknown, args: Record<string, unknown>) => Promise<string>) => {
  delete require.cache[bundle];
  return require(bundle).runtime.handler;
};

export interface Call {
  workspace?: string | null;
  thread?: number | null;
  base?: string;
  settings?: Record<string, string>;
}

/** Calls the skill as AnythingLLM's agent would: from `workspace` and `thread` (null: none), with
 *  ANYTHINGLLM_URL set to `base`. The agent can't show a question card: the skill never asks one. */
export function call(args: Record<string, unknown>, { workspace = "home", thread = 1, base, settings = {} }: Call = {}): Promise<string> {
  const self = { super: { handlerProps: { invocation: workspace ? { workspace: { slug: workspace }, thread_id: thread } : {} } }, introspect: () => {}, runtimeArgs: { ...(base ? { ANYTHINGLLM_URL: base } : {}), ...settings }, logger: () => {} };
  return handler().call(self, args);
}

/** A tab's page's settings, as its page has them: its token, secret, keys, workspace and tab. */
export function tabConfig(workspace = "home", tab = "1"): { token: string; secret: string; key: string; pub: string; workspace: string; tab: string } {
  const { token } = JSON.parse(fs.readFileSync(path.join(storage, "browser-lean", workspace, "tabs.json"), "utf8"))[tab];
  const html = fs.readFileSync(path.join(publicDir, "browser-lean", `${token}.html`), "utf8");
  return JSON.parse(html.match(/const cfg = (\{.*?\});/)![1]);
}

/** A tab's state, as its page reads it. */
export function tabState(workspace = "home", tab = "1"): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(publicDir, "browser-lean", `${tabConfig(workspace, tab).token}.json`), "utf8"));
}

/** `text` sealed as the page seals it: WebCrypto's RSA-OAEP (SHA-256) with the vault's public key. */
export function seal(text: string, pub = tabConfig().pub): string {
  const key = crypto.createPublicKey({ key: Buffer.from(pub, "base64"), format: "der", type: "spki" });
  return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(text)).toString("base64");
}

let posts = 0;

/** The Vault's names and its logins section, as the tab pages link to it and the Vault reads it. */
export function vaultNames(): { token: string; secret: string } {
  return JSON.parse(fs.readFileSync(path.join(storage, "vault-lean", "vault-page.json"), "utf8"));
}
export const vaultLogins = (): { id: string; site: string; user: string; kind: string }[] =>
  JSON.parse(fs.readFileSync(path.join(publicDir, "vault-lean", `${vaultNames().token}-logins.json`), "utf8")).logins;

/** What the Vault's addresses section shows, as the Vault reads it. */
export const vaultAddresses = (): { origins: { origin: string }[]; refused: { origin: string }[]; result: { error: string } | null } =>
  JSON.parse(fs.readFileSync(path.join(publicDir, "vault-lean", `${vaultNames().token}-addresses.json`), "utf8"));

/** What the Vault posts in its logins section (or `section`), written as AnythingLLM's collector writes it. */
export function postVault(event: Record<string, unknown>, section: "logins" | "addresses" = "logins"): void {
  const dir = path.join(storage, "documents", "custom-documents");
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const file = path.join(dir, `raw-vault-lean-${section}-${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, pageContent: JSON.stringify({ vault_lean_event: 1, secret: vaultNames().secret, ...event }) }));
  const at = new Date(Date.now() + ++posts * 10);
  fs.utimesSync(file, at, at);
}

/** What a tab's page posts, written as AnythingLLM's collector writes it, each after the one before. */
export function post(event: Record<string, unknown>, { workspace = "home", tab = "1" } = {}): void {
  const dir = path.join(storage, "documents", "custom-documents");
  fs.mkdirSync(dir, { recursive: true });
  const cfg = tabConfig(workspace, tab);
  const id = crypto.randomUUID();
  const file = path.join(dir, `raw-browser-lean-event-${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, pageContent: JSON.stringify({ browser_lean_event: 1, workspace, tab, secret: cfg.secret, ...event }) }));
  const at = new Date(Date.now() + ++posts * 10);
  fs.utimesSync(file, at, at);
}

/** Keeps the Library and Vault links from the agent (the switch #shared/page-links reads) or gives them
 *  back; a test that turns it on turns it off in a `finally`. */
export function hideLinks(on: boolean): void {
  const file = hiddenFile(storage);
  if (!on) return void fs.rmSync(file, { force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "test\n");
}
