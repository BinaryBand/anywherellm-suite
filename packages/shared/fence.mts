// What the skills may reach: the public web only. They run inside AnythingLLM, whose machine
// reaches its LAN and its tailnet, so a request is refused when its host is, or resolves to, an
// address that isn't public, unless it's one of the hosts named in FENCE_ALLOW (comma-separated),
// which the user lets through. The requests a skill sends itself (net.mts) are checked at the
// lookup their connection uses, so a name can't resolve one way for the check and another for the
// connection. makeFence is for what can only be checked before (the browser's page requests):
// there a name could resolve differently in between.
// Ported from the lean browser skill's fence.js.

import dns from "node:dns";
import net from "node:net";
import { Told } from "./errors.mts";

/** A request refused or failed, said as it is: a fenced address, a bad header, an unreachable server. */
export class NetError extends Told {}

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
 *  through (FENCE_ALLOW). */
export const secureFor = (url: URL): boolean => url.protocol === "https:" || (url.protocol === "http:" && allowedHosts().includes(bareHost(url).toLowerCase()));

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

/** The hosts FENCE_ALLOW lets through, in lower case. */
export const allowedHosts = (env: NodeJS.ProcessEnv = process.env): string[] =>
  (env.FENCE_ALLOW ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

/** Why `host` (a name or an address, without brackets) is refused by itself, or null; "lookup"
 *  when only its addresses can say. The hosts in `allowed` are let through. */
export function hostRefused(host: string, allowed: Set<string>): string | null {
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

/** A fence: `refused(url)` answers why a request to `url` is refused, or null. Lookups are kept for
 *  DNS_TTL_MS; the hosts in `allow` are let through. */
export function makeFence({
  lookup = (host) => dns.promises.lookup(host, { all: true, verbatim: true }),
  now = Date.now,
  allow = allowedHosts(),
}: { lookup?: Lookup; now?: () => number; allow?: string[] } = {}) {
  const allowed = new Set(allow);
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
    const why = hostRefused(host, allowed);
    if (why !== "lookup") return why;
    let found: string[];
    try {
      found = await addresses(host);
    } catch {
      return null; // the request's own lookup fails the same way and says so
    }
    return addressesRefused(host, found);
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
