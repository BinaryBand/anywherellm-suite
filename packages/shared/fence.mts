// What the skills may reach: the public web only. They run inside AnythingLLM, whose machine
// reaches its LAN and its tailnet, so a request is refused when its host is, or resolves to, an
// address that isn't public, unless it's one of the hosts named in FENCE_ALLOW (comma-separated, any
// port), or the request is for an origin the user let through for good from AnywhereLLM
// (allowed.json, which its bridge writes: that scheme, host and port only); a chat in AnywhereLLM
// can also ask the user to let an origin through (ask.mts). The requests a skill sends
// itself (net.mts) are checked at the lookup their connection uses, so a name can't resolve one way
// for the check and another for the connection. makeFence is for what can only be checked before
// (the browser's page requests): there a name could resolve differently in between.
// Ported from the lean browser skill's fence.js.

import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { perProcess, storageDir } from "./anythingllm.mts";
import { readJson } from "./atomic.mts";
import { Told } from "./errors.mts";

/** A request refused or failed, said as it is: a fenced address, a bad header, an unreachable server. */
export class NetError extends Told {}

/** A request the fence refused before anything was sent: `host` (as the allow-lists name it) and the
 *  `origin` it was for, so a chat can ask the user to let it through and send it again. */
export class Fenced extends NetError {
  override name = "Fenced";
  readonly host: string;
  readonly origin: string;
  constructor(message: string, host: string, origin: string) {
    super(message);
    this.host = host;
    this.origin = origin;
  }
}

/** What the agent is told whenever the fence refuses an address. */
export const FENCED = "That's final: don't reach it another way, with another tool or another address for the same place.";

/** Schemes a page may load besides http(s), which the fence checks by host. */
const LOCAL_SCHEMES = new Set(["data:", "blob:", "about:"]);
const DNS_TTL_MS = 60 * 1000;

// What isn't the public internet, by address. An IPv4 address mapped into IPv6 (::ffff:a.b.c.d)
// is checked against the IPv4 ranges by BlockList itself.
const PRIVATE = new net.BlockList();
for (const [address, bits] of [
  ["0.0.0.0", 8], // this network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT, and Tailscale's addresses
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, and cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and broadcast
] as const) {
  PRIVATE.addSubnet(address, bits, "ipv4");
}
for (const [address, bits] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) PRIVATE.addSubnet(address, bits, "ipv6"); // :: and ::1, unique-local, link-local, multicast

/** Whether `ip` (an IPv4 or IPv6 address, an IPv6 zone allowed) is outside the public internet. */
export function privateAddress(ip: string): boolean {
  const bare = ip.split("%", 1)[0];
  const kind = net.isIP(bare);
  return kind ? PRIVATE.check(bare, kind === 6 ? "ipv6" : "ipv4") : true;
}

/** Whether a host name, by its name alone, is one of this machine's or this network's. */
export function privateName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (!name.includes(".")) return true; // a single label: a container, a LAN machine
  return /(^|\.)(localhost|local|internal|lan|home\.arpa|ts\.net)$/.test(name);
}

/** A URL's host as the fence checks it: an IPv6 address without its brackets. */
export const bareHost = (url: URL): string => url.hostname.replace(/^\[|\]$/g, "");

/** Whether a secret may go to `url` by its scheme: https, or plain http to a host the user lets
 *  through (FENCE_ALLOW) or an origin they let through for good (allowed.json). */
export const secureFor = (url: URL): boolean =>
  url.protocol === "https:" || (url.protocol === "http:" && (allowedHosts().includes(bareHost(url).toLowerCase()) || alwaysAllowed().includes(url.origin)));

/** `url` parsed, when it's an http(s) address; a NetError saying why not otherwise. */
export function httpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NetError(`"${url.slice(0, 100)}" isn't an address`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new NetError("only http and https addresses are reached");
  return parsed;
}

/** The address to reach: http(s) only, with https:// put before a bare host. */
export function checkUrl(raw: unknown): string {
  const url = String(raw ?? "").trim();
  if (!url) throw new NetError("an address is needed");
  return httpUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).href;
}

/** The fence's folder in AnythingLLM's storage: the asks waiting for the user (ask.mts) and the
 *  origins they let through for good. AnywhereLLM's bridge reads and writes it too. */
export const FENCE_DIR = "fence-lean";

/** The origins the user let through for good: { origins: [{ origin, added }] }, written by the bridge. */
export const allowedFile = (storage: string): string => path.join(storage, FENCE_DIR, "allowed.json");

/** `raw` as an origin (an http or https address's scheme, host and port, as URL.origin writes it), or
 *  null when it isn't one. */
