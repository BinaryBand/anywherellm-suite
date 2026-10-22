// The secrets the skills use and the model never reads, for the whole AnythingLLM instance: the
// browser's passwords and passkeys, the library's API keys, signing keys and SSH targets. Each is an
// entry { id, kind, site, user, ... } whose other fields are its kind's own; the skills give them meaning,
// this file only keeps them. The Vault page (vault-page.mts), which each skill that keeps secrets
// serves, lists them by name and deletes them. They're kept in one file,
// <storage>/vault-lean/vault.json, encrypted with AES-256-GCM under a random key (32 bytes in
// base64) the suite makes the first time it's needed and keeps beside the vault, in
// <storage>/vault-lean/vault.key: that protects the vault file alone, not the storage it's in. To
// keep the key apart, move that file out of the storage and name it in VAULT_KEY_FILE, which takes
// its place and must be in AnythingLLM's environment (a container's or the machine's), not in its
// .env, which AnythingLLM writes again keeping only the settings it knows. None of this protects
// the vault from someone with the whole machine. The file also holds an RSA key pair, made when a
// page first needs it: a page seals what the user types with the public key before it leaves their
// device, so only a skill can open it.
//
// Two skills (each with its own copy of this file, bundled in) and AnythingLLM's scheduled jobs (a
// child process) write it, so a change goes through update(): changes in one process wait their
// turn on a queue all copies share, and the processes take turns by a lock folder beside the file.
// A change is synchronous, so the lock is held for milliseconds: what needs the network is done
// first, and the change then checks that what it read is still there.
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

const MAX_ENTRIES = 500;
const generateKeyPair = promisify(crypto.generateKeyPair);

/** The vault's folder in AnythingLLM's storage. */
export const vaultDir = (): string => path.join(storageDir(), "vault-lean");
const fileOf = (dir: string) => path.join(dir, "vault.json");

/** The 32-byte key kept in `file`; null when there's none. */
function keptKey(file: string): Buffer | null {
  try {
    const key = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

/** Where the vault's key is kept, unless VAULT_KEY_FILE says another place. */
const keyBeside = (dir: string): string => path.join(dir, "vault.key");

/** VAULT_KEY_FILE: where the vault's key is kept instead, outside the storage, or null. */
const keyFile = (): string | null => process.env.VAULT_KEY_FILE || null;

/** Why the vault stays closed when its key isn't the one it was saved with, or isn't there. */
const closed = (dir: string): VaultError =>
  new VaultError(
    keyFile()
      ? "the vault can't be opened with the key in VAULT_KEY_FILE: it isn't the one the vault was saved with"
      : `the vault can't be opened with the key in ${keyBeside(dir)}: it was lost or changed since the vault was saved (put the key back, or see Secrets in the README to start a new vault)`,
  );

/** The key the vault is sealed with, to open what is sealed: VAULT_KEY_FILE's, else the one kept beside it. */
function keyOf(dir: string): Buffer {
  const outside = keyFile();
  if (outside) {
    const key = keptKey(outside);
    if (!key) throw new VaultError(`VAULT_KEY_FILE (${outside}) holds no key: it should hold 32 random bytes in base64, as \`openssl rand -base64 32\` prints them`);
    return key;
  }
  const key = keptKey(keyBeside(dir));
  if (!key) throw closed(dir);
  return key;
}

/** Whether anything in the vault's folder is sealed under its key: the vault, or a sealed file. */
const hasSealed = (dir: string): boolean => {
  try {
    return fs.existsSync(fileOf(dir)) || fs.readdirSync(path.join(dir, "sealed")).some((f) => f.endsWith(".json"));
  } catch {
    return false;
  }
};

/** The key to seal with: `keyOf`'s, made beside the vault the first time, when nothing is sealed yet.
 *  Something sealed is never given a new key, which would only leave it closed for good. */
function sealKey(dir: string): Buffer {
  if (keyFile() || keptKey(keyBeside(dir)) || hasSealed(dir)) return keyOf(dir);
  const file = keyBeside(dir);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(file, crypto.randomBytes(32).toString("base64") + "\n", { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // another process made it first
  }
  return keyOf(dir);
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

/** What `box` holds, opened with the vault's key; a VaultError saying so when it isn't the one it was sealed with. */
function openBox(dir: string, box: Box): unknown {
  const key = keyOf(dir);
  try {
    return unseal(key, box);
  } catch {
    throw closed(dir);
  }
}

/** The vault as its file holds it, opened; an empty one when there's no file. */
function read(dir: string): Vault {
  const saved = readJson<{ v: number; pub: string | null; box: Box } | null>(fileOf(dir), () => null);
  if (!saved) return { pub: null, priv: null, entries: [] };
  if (saved.v !== 1) throw new VaultError(`the vault is version ${saved.v}, which this skill can't read; update the suite`);
  const inner = openBox(dir, saved.box) as { priv: string | null; entries: Entry[] };
  return { pub: saved.pub, priv: inner.priv, entries: inner.entries };
}

// What was read or written last, by the file's stamp and the key it's opened with: a change
// replaces the file (writeAtomic renames it), so an unchanged stamp is an unchanged vault. Kept per
// process and build, across handler reloads.
type Cached = { at: string; vault: Vault; priv?: crypto.KeyObject };
const cache = () => perBuild("vault.cache", () => ({ last: null as Cached | null }));

/** Where the vault is, what its file is now, and where its key is (a key that goes missing shows
 *  the next time the vault is read from its file, which any change does). */
const stampOf = (dir: string): string => {
  let file = "none";
  try {
    const s = fs.statSync(fileOf(dir));
    file = `${s.ino}:${s.mtimeMs}:${s.size}`;
  } catch {}
  return [dir, file, keyFile()].join("\0");
};

function store(dir: string, vault: Vault): void {
  if (vault.entries.length > MAX_ENTRIES) throw new VaultError(`the vault keeps at most ${MAX_ENTRIES} entries`);
  const box = seal(sealKey(dir), { priv: vault.priv, entries: vault.entries });
  writeAtomic(fileOf(dir), JSON.stringify({ v: 1, pub: vault.pub, box }), 0o600);
  cache().last = { at: stampOf(dir), vault: structuredClone(vault) };
}

/** The vault as it is now, from the cache when the file hasn't changed: not to be changed. */
function current(dir: string): Cached {
  const kept = cache();
  const at = stampOf(dir);
  if (kept.last?.at !== at) kept.last = { at, vault: read(dir) };
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
    const vault = read(dir);
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

/** What the sealed file `name` holds, or null when there's none. */
export function readSealed(name: string, dir: string = vaultDir()): unknown {
  const saved = readJson<{ box: Box } | null>(sealedFile(name, dir), () => null);
  return saved ? openBox(dir, saved.box) : null;
}

/** Seals `value` into the file `name` beside the vault; null removes the file. */
export function writeSealed(name: string, value: unknown, dir: string = vaultDir()): void {
  const file = sealedFile(name, dir);
  if (value === null) return void fs.rmSync(file, { force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeAtomic(file, JSON.stringify({ v: 1, box: seal(sealKey(dir), value) }), 0o600);
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
