// What the library's tests share: AnythingLLM's storage, public folder and server modules standing
// in, the built handler.js called as AnythingLLM's agent calls it, and what the Library page posts,
// written as AnythingLLM's collector writes it.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

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
process.env.FENCE_ALLOW = "127.0.0.1";
process.env.SIG_KEY = "test-sig-key";
process.env.SIG_SALT = "test-sig-salt";

const bundle = path.join(skillDir, "build", "library-lean", "handler.js");
const handler = (): ((this: unknown, args: Record<string, unknown>) => Promise<string>) => {
  delete require.cache[bundle];
  return require(bundle).runtime.handler;
};

/** The question cards the skill showed: none, ever (a card shows its answers in the chat). */
export const cardsShown: unknown[] = [];

export interface Call {
  slug?: string | null;
  base?: string;
}

/** Calls the skill as AnythingLLM's agent would: from workspace `slug` (null: none, as a job), in a
 *  chat that could show a question card, and with ANYTHINGLLM_URL set to `base`. */
export function call(args: Record<string, unknown>, { slug = "work", base }: Call = {}): Promise<string> {
  const card = { requestUserClarification: async (q: unknown) => (cardsShown.push(q), { skipped: true }), addClarifyingQuestionSurvey: () => {} };
  const self = { super: { handlerProps: { invocation: slug ? { workspace: { slug }, thread_id: 3 } : {} }, ...card }, runtimeArgs: base ? { ANYTHINGLLM_URL: base } : {}, logger: () => {} };
  return handler().call(self, args);
}

/** Asks for the key `label` for `site`, and gives it on the page, as the user does. */
export async function giveKey(label: string, site: string, value: string): Promise<string> {
  const asked = await call({ action: "secret", site, label });
  post({ secret: pageConfig().secret, ev: "key-save", label, site, sealed: seal(value) });
  await call({ action: "library" });
  return asked;
}

/** Forgets the library, the vault and the page between tests. */
export function reset(): void {
  for (const dir of [library, path.join(storage, "vault-lean"), path.join(storage, "documents"), publicDir]) fs.rmSync(dir, { recursive: true, force: true });
}

let posts = 0;

/** What the page posts, written as AnythingLLM's collector writes it; each after the one before, as
 *  the page posts them one at a time. */
export function post(event: Record<string, unknown>): void {
  const dir = path.join(storage, "documents", "custom-documents");
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const file = path.join(dir, `raw-library-lean-event-${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, pageContent: JSON.stringify({ library_lean_event: 1, ...event }) }));
  const at = new Date(Date.now() + ++posts * 10);
  fs.utimesSync(file, at, at);
}

/** The page's own settings: its token and secret, and the key and public key it was written with. */
export function pageConfig(): { token: string; secret: string; key: string; pub: string } {
  const { token } = JSON.parse(fs.readFileSync(path.join(library, "page.json"), "utf8"));
  const html = fs.readFileSync(path.join(publicDir, "library-lean", `${token}.html`), "utf8");
  return JSON.parse(html.match(/const cfg = (\{.*?\});/)![1]);
}

/** What the page shows, as it reads it. */
export const pageState = () => JSON.parse(fs.readFileSync(path.join(publicDir, "library-lean", `${pageConfig().token}.json`), "utf8"));

/** `text` sealed as the page seals it, with the vault's public key: RSA-OAEP up to 190 bytes, and
 *  above that with a new AES-GCM key, itself sealed with RSA ("h1.<sealed key>.<iv>.<sealed>"). */
export function seal(text: string): string {
  const key = crypto.createPublicKey({ key: Buffer.from(pageConfig().pub, "base64"), format: "der", type: "spki" });
  const rsa = (bytes: Buffer) => crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, bytes).toString("base64");
  if (Buffer.byteLength(text) <= 190) return rsa(Buffer.from(text));
  const aes = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const gcm = crypto.createCipheriv("aes-256-gcm", aes, iv);
  const sealed = Buffer.concat([gcm.update(text), gcm.final(), gcm.getAuthTag()]);
  return ["h1", rsa(aes), iv.toString("base64"), sealed.toString("base64")].join(".");
}

/** Waits until `ok()` is true, for at most `ms`; fails the test when it never is. */
export async function until(ok: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
  assert.ok(ok(), "waited too long");
}
