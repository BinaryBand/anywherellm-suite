// Signing keys: kept in the instance's vault (#shared/vault) as entries of kind "signing", { user: its
// name, site: the namespace it signs in, algorithm: "ed25519", seed, unattended }, the shape the
// temporary sshsig skill (anythingllm-temp-skills) saved them in, so its keys are read as they are.
// A function signs with one by its name (kit.secret.sign, runs.ts) and gets the signature, never the
// seed: the code that touches a secret is this repo's (docs/notes/skills/library/extensions-and-
// secrets.md). The user makes, imports and deletes them on the Vault (page.ts).
//
// What bounds a signing oracle, none of it the model's to change: a key signs only in its own
// namespace, which SSHSIG signs with the data, so its signatures mean nothing in another; it signs
// in a scheduled job only when the user lets it ("May run unattended"); at most PER_MINUTE times a
// minute from one process; and every use is in the run's record.

import crypto from "node:crypto";
import { perProcess } from "#shared/anythingllm";
import * as vault from "#shared/vault";
import { LibraryError } from "./errors";
import { check } from "./policy";
import * as sshsig from "./sshsig";

const NAMESPACE = /^[A-Za-z0-9][\w.@-]{0,99}$/;
const PER_MINUTE = 60;

/** A signing key as the agent and the Vault see it: never its seed. */
export interface SigningKey {
  label: string;
  namespace: string;
  /** `ssh-ed25519 <base64>`, and its fingerprint; null when its seed is damaged. */
  public: string | null;
  fingerprint: string | null;
  unattended: boolean;
}

/** What signed, for the run's record. */
export interface Use {
  fn: string;
  trigger: "chat" | "job";
}

/** Whether an entry is the signing key named `label` (any case), or any signing key. */
const named = (label?: string) => (e: Readonly<vault.Entry>) => e.kind === "signing" && (label === undefined || e.user.toLowerCase() === label.toLowerCase());

/** A namespace, checked. */
export function namespaceOf(raw: unknown): string {
  const ns = String(raw ?? "").trim();
  if (!NAMESPACE.test(ns)) throw new LibraryError('a signing key\'s namespace is letters, digits and . _ - @, at most 100, like "muse-coordination"');
  return ns;
}

const keyOf = (e: Readonly<vault.Entry>): SigningKey => {
  const seed = sshsig.seedOf(String(e.seed ?? ""));
  const pub = seed && sshsig.publicOf(seed);
  return { label: e.user, namespace: e.site, public: pub ? sshsig.keyLine(pub) : null, fingerprint: pub ? sshsig.fingerprint(pub) : null, unattended: e.unattended === true };
};

/** The saved signing keys, without their seeds. */
export const signingKeys = (): SigningKey[] => vault.entries().filter(named()).map(keyOf);

/** The signing key named `label`; a LibraryError when there's none. */
function entryOf(label: string): Readonly<vault.Entry> {
  const e = vault.entries().find(named(label));
  if (!e) throw new LibraryError(`no signing key named "${label}" is saved: the user makes or imports one on the Vault, under Signing`);
  return e;
}

/** The signing key `label`'s public key and namespace. */
export function publicKeyOf(label: string): { public: string; fingerprint: string; namespace: string } {
  const k = keyOf(entryOf(label));
  if (!k.public) throw new LibraryError(`the signing key "${label}" is damaged in the vault: the user deletes it on the Vault and imports it again`);
  return { public: k.public, fingerprint: k.fingerprint!, namespace: k.namespace };
}

/** `data` signed with the key `label`, in its own namespace, as an armored SSH signature. */
export function sign(label: string, data: Buffer, use: Use): { signature: string; public: string; namespace: string } {
  const e = entryOf(label);
  check({ op: "sign", fn: use.fn, key: e.user, trigger: use.trigger });
  if (use.trigger === "job" && e.unattended !== true) throw new LibraryError(`the signing key "${e.user}" doesn't sign in a scheduled job: the user allows it on the Vault ("May run unattended")`);
  if ((e.algorithm ?? "ed25519") !== "ed25519") throw new LibraryError(`the signing key "${e.user}" is ${String(e.algorithm)}, which the library doesn't sign with`);
  const seed = sshsig.seedOf(String(e.seed ?? ""));
  if (!seed) throw new LibraryError(`the signing key "${e.user}" is damaged in the vault: the user deletes it on the Vault and imports it again`);
  const now = Date.now();
  const recent = perProcess("library-lean.sign-calls", () => new Map<string, number[]>());
  const times = (recent.get(e.id) || []).filter((t) => now - t < 60 * 1000);
  if (times.length >= PER_MINUTE) throw new LibraryError(`the signing key "${e.user}" signed ${PER_MINUTE} times in the last minute: wait a minute, and sign less`);
  recent.set(e.id, [...times, now]);
  return { signature: sshsig.signature(seed, e.site, data), public: sshsig.keyLine(sshsig.publicOf(seed)), namespace: e.site };
}

/** Saves `seed` as the signing key `label` for `namespace`. A name is one secret: it can't be a key's
 *  or a sign-in's, and a signing key of that name isn't replaced (its peers know its public key): the
 *  same key again changes nothing. */
async function save(label: string, namespace: string, seed: Buffer): Promise<void> {
  await vault.update((v) => {
    const there = v.entries.find((e) => e.user.toLowerCase() === label.toLowerCase() && (e.kind === "key" || e.kind === "oauth" || e.kind === "signing"));
    if (there?.kind === "signing" && there.seed === seed.toString("base64") && there.site === namespace) return;
    if (there) throw new LibraryError(`"${there.user}" is ${there.kind === "signing" ? "a signing key" : there.kind === "oauth" ? "a sign-in" : "a key"} already: use another name, or delete it on the Vault first`);
    v.entries.push({ id: vault.newId(), kind: "signing", site: namespace, user: label, algorithm: "ed25519", seed: seed.toString("base64"), unattended: false });
  });
}

/** Makes a signing key `label` for `namespace`. */
export const create = (label: string, namespace: string): Promise<void> => save(label, namespace, crypto.randomBytes(32));

/** Saves a seed (32 bytes as base64) as the signing key `label` for `namespace`. */
export function importSeed(label: string, namespace: string, text: string): Promise<void> {
  const seed = sshsig.seedOf(text);
  if (!seed) throw new LibraryError("a signing key's seed is its 32 bytes as base64");
  return save(label, namespace, seed);
}

/** Deletes the signing key `label`; whether there was one. */
export const removeSigning = (label: string): Promise<boolean> =>
  vault.update((v) => {
    const before = v.entries.length;
    v.entries = v.entries.filter((e) => !named(label)(e));
    return v.entries.length < before;
  });

/** Lets the signing key `label` sign in a scheduled job, or not. */
export const setUnattended = (label: string, on: boolean): Promise<void> =>
  vault.update((v) => {
    const e = v.entries.find(named(label));
    if (e) e.unattended = on;
  });
