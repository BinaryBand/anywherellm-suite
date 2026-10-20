// What the library's tests share: AnythingLLM's storage, public folder and server modules standing
// in, the built handler.js called as AnythingLLM's agent calls it, and what the Library page and the
// Vault post, written as AnythingLLM's collector writes it.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pageKeyFile } from "#shared/anythingllm";
import { writeAtomic } from "#shared/atomic";
import { vendoredVersions } from "../../../build.mjs";

const require = createRequire(import.meta.url);
export const testsDir = path.dirname(fileURLToPath(import.meta.url));
export const skillDir = path.join(testsDir, "..");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "library-lean-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
export const storage = path.join(tmp, "storage");
export const publicDir = path.join(tmp, "public");
export const library = path.join(storage, "library-lean");
process.env.STORAGE_DIR = storage;
process.env.ANYTHINGLLM_PUBLIC_DIR = publicDir;
process.env.ANYTHINGLLM_SERVER_DIR = path.join(testsDir, "fixtures", "server");
writeAtomic(pageKeyFile(storage), "brx-test\n"); // the pages' key, as `install --page-key` keeps it
process.env.FENCE_ALLOW = "127.0.0.1";
process.env.SIG_KEY = "test-sig-key";
process.env.SIG_SALT = "test-sig-salt";

// The vendored packages' versions as build.mjs inlines them, for the modules a test imports from src.
(globalThis as unknown as { VENDORED_VERSIONS: string }).VENDORED_VERSIONS = vendoredVersions("library");

const bundle = path.join(skillDir, "build", "library-lean", "handler.js");
const handler = (): ((this: unknown, args: Record<string, unknown>) => Promise<string>) => {
  delete require.cache[bundle];
  return require(bundle).runtime.handler;
};

/** Waits until `ok` holds, as what runs in the background gets there, for at most `ms`. */
export async function until(ok: () => boolean, ms = 4000): Promise<void> {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
  assert.ok(ok(), `not within ${ms} ms`);
}

/** The question cards the skill showed: none, ever (a card shows its answers in the chat). */
export const cardsShown: unknown[] = [];

export interface Call {
  slug?: string | null;
  base?: string;
  /** A chat through AnythingLLM's developer API (AnywhereLLM's): no thread, and the lines the skill
   *  shows in the chat kept here. */
  said?: string[];
  /** The agent run the call is part of (self.super), to call again in the same run. */
  run?: object;
}

/** An agent run for `call`'s `run`, in workspace `slug`; through the developer API when `api`. */
export function agentRun(slug: string | null = "work", api = false): object {
  const card = { requestUserClarification: async (q: unknown) => (cardsShown.push(q), { skipped: true }), addClarifyingQuestionSurvey: () => {} };
  return { handlerProps: { invocation: slug ? { workspace: { slug }, ...(api ? {} : { thread_id: 3 }) } : {} }, ...card };
}

/** Calls the skill as AnythingLLM's agent would: from workspace `slug` (null: none, as a job; given
 *  alone, or in a Call), in a chat that could show a question card, and with ANYTHINGLLM_URL set to
 *  `base`. */
export function call(args: Record<string, unknown>, at: Call | string | null = {}): Promise<string> {
  const { slug = "work", base, said, run } = at === null || typeof at === "string" ? { slug: at } : at;
  const self = { super: run ?? agentRun(slug, !!said), runtimeArgs: base ? { ANYTHINGLLM_URL: base } : {}, logger: () => {}, ...(said ? { introspect: (m: string) => said.push(m) } : {}) };
  return handler().call(self, args);
}

/** The run id an answer names. */
export const idOf = (text: string): string => text.match(/\((r-[\w-]+)\)/)![1];

/** A run as recorded. */
export function runRecord(id: string): Record<string, any> {
  const dir = path.join(library, "runs");
  return JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith(`${id}.`))!), "utf8"));
}

/** The skill as installed, where AnythingLLM keeps it, with plugin.json as shipped (and `extra`), for
 *  the test `t`: its description as it is now. */
export function installed(t: TestContext, extra: Record<string, unknown> = {}): { description: () => string; config: () => Record<string, unknown> } {
  const dir = path.join(storage, "plugins", "agent-skills", "library-lean");
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(path.join(storage, "plugins"), { recursive: true, force: true }));
  const file = path.join(dir, "plugin.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(skillDir, "plugin.json"), "utf8")), ...extra }));
  const config = () => JSON.parse(fs.readFileSync(file, "utf8"));
  return { description: () => config().description, config };
}

