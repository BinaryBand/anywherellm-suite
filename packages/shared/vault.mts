// The secrets the skills use and the model never reads, for the whole AnythingLLM instance: the
// browser's passwords and passkeys, the library's API keys and OAuth sign-ins. Each is an entry
// { id, kind, site, user, ... } whose other fields are its kind's own; the skills give them meaning,
// this file only keeps them. The Vault page (vault-page.mts), which each skill that keeps secrets
// serves, lists them by name and deletes them. They're kept in one file, <storage>/vault-lean/vault.json, encrypted
// with AES-256-GCM under the key in VAULT_KEY_FILE, a file outside the storage (32 random bytes in
// base64), so a copy of the storage, or a backup of it, can't open the vault. Without it, the key
// is derived from AnythingLLM's own secret (SIG_KEY and SIG_SALT, in its .env in the storage), or,
// where those aren't set, a random key is kept beside the vault: that protects the vault file alone,
// not the storage it's in. Once VAULT_KEY_FILE is set, the vault is sealed again under its key the
// first time it's opened. VAULT_KEY_FILE must be in AnythingLLM's environment (a container's or
// the machine's), not in its .env, which AnythingLLM writes again keeping only the settings it
// knows. None of this protects the vault from someone with the whole machine. The file
// also holds an RSA key pair, made when a page first needs it: a page seals what the user types with
// the public key before it leaves their device, so only a skill can open it.
//
// Two skills (each with its own copy of this file, bundled in) and AnythingLLM's scheduled jobs (a
// child process) write it, so a change goes through update(): changes in one process wait their
// turn on a queue all copies share, and the processes take turns by a lock folder beside the file.
// A change is synchronous, so the lock is held for milliseconds: what needs the network (renewing an
// OAuth token) is done first, and the change then checks that what it read is still there.
// Ported from the lean browser skill's vault.js, which kept one vault per workspace.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { perBuild, storageDir } from "./anythingllm.mts";
import { locked, readJson, writeAtomic } from "./atomic.mts";
import { Told } from "./errors.mts";

/** A refusal to show the agent or the user as it is. */
export class VaultError extends Told {}

export interface Entry {
  id: string;
  kind: string;
  site: string;
  user: string;
  [field: string]: unknown;
}

export interface Vault {
  /** The public key pages seal with (SPKI, base64), or null until one is made. */
  pub: string | null;
  priv: string | null;
  entries: Entry[];
}

/** The label a derived key is made with (HKDF info). It keeps the suite's earlier name: a new one
 *  would derive another key, and every vault sealed under a derived key would be lost. */
const INFO = "anythingllm-suite vault v1";
const MAX_ENTRIES = 500;
const generateKeyPair = promisify(crypto.generateKeyPair);

/** The vault's folder in AnythingLLM's storage. */
export const vaultDir = (): string => path.join(storageDir(), "vault-lean");
const fileOf = (dir: string) => path.join(dir, "vault.json");

/** A key derived from AnythingLLM's own secret for `info`; null where SIG_KEY and SIG_SALT aren't set. */
function derivedKey(info: string): Buffer | null {
  const { SIG_KEY, SIG_SALT } = process.env;
  return SIG_KEY && SIG_SALT ? Buffer.from(crypto.hkdfSync("sha256", SIG_KEY, SIG_SALT, info, 32)) : null;
}

