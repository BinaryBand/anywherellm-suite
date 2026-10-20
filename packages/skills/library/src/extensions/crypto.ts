// kit.crypto: hashes, secure randomness and checking signatures, which a function can't do well in
// QuickJS (it has no crypto.getRandomValues, and Ed25519 interpreted is slow). An extension only
// computes (docs/notes/skills/library/extensions-and-secrets.md): JSON in, JSON out, no network, no
// files, no vault, nothing kept. It runs on the host's thread, outside the sandbox's limits, so each
// input is capped. Nothing here takes a secret key: a function can't keep one (its source and state
// are plain JSON any later function can return), so what needs one (signing, an HMAC) is
// kit.secret's, with a key in the vault (signing.ts).
//
// Bytes go in as UTF-8 text, or as { base64 }; they come out as hex, or as base64 when `as` says so.

import crypto from "node:crypto";
import { LibraryError } from "../errors";
import * as sshsig from "../sshsig";

const MAX_BYTES = 1024 * 1024;
const MAX_RANDOM = 1024;
const AS = ["hex", "base64", "base64url"] as const;

type As = (typeof AS)[number];

/** Bytes given as text or { base64 }, checked; `what` names them in a refusal. */
export function bytesOf(v: unknown, what: string): Buffer {
  let bytes: Buffer;
  if (typeof v === "string") bytes = Buffer.from(v, "utf8");
  else if (v && typeof v === "object" && typeof (v as { base64?: unknown }).base64 === "string") {
    const b64 = (v as { base64: string }).base64.trim();
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64)) throw new LibraryError(`${what}'s base64 isn't base64`);
    bytes = Buffer.from(b64, "base64");
  } else throw new LibraryError(`${what} is text, or { base64 }`);
  if (bytes.length > MAX_BYTES) throw new LibraryError(`${what} is at most ${MAX_BYTES / 1024} KB`);
  return bytes;
}

/** How bytes come out: `as` checked, `fallback` when there's none. */
function asOf(opts: unknown, fallback: As = "hex"): As {
  const as = (opts as { as?: unknown } | undefined)?.as ?? fallback;
  if (!AS.includes(as as As)) throw new LibraryError(`as is ${AS.join(", ")}`);
  return as as As;
}

/** An Ed25519 public key given as its 32 raw bytes in base64. */
function publicOf(v: unknown): crypto.KeyObject {
  const raw = sshsig.seedOf(String(v ?? "")); // 32 bytes as base64, as a seed is
  if (!raw) throw new LibraryError("public is 32 bytes as base64");
  return sshsig.publicKey(raw);
}

const args = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

const digest = (alg: string) => (data: unknown, opts?: unknown) => crypto.createHash(alg).update(bytesOf(data, "data")).digest(asOf(opts));

export const cryptoKit = {
  sha256: digest("sha256"),
  sha512: digest("sha512"),
  random: (n: unknown, opts?: unknown) => {
    const count = Number(n);
    if (!Number.isInteger(count) || count < 1 || count > MAX_RANDOM) throw new LibraryError(`random takes a number of bytes, 1 to ${MAX_RANDOM}`);
    return crypto.randomBytes(count).toString(asOf(opts, "base64"));
  },
  uuid: () => crypto.randomUUID(),
  ed25519: {
    verify: (a: unknown) => {
      const { public: pub, data, signature } = args(a);
      const sig = typeof signature === "string" ? Buffer.from(signature, "base64") : Buffer.alloc(0);
      if (sig.length !== 64) return false;
      return crypto.verify(null, bytesOf(data, "data"), publicOf(pub), sig);
    },
  },
  sshsig: {
    /** Whether `signature` (an armored SSH signature) signs `data` in `namespace` by one of `keys`. */
    verify: (a: unknown) => {
      const { signature, data, namespace, keys } = args(a);
      if (typeof signature !== "string" || signature.length > 64 * 1024) throw new LibraryError("signature is the armored block, -----BEGIN SSH SIGNATURE----- to its END line");
      if (typeof namespace !== "string" || !namespace) throw new LibraryError("namespace is the namespace it was signed in");
      if (!Array.isArray(keys) || keys.length > 100) throw new LibraryError('keys is a list of public keys, "ssh-ed25519 <base64>"');
      return sshsig.check(signature, namespace, bytesOf(data, "data"), keys.map(String));
    },
  },
};
