// What the library's tests share: AnythingLLM's storage and public folder standing in, the built
// handler.js called as AnythingLLM's agent calls it, and what the Library page and the Vault post,
// written as AnythingLLM's collector writes it.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { pageKeyFile } from "#shared/anythingllm";
import { writeAtomic } from "#shared/atomic";
import { hiddenFile, linksFile } from "#shared/page-links";
import { postEvent, setLinksHidden } from "#shared/test-helpers";
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
writeAtomic(pageKeyFile(storage), "brx-test\n"); // the pages' key, as `install --page-key` keeps it
process.env.FENCE_ALLOW = "127.0.0.1";

// The record of the machine the tests run on, as the installer writes it (shared/thishost.mts): a host
// key no stand-in shows and no addresses. Without a record kit.ssh refuses every target. A test can
// replace it, on globalThis under the same symbol.
export const THIS_HOST_FINGERPRINT = `SHA256:${"T".repeat(43)}`;
(globalThis as unknown as Record<symbol, unknown>)[Symbol.for("anywherellm-suite.thishost.record")] = { fingerprints: [THIS_HOST_FINGERPRINT], addresses: [] };

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
  /** The skill's other settings (NTFY_URL...), as the user set them. */
  settings?: Record<string, string>;
}

/** An agent run in workspace `slug` (null: none), in a chat of AnythingLLM's web UI. */
function agentRun(slug: string | null): object {
  const card = { requestUserClarification: async (q: unknown) => (cardsShown.push(q), { skipped: true }), addClarifyingQuestionSurvey: () => {} };
  return { handlerProps: { invocation: slug ? { workspace: { slug }, thread_id: 3 } : {} }, ...card };
}

/** Calls the skill as AnythingLLM's agent would: from workspace `slug` (null: none, as a job; given
 *  alone, or in a Call), in a chat that could show a question card, and with ANYTHINGLLM_URL set to
 *  `base`. */
export function call(args: Record<string, unknown>, at: Call | string | null = {}): Promise<string> {
  const { slug = "work", base, settings } = at === null || typeof at === "string" ? { slug: at } : at;
  const self = { super: agentRun(slug), runtimeArgs: { ...(base ? { ANYTHINGLLM_URL: base } : {}), ...settings }, logger: () => {} };
  return handler().call(self, args);
}

/** The run id an answer names. */
export const idOf = (text: string): string => text.match(/\((r-[\w-]+)\)/)![1];

/** How running the function `name` with `input` ended: its result, or its error as "Name: message". */
export async function outcome(name: string, input: Record<string, unknown> = {}): Promise<any> {
  const record = runRecord(idOf(await call({ action: "run", name, inputs: input })));
  return record.status === "ok" ? record.result : `${record.error.name}: ${record.error.message}`;
}

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

/** Forgets the library, the vault and the page between tests, the switch that keeps the pages'
 *  links from the agent and the file the links are kept in (the pages' key stays), and AnythingLLM's
 *  address as a call gave it, as a new process would. */
export function reset(): void {
  for (const dir of [library, path.join(storage, "vault-lean"), path.join(storage, "documents"), publicDir]) fs.rmSync(dir, { recursive: true, force: true });
  for (const file of [hiddenFile(storage), linksFile(storage)]) fs.rmSync(file, { force: true });
  delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("anywherellm-suite.anythingllm.base")];
}

/** Turns the switch that keeps the Library page's and the Vault's links from the agent on or off. */
export const hideLinks = (on: boolean): void => setLinksHidden(storage, on);

/** What the page posts (#shared/test-helpers postEvent), with the page's secret unless the event
 *  names another. */
export const post = (event: Record<string, unknown>): void =>
  postEvent(storage, "library-lean-event", { library_lean_event: 1, ...("secret" in event ? {} : { secret: pageConfig().secret }), ...event });

/** Posts `ev` for the toolkit `service` from the Library page (with `secret`, else the page's), and
 *  lets the skill apply it. */
export async function page(ev: string, service: string, secret?: string): Promise<void> {
  post({ ev, service, ...(secret ? { secret } : {}) });
  await call({ action: "library" });
}

/** What the Vault posts in its keys section (or `section`), with the Vault's secret unless the event
 *  names another. */
export const postVault = (event: Record<string, unknown>, section: "keys" | "addresses" = "keys"): void =>
  postEvent(storage, `vault-lean-${section}`, { vault_lean_event: 1, secret: vaultConfig().secret, ...event });

/** The Vault's settings: its token and secret, and the key and public key it was written with. */
export function vaultConfig(): { token: string; secret: string; key: string; pub: string; version: number } {
  const { token } = JSON.parse(fs.readFileSync(path.join(storage, "vault-lean", "vault-page.json"), "utf8"));
  const html = fs.readFileSync(path.join(publicDir, "vault-lean", `${token}.html`), "utf8");
  return JSON.parse(html.match(/const cfg = (\{.*?\});/)![1]);
}

/** What the Vault's keys section (or `section`) shows, as the Vault reads it. */
export const vaultState = (section: "keys" | "addresses" = "keys") => JSON.parse(fs.readFileSync(path.join(publicDir, "vault-lean", `${vaultConfig().token}-${section}.json`), "utf8"));

/** The page's own settings: its token and secret, and the key and public key it was written with. */
export function pageConfig(): { token: string; secret: string; key: string; pub: string } {
  const { token } = JSON.parse(fs.readFileSync(path.join(library, "page.json"), "utf8"));
  const html = fs.readFileSync(path.join(publicDir, "library-lean", `${token}.html`), "utf8");
  return JSON.parse(html.match(/const cfg = (\{.*?\});/)![1]);
}

/** What the page shows, as it reads it. */
export const pageState = () => JSON.parse(fs.readFileSync(path.join(publicDir, "library-lean", `${pageConfig().token}.json`), "utf8"));

/** `text` sealed as the pages seal it, with the vault's public key (`pub`, as a page has it: the
 *  Vault's by default): RSA-OAEP up to 190 bytes, and above that with a new AES-GCM key, itself
 *  sealed with RSA ("h1.<sealed key>.<iv>.<sealed>"). */
export function seal(text: string, pub: string = vaultConfig().pub): string {
  const key = crypto.createPublicKey({ key: Buffer.from(pub, "base64"), format: "der", type: "spki" });
  const rsa = (bytes: Buffer) => crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, bytes).toString("base64");
  if (Buffer.byteLength(text) <= 190) return rsa(Buffer.from(text));
  const aes = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const gcm = crypto.createCipheriv("aes-256-gcm", aes, iv);
  const sealed = Buffer.concat([gcm.update(text), gcm.final(), gcm.getAuthTag()]);
  return ["h1", rsa(aes), iv.toString("base64"), sealed.toString("base64")].join(".");
}