/** Asks for the key `label` for `site`, and gives it on the Vault, as the user does. */
export async function giveKey(label: string, site: string, value: string): Promise<string> {
  const asked = await call({ action: "secret", site, label });
  postVault({ ev: "key-save", label, site, sealed: seal(value) });
  await call({ action: "library" });
  return asked;
}

/** Forgets the library, the vault and the page between tests. */
export function reset(): void {
  for (const dir of [library, path.join(storage, "vault-lean"), path.join(storage, "documents"), publicDir]) fs.rmSync(dir, { recursive: true, force: true });
}

let posts = 0;

/** What the page posts, written as AnythingLLM's collector writes it, with the page's secret unless
 *  the event names another; each after the one before, as the page posts them one at a time. */
export function post(event: Record<string, unknown>): void {
  const dir = path.join(storage, "documents", "custom-documents");
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const file = path.join(dir, `raw-library-lean-event-${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, pageContent: JSON.stringify({ library_lean_event: 1, ...("secret" in event ? {} : { secret: pageConfig().secret }), ...event }) }));
  const at = new Date(Date.now() + ++posts * 10);
  fs.utimesSync(file, at, at);
}

/** What the Vault posts in its keys section, written as AnythingLLM's collector writes it, with the
 *  Vault's secret unless the event names another; each after the one before. */
export function postVault(event: Record<string, unknown>): void {
  const dir = path.join(storage, "documents", "custom-documents");
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const file = path.join(dir, `raw-vault-lean-keys-${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, pageContent: JSON.stringify({ vault_lean_event: 1, secret: vaultConfig().secret, ...event }) }));
  const at = new Date(Date.now() + ++posts * 10);
  fs.utimesSync(file, at, at);
}

/** The Vault's settings: its token and secret, and the key and public key it was written with. */
export function vaultConfig(): { token: string; secret: string; key: string; pub: string; version: number } {
  const { token } = JSON.parse(fs.readFileSync(path.join(storage, "vault-lean", "vault-page.json"), "utf8"));
  const html = fs.readFileSync(path.join(publicDir, "vault-lean", `${token}.html`), "utf8");
  return JSON.parse(html.match(/const cfg = (\{.*?\});/)![1]);
}

/** What the Vault's keys section shows, as the Vault reads it. */
export const vaultState = () => JSON.parse(fs.readFileSync(path.join(publicDir, "vault-lean", `${vaultConfig().token}-keys.json`), "utf8"));

/** The page's own settings: its token and secret, and the key and public key it was written with. */
export function pageConfig(): { token: string; secret: string; key: string; pub: string } {
  const { token } = JSON.parse(fs.readFileSync(path.join(library, "page.json"), "utf8"));
  const html = fs.readFileSync(path.join(publicDir, "library-lean", `${token}.html`), "utf8");
  return JSON.parse(html.match(/const cfg = (\{.*?\});/)![1]);
}

/** What the page shows, as it reads it. */
export const pageState = () => JSON.parse(fs.readFileSync(path.join(publicDir, "library-lean", `${pageConfig().token}.json`), "utf8"));

/** `text` sealed as the Vault seals it, with the vault's public key. */
export function seal(text: string): string {
  const key = crypto.createPublicKey({ key: Buffer.from(vaultConfig().pub, "base64"), format: "der", type: "spki" });
  return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(text)).toString("base64");
}

type SaveSignIn = (site: string, label: string, oauth: unknown, clientId: string) => Promise<void>;
let bundled: Promise<SaveSignIn> | null = null;

/** secrets.ts's saveSignIn, bundled as the handler is (src imports without extensions, which Node
 *  alone doesn't resolve): saves a sign-in as a preset does, but at any address a test names. */
export async function saveSignIn(...args: Parameters<SaveSignIn>): Promise<void> {
  bundled ??= (async () => {
    const { build } = await import("esbuild");
    const outfile = path.join(storage, "..", "from-src.mjs");
    await build({ stdin: { contents: 'export { saveSignIn } from "./secrets";', resolveDir: path.join(skillDir, "src"), loader: "ts" }, bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent" });
    return (await import(pathToFileURL(outfile).href)).saveSignIn as SaveSignIn;
  })();
  return (await bundled)(...args);
}
