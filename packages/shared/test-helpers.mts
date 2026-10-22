// What the tests of the skills, the shared modules and the installer share: an event a page posts,
// written as AnythingLLM's collector writes it, the switch that keeps the Library and Vault links from
// the agent, turned on and off as the owner does, the Vault as its page has it, a page's sealing, a
// server on a free port, and a module bundled as the skills' build bundles it. For tests only:
// nothing shipped imports it.

import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import { createRequire } from "node:module";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { writeAtomic } from "./atomic.mts";
import { hiddenFile } from "./page-links.mts";
import { eventsDir } from "./pages.mts";

let posts = 0;

/** Writes what a page posted under `title` (#shared/pages take) into the storage `storage`, as
 *  AnythingLLM's collector writes it: `payload` as JSON, or `raw` as the text when given. Each lands
 *  after the one before, as a page posts them one at a time, and a minute ago, so one that can't be
 *  read is dropped, not waited on as a file still being written. */
export function postEvent(storage: string, title: string, payload: unknown, raw?: string): void {
  const dir = eventsDir(storage);
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const file = path.join(dir, `raw-${title}-${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, title: `${title}.txt`, pageContent: raw ?? JSON.stringify(payload) }));
  const at = new Date(Date.now() - 60_000 + ++posts * 10);
  fs.utimesSync(file, at, at);
}

/** Turns the switch that keeps the Library page's and the Vault's links from the agent on or off in
 *  the storage `storage`, as `anywherellm-suite pages --hide` and `--show` do on the host. */
export function setLinksHidden(storage: string, on: boolean): void {
  if (on) writeAtomic(hiddenFile(storage), "2026-10-21T00:00:00.000Z\n");
  else fs.rmSync(hiddenFile(storage), { force: true });
}

/** Starts `server` on a free port of 127.0.0.1: the port. */
export function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));
}

/** Stops `server`, its open connections with it. */
export async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

/** The settings a page's HTML was written with (its `const cfg = {...};`). */
export function pageCfg<T = Record<string, any>>(html: string): T {
  return JSON.parse(html.match(/const cfg = (\{.*?\});/)![1]);
}

/** The Vault's names in the storage `storage`: its token and the secret its events carry. */
export const vaultNames = (storage: string): { token: string; secret: string; hidden?: true } =>
  JSON.parse(fs.readFileSync(path.join(storage, "vault-lean", "vault-page.json"), "utf8"));

/** The Vault's settings, as its page in `publicDir` has them: its token and secret, and the key and
 *  public key it was written with. */
export const vaultConfig = (storage: string, publicDir: string): { token: string; secret: string; key: string; pub: string; version: number } =>
  pageCfg(fs.readFileSync(path.join(publicDir, "vault-lean", `${vaultNames(storage).token}.html`), "utf8"));

/** What the Vault posts in its section `section` (postEvent), with the Vault's secret unless the
 *  event names another. */
export const postVault = (storage: string, section: string, event: Record<string, unknown>): void =>
  postEvent(storage, `vault-lean-${section}`, { vault_lean_event: 1, secret: vaultNames(storage).secret, ...event });

/** `text` sealed as the pages seal it, with the vault's public key `pub` (as a page has it): RSA-OAEP
 *  up to 190 bytes, and above that with a new AES-GCM key, itself sealed with RSA
 *  ("h1.<sealed key>.<iv>.<sealed>"). */
export function seal(text: string, pub: string): string {
  const key = crypto.createPublicKey({ key: Buffer.from(pub, "base64"), format: "der", type: "spki" });
  const rsa = (bytes: Buffer) => crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, bytes).toString("base64");
  if (Buffer.byteLength(text) <= 190) return rsa(Buffer.from(text));
  const aes = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const gcm = crypto.createCipheriv("aes-256-gcm", aes, iv);
  const sealed = Buffer.concat([gcm.update(text), gcm.final(), gcm.getAuthTag()]);
  return ["h1", rsa(aes), iv.toString("base64"), sealed.toString("base64")].join(".");
}

/** The module at `entry` bundled as the skills' build (esbuild) bundles it, pages imported as text:
 *  the bundle's path, removed after the tests. */
export async function bundle(entry: URL): Promise<string> {
  const { build } = await import("esbuild");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${path.basename(entry.pathname, ".mts")}-build-`));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outfile = path.join(dir, `${path.basename(entry.pathname, ".mts")}.cjs`);
  await build({ entryPoints: [fileURLToPath(entry)], outfile, bundle: true, platform: "node", format: "cjs", loader: { ".html": "text" }, logLevel: "silent" });
  return outfile;
}

/** The module at `entry`, bundled (bundle) and loaded. */
export async function bundled<T>(entry: URL): Promise<T> {
  return createRequire(import.meta.url)(await bundle(entry)) as T;
}
