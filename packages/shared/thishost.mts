// Which machine is this one: a target that is this machine, or answers from an address of it, signs
// the agent in as an account here, which reads what AnythingLLM keeps beside it (the vault's key, the
// pages' secrets). So the library refuses these however the user ticked the target, and checks the
// address the connection is made to, not only the name. Three things say "this machine":
//
//   - loopback, link-local and unspecified addresses, and every address of every interface this
//     process sees. Inside a container that list is the container's (a pasta container shows lo and
//     the LAN, not the host's tailnet address), so
//   - the install on the host records the host's own addresses and the fingerprints of its SSH host
//     keys in <storage>/anywherellm-suite/this-host.json (packages/install/src/thishost.mts), and
//     both are refused too: a machine that shows one of the host's keys is the host, whatever address
//     it was reached at.
//
// That file is written by the installer, on the host, and only read here. A host that was never
// (re)installed has none: kit.ssh then refuses every target (thisHostUsable), since it can't tell.
// A test that stands a machine up on 127.0.0.1 names it in THISHOST_EXCEPT (a Set on globalThis), and
// a test can give the record in THISHOST_RECORD; nothing shipped sets either.

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { perBuild, storageDir, SUITE_DIR } from "./anythingllm.mts";
import { fileStamp } from "./atomic.mts";

/** The test seam: addresses to treat as not this machine. Nothing shipped sets it. */
export const THISHOST_EXCEPT = Symbol.for("anywherellm-suite.thishost.except");
/** The test seam: a ThisHost record used instead of the file's. Nothing shipped sets it. */
export const THISHOST_RECORD = Symbol.for("anywherellm-suite.thishost.record");

/** What the installer records of the host it runs on. */
export interface ThisHost {
  /** `SHA256:…` of each of its SSH host keys, as ssh-keygen -lf prints them. */
  fingerprints: string[];
  /** Every address of every interface it has, IPv4 and IPv6. */
  addresses: string[];
}

/** Where the installer records this host, in AnythingLLM's storage `storage`. */
export const thisHostFile = (storage: string = storageDir()): string => path.join(storage, SUITE_DIR, "this-host.json");

/** `SHA256:…` of an SSH public key's blob, as ssh-keygen -l prints it. */
export const sshFingerprint = (blob: Buffer): string => `SHA256:${crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;

const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((s) => typeof s === "string") ? (v as string[]) : null);

type Recorded = { host: ThisHost } | { why: string };

/** The recorded host, or why there is none: no file, one that can't be read, or one that isn't a
 *  record. The library reads it from its own storage; health from the one it checks. Read again
 *  only when the file changes (by its stamp: the installer replaces it whole), as the fence's
 *  allowed.json is. */
export function recorded(storage?: string): Recorded {
  const g = globalThis as unknown as Record<symbol, ThisHost | undefined>;
  if (g[THISHOST_RECORD]) return { host: g[THISHOST_RECORD] };
  let file: string;
  try {
    file = thisHostFile(storage);
  } catch (e) {
    return { why: (e as Error).message };
  }
  const kept = perBuild("thishost.recorded", () => new Map<string, { stamp: string; found: Recorded }>());
  const stamp = fileStamp(file) ?? ""; // none: read below, which says why
  const last = kept.get(file);
  if (stamp && last?.stamp === stamp) return last.found;
  const found = read(file);
  if (stamp) kept.set(file, { stamp, found });
  return found;
}

function read(file: string): Recorded {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { why: (e as NodeJS.ErrnoException).code === "ENOENT" ? `${file} is missing` : `${file} can't be read` };
  }
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text);
  } catch {
    return { why: `${file} isn't JSON` };
  }
  const fingerprints = strings(value?.fingerprints);
  const addresses = strings(value?.addresses);
  if (!fingerprints || !addresses) return { why: `${file} isn't a record of this machine` };
  return { host: { fingerprints, addresses } };
}

/** Whether the host is recorded (a file that is a record, even an empty one). */
export const thisHostRecorded = (): boolean => "host" in recorded();

/** The fingerprints of the host's own SSH host keys, as recorded; none when it isn't. */
export function thisHostFingerprints(): Set<string> {
  const r = recorded();
  return new Set("host" in r ? r.host.fingerprints : []);
}

/** The host's own addresses, as recorded; none when it isn't. */
export function thisHostAddresses(): string[] {
  const r = recorded();
  return "host" in r ? [...r.host.addresses] : [];
}

/** Whether the record is good enough to trust a target is another machine: it is there, it can be
 *  read, it is a record, and it holds a host key. Otherwise kit.ssh refuses every target, and the
 *  reason says what to do on the host. */
export function thisHostUsable(): { ok: true } | { ok: false; reason: string } {
  const r = recorded();
  if ("why" in r) return { ok: false, reason: `this machine isn't recorded, so no target can be told from it (${r.why}): run the installer on the host, as in the README` };
  if (!r.host.fingerprints.length) return { ok: false, reason: "the record of this machine holds no SSH host key, so no target can be told from it: run the installer on the host (it needs /etc/ssh/ssh_host_*_key.pub)" };
  return { ok: true };
}

/** Why a machine showing the host key `fingerprint` is this machine, or null. */
export function thisHostKeyRefusal(fingerprint: string): string | null {
  return thisHostFingerprints().has(fingerprint.trim())
    ? `${fingerprint} is this machine's own SSH host key: signing in there would read what AnythingLLM keeps beside it, the vault's key and the pages' secrets`
    : null;
}