/** The 32-byte key kept in `file`; null when there's none. */
function keptKey(file: string): Buffer | null {
  try {
    const key = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

/** Where a random key is kept beside the vault when there's no other. */
const keyBeside = (dir: string): string => path.join(dir, "vault.key");

/** VAULT_KEY_FILE: where the vault's key is kept outside the storage, or null. */
const keyFile = (): string | null => process.env.VAULT_KEY_FILE || null;

/** The key the vault is encrypted with: VAULT_KEY_FILE's, else derived, else kept beside it (made
 *  the first time). */
function masterKey(dir: string): Buffer {
  const outside = keyFile();
  if (outside) {
    const key = keptKey(outside);
    if (!key) throw new VaultError(`VAULT_KEY_FILE (${outside}) holds no key: it should hold 32 random bytes in base64, as \`openssl rand -base64 32\` prints them`);
    return key;
  }
  const file = keyBeside(dir);
  const kept = derivedKey(INFO) ?? keptKey(file);
  if (kept) return kept;
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(file, crypto.randomBytes(32).toString("base64") + "\n", { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // another process made it first
  }
  const made = keptKey(file);
  if (!made) throw new VaultError(`the vault's key in ${file} can't be read`);
  return made;
}

interface Box {
  iv: string;
  tag: string;
  data: string;
}

function seal(key: Buffer, value: unknown): Box {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

function unseal(key: Buffer, box: Box): unknown {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]).toString("utf8"));
}

/** The keys a vault was sealed with before VAULT_KEY_FILE was set: the derived one, the one kept beside it. */
const earlierKeys = (dir: string): Buffer[] => (keyFile() ? [derivedKey(INFO), keptKey(keyBeside(dir))].filter((k): k is Buffer => !!k) : []);

/** What `box` holds, opened with the vault's key or an earlier one (`earlier`: it's to be sealed
 *  again under the vault's key). */
function openBox(dir: string, box: Box): { value: unknown; earlier: boolean } {
  const master = masterKey(dir);
  for (const key of [master, ...earlierKeys(dir)]) {
    try {
      return { value: unseal(key, box), earlier: key !== master };
    } catch {} // the next key
  }
  throw new VaultError(
    keyFile()
      ? "the vault can't be opened with the key in VAULT_KEY_FILE, nor with the one it had before"
      : "the vault can't be opened: AnythingLLM's SIG_KEY or SIG_SALT changed since it was saved, or the vault was moved to a key file and VAULT_KEY_FILE isn't set",
  );
}

/** The vault as its file holds it, opened, and whether it was opened with an earlier key; an empty
 *  one when there's no file. */
function read(dir: string): { vault: Vault; earlier: boolean } {
  const saved = readJson<{ v: number; pub: string | null; box: Box } | null>(fileOf(dir), () => null);
  if (!saved) return { vault: { pub: null, priv: null, entries: [] }, earlier: false };
  if (saved.v !== 1) throw new VaultError(`the vault is version ${saved.v}, which this skill can't read; update the suite`);
  const { value, earlier } = openBox(dir, saved.box);
  const inner = value as { priv: string | null; entries: Entry[] };
  return { vault: { pub: saved.pub, priv: inner.priv, entries: inner.entries }, earlier };
}

// What was read or written last, by the file's stamp and the secret it's opened with: a change
// replaces the file (writeAtomic renames it), so an unchanged stamp is an unchanged vault. Kept per
// process and build, across handler reloads.
type Cached = { at: string; vault: Vault; priv?: crypto.KeyObject };
const cache = () => perBuild("vault.cache", () => ({ last: null as Cached | null }));

/** Where the vault is, what its file is now, and what it's opened with. */
const stampOf = (dir: string): string => {
  let file = "none";
  try {
    const s = fs.statSync(fileOf(dir));
    file = `${s.ino}:${s.mtimeMs}:${s.size}`;
  } catch {}
  return [dir, file, process.env.SIG_KEY, process.env.SIG_SALT, keyFile()].join("\0");
};

function store(dir: string, vault: Vault): void {
  if (vault.entries.length > MAX_ENTRIES) throw new VaultError(`the vault keeps at most ${MAX_ENTRIES} entries`);
  const box = seal(masterKey(dir), { priv: vault.priv, entries: vault.entries });
  writeAtomic(fileOf(dir), JSON.stringify({ v: 1, pub: vault.pub, box }), 0o600);
  cache().last = { at: stampOf(dir), vault: structuredClone(vault) };
}

/** The vault as it is now, from the cache when the file hasn't changed: not to be changed. One
 *  opened with an earlier key is sealed again under VAULT_KEY_FILE's, once, in the background. */
function current(dir: string): Cached {
  const kept = cache();
  const at = stampOf(dir);
  if (kept.last?.at !== at) {
    const { vault, earlier } = read(dir);
    kept.last = { at, vault };
    if (earlier) void update(() => undefined, dir).catch(() => {}); // the stamp is cached now, so once
  }
  return kept.last;
}

/** The vault, opened, as a copy: what's changed in it isn't kept (that's update's). */
export const load = (dir: string = vaultDir()): Vault => structuredClone(current(dir).vault);

/** The vault's entries as they are now, without a copy: only to read. */
export const entries = (dir: string = vaultDir()): readonly Readonly<Entry>[] => current(dir).vault.entries;

/** Changes the vault: `change` gets it as the file holds it now and changes it in place; what it
 *  answers is answered. Nothing is written when it throws. One change at a time, across this
 *  process's skills and across processes. */
export function update<T>(change: (vault: Vault) => T, dir: string = vaultDir()): Promise<T> {
  return locked(path.join(dir, "vault.lock"), "the vault", () => {
    const { vault } = read(dir);
    const answer = change(vault);
    store(dir, vault);
    return answer;
  });
}

/** A file of its own beside the vault, sealed with the vault's key, for what changes often (a
 *  browser's cookies): a change to it doesn't rewrite the vault, nor make every process open the
 *  vault again. One writer at a time is assumed; the last write wins. */
const sealedFile = (name: string, dir: string): string => {
  if (!/^[\w-]{1,120}$/.test(name)) throw new VaultError(`"${name}" isn't a name for a sealed file`);
  return path.join(dir, "sealed", `${name}.json`);
};

/** What the sealed file `name` holds, or null when there's none. One sealed under an earlier key is
 *  sealed again under the vault's. */
export function readSealed(name: string, dir: string = vaultDir()): unknown {
  const saved = readJson<{ box: Box } | null>(sealedFile(name, dir), () => null);
  if (!saved) return null;
  const { value, earlier } = openBox(dir, saved.box);
  if (earlier) writeSealed(name, value, dir);
  return value;
}

/** Seals `value` into the file `name` beside the vault; null removes the file. */
export function writeSealed(name: string, value: unknown, dir: string = vaultDir()): void {
  const file = sealedFile(name, dir);
  if (value === null) return void fs.rmSync(file, { force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeAtomic(file, JSON.stringify({ v: 1, box: seal(masterKey(dir), value) }), 0o600);
}

/** A new entry's id. */
export const newId = (): string => crypto.randomBytes(9).toString("base64url");

/** The public key pages seal with (SPKI, base64, for WebCrypto's RSA-OAEP), made the first time
 *  without holding the lock while it's made. */
export async function publicKey(dir: string = vaultDir()): Promise<string> {
  const kept = current(dir).vault.pub;
  if (kept) return kept;
  const pair = await generateKeyPair("rsa", { modulusLength: 2048 });
  return update((vault) => {
    if (!vault.pub) {
      vault.pub = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
      vault.priv = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    }
    return vault.pub;
  }, dir);
}

/** What a page sealed, opened: base64 RSA-OAEP with SHA-256, or for a longer value
 *  "h1.<key>.<iv>.<value>", the value sealed with AES-256-GCM (its tag last) and its key with RSA. */
export function openSealed(sealed: string, dir: string = vaultDir()): string {
  const now = current(dir);
  if (!now.vault.priv) throw new VaultError("nothing was sealed for this vault yet; reload the page");
  const key = (now.priv ||= crypto.createPrivateKey(now.vault.priv));
  const rsa = (b64: string) => crypto.privateDecrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(b64, "base64"));
  try {
    const parts = String(sealed).split(".");
    if (parts[0] !== "h1") return rsa(String(sealed)).toString("utf8");
    if (parts.length !== 4) throw new Error("not sealed");
    const box = Buffer.from(parts[3], "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", rsa(parts[1]), Buffer.from(parts[2], "base64"));
    decipher.setAuthTag(box.subarray(box.length - 16));
    return Buffer.concat([decipher.update(box.subarray(0, box.length - 16)), decipher.final()]).toString("utf8");
  } catch {
    throw new VaultError("a sealed value couldn't be opened; reload the page");
  }
}
