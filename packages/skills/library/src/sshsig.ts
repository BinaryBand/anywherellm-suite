// SSH signatures (OpenSSH's SSHSIG, as `ssh-keygen -Y sign` writes them) with Ed25519: the format
// alone, for kit.secret.sign (signing.ts) and kit.crypto.sshsig.verify (extensions/crypto.ts). What a
// signature means (a channel's stamps, its peers) is the functions' own. SSHSIG signs the namespace
// with the data, so a signature checks only in its own namespace: that is a key's domain.

import crypto from "node:crypto";

export const BEGIN = "-----BEGIN SSH SIGNATURE-----";
export const END = "-----END SSH SIGNATURE-----";
// The DER around a raw Ed25519 seed (PKCS #8) and public key (SPKI).
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI = Buffer.from("302a300506032b6570032100", "hex");
// What Python's str.strip() and str.splitlines() take as space and as line ends: an armored block is
// read as sig.py reads it.
const SPACE = new RegExp("^[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]+|[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]+$", "g");
const strip = (t: string) => t.replace(SPACE, "");
const LINE_END = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

/** A string as SSH writes one: its length, then it. */
const s = (b: Buffer | string): Buffer => {
  const bytes = Buffer.from(b);
  const n = Buffer.alloc(4);
  n.writeUInt32BE(bytes.length);
  return Buffer.concat([n, bytes]);
};

/** The SSH string at `o`, and where the next starts. */
const rd = (b: Buffer, o: number): [Buffer, number] => {
  const n = b.readUInt32BE(o);
  if (o + 4 + n > b.length) throw new RangeError("past the end");
  return [b.subarray(o + 4, o + 4 + n), o + 4 + n];
};

/** A seed (32 bytes) as a signing key. */
export const privateKey = (seed: Buffer) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: "der", type: "pkcs8" });

/** A raw public key (32 bytes) as a key to check with. */
export const publicKey = (raw: Buffer) => crypto.createPublicKey({ key: Buffer.concat([SPKI, raw]), format: "der", type: "spki" });

/** A seed's public key, raw (32 bytes). */
export const publicOf = (seed: Buffer): Buffer => crypto.createPublicKey(privateKey(seed)).export({ format: "der", type: "spki" }).subarray(-32);

/** A raw public key as SSH's key blob. */
const wire = (pub: Buffer): Buffer => Buffer.concat([s("ssh-ed25519"), s(pub)]);

/** A raw public key as `ssh-ed25519 <base64>`. */
export const keyLine = (pub: Buffer): string => `ssh-ed25519 ${wire(pub).toString("base64")}`;

/** The key blob of a line `ssh-ed25519 <base64> [comment]`; null when it isn't one. */
function blobOf(line: string): Buffer | null {
  const [type, b64] = String(line).trim().split(/\s+/);
  if (type !== "ssh-ed25519" || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64 ?? "")) return null;
  const blob = Buffer.from(b64, "base64");
  try {
    const [t, o] = rd(blob, 0);
    const [pub, end] = rd(blob, o);
    return t.toString("latin1") === "ssh-ed25519" && pub.length === 32 && end === blob.length ? blob : null;
  } catch {
    return null;
  }
}

/** A public key as `ssh-keygen -l` names it. */
export const fingerprint = (pub: Buffer): string => `SHA256:${crypto.createHash("sha256").update(wire(pub)).digest("base64").replace(/=+$/, "")}`;

/** A seed as base64, checked: 32 bytes; null when it isn't one. */
export function seedOf(text: string): Buffer | null {
  const t = String(text ?? "").trim();
  const seed = /^[A-Za-z0-9+/]+={0,2}$/.test(t) ? Buffer.from(t, "base64") : Buffer.alloc(0);
  return seed.length === 32 ? seed : null;
}

/** What SSHSIG signs: the namespace and a hash of the data. */
const signed = (namespace: string, data: Buffer, alg = "sha512") =>
  Buffer.concat([Buffer.from("SSHSIG"), s(namespace), s(""), s(alg), s(crypto.createHash(alg).update(data).digest())]);

/** The armored SSHSIG of `data` in `namespace`, as `ssh-keygen -Y sign` writes it. */
export function signature(seed: Buffer, namespace: string, data: Buffer): string {
  const sig = Buffer.concat([s("ssh-ed25519"), s(crypto.sign(null, signed(namespace, data), privateKey(seed)))]);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(1);
  const blob = Buffer.concat([Buffer.from("SSHSIG"), version, s(wire(publicOf(seed))), s(namespace), s(""), s("sha512"), s(sig)]);
  return `${BEGIN}\n${blob.toString("base64").match(/.{1,70}/g)!.join("\n")}\n${END}\n`;
}

export type Checked = { valid: true; key: string } | { valid: false; reason: "bad-block" | "namespace-or-hash" | "unknown-key" | "bad-signature" | "bad-keys" };

/** Whether the armored `block` signs `data` in `namespace` by one of `keys` (`ssh-ed25519 …` lines),
 *  and by which: the reasons are sig.py's. */
export function check(block: string, namespace: string, data: Buffer, keys: string[]): Checked {
  const blobs = keys.map(blobOf);
  if (!blobs.length || blobs.some((b) => !b)) return { valid: false, reason: "bad-keys" };
  const lines = strip(block).split(LINE_END);
  if (strip(lines[0]) !== BEGIN || strip(lines.at(-1)!) !== END) return { valid: false, reason: "bad-block" };
  try {
    const blob = Buffer.from(lines.slice(1, -1).map(strip).join(""), "base64");
    if (blob.subarray(0, 6).toString("latin1") !== "SSHSIG" || blob.readUInt32BE(6) !== 1) return { valid: false, reason: "bad-block" };
    const [pk, o1] = rd(blob, 10);
    const [ns, o2] = rd(blob, o1);
    const [, o3] = rd(blob, o2);
    const [alg, o4] = rd(blob, o3);
    const [sig] = rd(blob, o4);
    if (ns.toString("latin1") !== namespace || !["sha256", "sha512"].includes(alg.toString("latin1"))) return { valid: false, reason: "namespace-or-hash" };
    const at = blobs.findIndex((b) => b!.equals(pk));
    if (at < 0) return { valid: false, reason: "unknown-key" };
    const ok = crypto.verify(null, signed(namespace, data, alg.toString("latin1")), publicKey(rd(pk, rd(pk, 0)[1])[0]), rd(sig, rd(sig, 0)[1])[0]);
    return ok ? { valid: true, key: keys[at] } : { valid: false, reason: "bad-signature" };
  } catch {
    return { valid: false, reason: "bad-signature" };
  }
}