export function originOf(raw: unknown): string | null {
  try {
    const url = new URL(String(raw ?? ""));
    return ["http:", "https:"].includes(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

/** The origins the user let through for good from AnywhereLLM; read again when the file changes (by
 *  its stamp, as the vault's: the bridge replaces it). None when there's no file, or one that can't
 *  be read: the fence stays shut. */
export function alwaysAllowed(): string[] {
  const kept = perProcess("fence.allowed", () => ({ last: null as { stamp: string; origins: string[] } | null }));
  let file: string;
  let stamp: string;
  try {
    file = allowedFile(storageDir());
    const s = fs.statSync(file);
    stamp = `${file}\0${s.ino}:${s.mtimeMs}:${s.size}`;
  } catch {
    return [];
  }
  if (kept.last?.stamp === stamp) return kept.last.origins;
  let origins: string[] = [];
  try {
    const listed = readJson<{ origins?: { origin?: unknown }[] }>(file, () => ({})).origins;
    origins = Array.isArray(listed) ? listed.map((o) => originOf(o?.origin)).filter((o): o is string => o !== null) : [];
  } catch {}
  kept.last = { stamp, origins };
  return origins;
}

/** The hosts the user lets through, on any port, in lower case: FENCE_ALLOW's. */
export const allowedHosts = (env: NodeJS.ProcessEnv = process.env): string[] => [
  ...new Set(
    (env.FENCE_ALLOW ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  ),
];

/** The agent run a skill's call is part of: the origins the user let through once in it, and, in a
 *  chat in AnywhereLLM, how to ask them for an origin the fence refuses (ask.mts). Each skill's
 *  handler sets it for the whole call; what the call starts keeps it (a library function's run,
 *  without asking). */
export interface Run {
  grants: ReadonlySet<string>;
  ask?: (refused: Fenced) => Promise<void>;
}

const runs = () => perProcess("fence.run", () => new AsyncLocalStorage<Run>());

/** Runs `fn` as part of `run`. */
export const inRun = <T,>(run: Run, fn: () => T): T => runs().run(run, fn);

/** Runs `fn` as part of no run: for what lives on after the call that starts it (a browser), which
 *  would otherwise keep that run, and its agent, as long as it lives. */
export const outsideRun = <T,>(fn: () => T): T => runs().exit(fn);

/** The run the code running now is part of, if any. */
export const currentRun = (): Run | undefined => runs().getStore();

/** The hosts let through now for a request to `origin`: FENCE_ALLOW's, and `origin`'s own host when
 *  the user let that origin through for good, or once (`once`, by default the current run's). A host
 *  let through for one origin isn't for its other ports or scheme. */
export function allowedFor(origin: string, once: Iterable<string> = currentRun()?.grants ?? []): Set<string> {
  const hosts = new Set(allowedHosts());
  if (alwaysAllowed().includes(origin) || [...once].includes(origin)) hosts.add(bareHost(new URL(origin)).toLowerCase());
  return hosts;
}

/** Why `host` (a name or an address, without brackets) is refused by itself, or null; "lookup"
 *  when only its addresses can say. The hosts in `allowed` are let through. */
export function hostRefused(host: string, allowed: ReadonlySet<string>): string | null {
  if (allowed.has(host.toLowerCase())) return null;
  if (net.isIP(host)) return privateAddress(host) ? `${host} isn't a public address` : null;
  if (privateName(host)) return `${host} is a name on this machine or its network`;
  return "lookup";
}

/** Why `host`, which resolves to `addresses`, is refused, or null. */
export function addressesRefused(host: string, addresses: string[]): string | null {
  const inside = addresses.find(privateAddress);
  return inside ? `${host} resolves to ${inside}, which isn't a public address` : null;
}

type Lookup = (host: string) => Promise<{ address: string }[]>;

const NONE: ReadonlySet<string> = new Set();

/** A fence: `refused(url)` answers why a request to `url` is refused, or null. Lookups are kept for
 *  DNS_TTL_MS; the hosts `allow(origin)` answers for the request's origin are let through, asked only
 *  for a host refused by itself, so a public one costs nothing more (by default, allowedFor). */
export function makeFence({
  lookup = (host) => dns.promises.lookup(host, { all: true, verbatim: true }),
  now = Date.now,
  allow = (origin) => allowedFor(origin),
}: { lookup?: Lookup; now?: () => number; allow?: (origin: string) => ReadonlySet<string> } = {}) {
  const known = new Map<string, { addresses: Promise<string[]>; until: number }>();
  function addresses(host: string): Promise<string[]> {
    const kept = known.get(host);
    if (kept && kept.until > now()) return kept.addresses;
    const pending = lookup(host).then((found) => found.map((a) => a.address));
    const entry = { addresses: pending, until: now() + DNS_TTL_MS };
    known.set(host, entry);
    pending.catch(() => known.get(host) === entry && known.delete(host));
    return pending;
  }
  async function byAddress(host: string): Promise<string | null> {
    try {
      return addressesRefused(host, await addresses(host));
    } catch {
      return null; // the request's own lookup fails the same way and says so
    }
  }
  return async function refused(url: string): Promise<string | null> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return "not an address";
    }
    if (LOCAL_SCHEMES.has(parsed.protocol)) return null;
    if (!["http:", "https:"].includes(parsed.protocol)) return `${parsed.protocol} addresses aren't loaded`;
    const host = bareHost(parsed);
    const why = hostRefused(host, NONE);
    const refusal = why === "lookup" ? await byAddress(host) : why;
    return refusal && !allow(parsed.origin).has(host.toLowerCase()) ? refusal : null;
  };
}

/** The host of `url`, or "" when it has none. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** A site as a person writes it ("https://GitHub.com/login"), as a host: "github.com". */
export const siteOf = (site: unknown): string =>
  String(site ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "");

/** Whether `host` is `site` or one of its subdomains. */
export function onSite(host: string, site: unknown): boolean {
  const want = siteOf(site);
  return Boolean(host && want) && (host === want || host.endsWith(`.${want}`));
}