const ALWAYS = new net.BlockList();
for (const [address, bits] of [
  ["0.0.0.0", 8], // unspecified, and "this network": connects to this machine
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local
] as const) {
  ALWAYS.addSubnet(address, bits, "ipv4");
}
for (const [address, bits] of [["::", 128], ["::1", 128], ["fe80::", 10]] as const) ALWAYS.addSubnet(address, bits, "ipv6");

/** An address without its IPv6 zone ("fe80::1%eth0"). */
export const bare = (ip: string): string => ip.split("%", 1)[0];

/** Whether `ip` is this machine wherever it is said: a loopback, link-local or unspecified address
 *  (an IPv4 one mapped into IPv6 too), which on any machine means that machine itself. */
export function alwaysOwn(ip: string): boolean {
  const a = bare(ip);
  const kind = net.isIP(a);
  return kind !== 0 && ALWAYS.check(a, kind === 6 ? "ipv6" : "ipv4");
}

/** The 16 bytes of an IPv6 address (dotted IPv4 tail allowed), or null when it isn't one. */
function bytes6(ip: string): number[] | null {
  if (net.isIP(ip) !== 6) return null;
  let text = ip.toLowerCase();
  const tail = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (tail) text = text.slice(0, tail.index) + ((Number(tail[1]) << 8) | Number(tail[2])).toString(16) + ":" + ((Number(tail[3]) << 8) | Number(tail[4])).toString(16);
  const [head, rest, ...more] = text.split("::");
  if (more.length) return null;
  const groups = (s: string) => (s ? s.split(":") : []);
  const a = groups(head);
  const b = rest === undefined ? [] : groups(rest);
  const fill = rest === undefined ? 0 : 8 - a.length - b.length;
  if (fill < 0 || (rest === undefined && a.length !== 8)) return null;
  return [...a, ...Array(fill).fill("0"), ...b].flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
}

const dotted = (b: number[]): string => b.join(".");

/** The IPv4 addresses an address stands for: itself when it is one, and the one inside an IPv6
 *  address that carries one (mapped ::ffff:a.b.c.d, compatible ::a.b.c.d, NAT64 64:ff9b::a.b.c.d,
 *  6to4 2002:AABB:CCDD::), since each connects to that IPv4 address through a gateway or a stack. */
function embedded(ip: string): string[] {
  if (net.isIP(ip) === 4) return [ip];
  const b = bytes6(ip);
  if (!b) return [];
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  const found: string[] = [];
  if (zeros(0, 10) && b[10] === 255 && b[11] === 255) found.push(dotted(b.slice(12))); // mapped
  if (zeros(0, 12) && b.slice(12).some((x) => x)) found.push(dotted(b.slice(12))); // compatible
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) found.push(dotted(b.slice(12))); // NAT64 64:ff9b::/96
  if (b[0] === 0x20 && b[1] === 0x02) found.push(dotted(b.slice(2, 6))); // 6to4 2002::/16
  return found;
}

/** How long the interfaces this process sees are taken as they were. */
const INTERFACES_MS = 5000;

/** The addresses that are this machine's by being on one of its interfaces as this process sees
 *  them, or recorded by the installer from the host: made again when the record changes, or the
 *  interfaces were looked at more than INTERFACES_MS ago. */
function ownAddresses(): net.BlockList {
  const kept = perBuild("thishost.own", () => ({ at: 0, record: null as Recorded | null, list: null as net.BlockList | null }));
  const r = recorded();
  if (kept.list && kept.record === r && Date.now() - kept.at < INTERFACES_MS) return kept.list;
  const mine = new net.BlockList();
  const add = (address: string) => {
    const a = bare(address);
    const k = net.isIP(a);
    if (k) mine.addAddress(a, k === 6 ? "ipv6" : "ipv4");
  };
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) add(a.address);
  if ("host" in r) for (const a of r.host.addresses) add(a);
  Object.assign(kept, { at: Date.now(), record: r, list: mine });
  return mine;
}

/** Whether `ip` is this machine's own. An IPv4 address carried inside an IPv6 one is checked as IPv4. */
export function isThisHost(ip: string): boolean {
  const address = bare(ip);
  const kind = net.isIP(address);
  if (!kind) return false;
  const except = (globalThis as unknown as Record<symbol, Set<string> | undefined>)[THISHOST_EXCEPT];
  if (except?.has(address)) return false;
  const mine = ownAddresses();
  const own = (a: string): boolean => alwaysOwn(a) || mine.check(a, net.isIP(a) === 6 ? "ipv6" : "ipv4");
  return own(address) || embedded(address).some((v4) => !except?.has(v4) && own(v4));
}

/** Why `ip` is this machine's own, or null. */
export const thisHostRefusal = (ip: string): string | null =>
  isThisHost(ip) ? `${ip} is an address of this machine itself, which a target can't be: signing in here would read what AnythingLLM keeps beside it, the vault's key and the pages' secrets` : null;

/** The ports the suite's own services listen on at this machine's addresses: AnythingLLM's, a
 *  proxy's https, and the bridge's. */
export const OWN_PORTS = [3001, 443, 8467];

/** A host as it is compared: a name in lower case without a trailing dot; an address in one form
 *  (IPv4-mapped IPv6 as IPv4, IPv6 compressed, no zone, lower case). */
export function canonicalHost(host: string): string {
  const h = bare(String(host).trim()).replace(/^\[|\]$/g, "").toLowerCase();
  const kind = net.isIP(h);
  if (!kind) return h.replace(/\.$/, "");
  if (kind === 4) return h;
  const mapped = embedded(h)[0];
  const b = bytes6(h);
  if (mapped && b && b.slice(0, 10).every((x) => x === 0) && b[10] === 255 && b[11] === 255) return mapped;
  return new URL(`http://[${h}]/`).hostname.slice(1, -1);
}
