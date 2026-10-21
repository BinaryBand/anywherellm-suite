// What the skills may reach: the public web only. They run inside AnythingLLM, whose machine
// reaches its LAN and its tailnet, so a request is refused when its host is, or resolves to, an
// address that isn't public, unless it's one of the hosts named in FENCE_ALLOW (comma-separated, any
// port), or the request is for an origin the user let through on the Vault page (allowed.json:
// that scheme, host and port only; addresses.mts writes it). The requests a skill sends
// itself (net.mts) are checked at the lookup their connection uses, so a name can't resolve one way
// for the check and another for the connection. makeFence is for what can only be checked before
// (the browser's page requests): there a name could resolve differently in between.
// Ported from the lean browser skill's fence.js.

import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { perBuild, storageDir } from "./anythingllm.mts";
import { readJson, writeAtomic } from "./atomic.mts";
import { Told } from "./errors.mts";

/** A request refused or failed, said as it is: a fenced address, a bad header, an unreachable server. */
export class NetError extends Told {}

/** What the agent is told whenever the fence refuses an address. */
export const FENCED = "Don't reach it another way, with another tool or another address for the same place.";

/** What the agent is told after the fence refused a request for `origin`: where the user lets it
 *  through (addresses.mts), and that nothing else may reach it. */
export const letThrough = (origin: string): string => `The user can let ${origin} through on the Vault page, under Allowed addresses, and then ask again. ${FENCED}`;

/** The folders of AnythingLLM's public folder the skills' pages live in (#shared/pages writes only
 *  there): the Vault, the Library page, the browser's tab pages, the apps. */
export const PAGE_FOLDERS = ["vault-lean", "library-lean", "browser-lean", "apps-lean"];

/** The paths the agent never reaches, on any host and whatever the user lets through: the skills'
 *  pages, which act for whoever holds their link, and AnythingLLM's upload the pages post with. The
 *  user acts on them; the agent, which is given their links, mustn't (a toolkit the user locked
 *  would be unlocked by it). As AnythingLLM matches a path: any case, decoded, a run of slashes as one. */
const NEVER = new RegExp(`^/(?:api/browser-extension|${PAGE_FOLDERS.join("|")})(?:/|$)`);

/** Why the agent never reaches `url`'s path, or null. */
export function pathRefused(url: URL): string | null {
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // a malformed escape is matched as it is
  }
  if (!NEVER.test(pathname.toLowerCase().replace(/\/{2,}/g, "/"))) return null;
  return `that's one of the skills' own pages or AnythingLLM's upload for them, which the agent never reaches: the user acts on them, not you. ${FENCED}`;
}

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

/** Whether a secret may go to `url` by its scheme: https, or plain http to what the user lets
 *  through (FENCE_ALLOW's hosts, allowed.json's origins). */
export const secureFor = (url: URL): boolean => url.protocol === "https:" || (url.protocol === "http:" && allows(url.origin));

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

/** The fence's folder in AnythingLLM's storage: the origins the user let through, and the ones it
 *  refused lately. The suite's alone. */
export const FENCE_DIR = "fence-lean";

/** The origins the user let through: { origins: [{ origin, added }] }, written from the Vault
 *  page (addresses.mts). */
export const allowedFile = (storage: string): string => path.join(storage, FENCE_DIR, "allowed.json");

/** The origins the fence refused lately, newest first, for the Vault page to offer:
 *  { refused: [{ origin, at }] }, at most MAX_REFUSED, none older than REFUSED_MS. */
export const refusedFile = (storage: string): string => path.join(storage, FENCE_DIR, "refused.json");
const MAX_REFUSED = 10;
const REFUSED_MS = 24 * 60 * 60 * 1000;

type Refusal = { origin: string; at: string };

/** The origins in refused.json, newest first, the old ones left out; none when it can't be read. */
export function recentlyRefused(now = Date.now()): Refusal[] {
  try {
    const kept = readJson<{ refused?: Refusal[] }>(refusedFile(storageDir()), () => ({})).refused;
    if (!Array.isArray(kept)) return [];
    return kept.filter((r) => r && originOf(r.origin) === r.origin && now - Date.parse(r.at) < REFUSED_MS).slice(0, MAX_REFUSED);
  } catch {
    return [];
  }
}

/** Notes that the fence refused a request for `origin`, at the top of refused.json. Never throws: a
 *  refusal is told whether or not it could be noted. Not under a lock: two refusals at once may keep
 *  one, which is all the list is for. */
export function noteRefused(origin: string, now = Date.now()): void {
  try {
    const refused = [{ origin, at: new Date(now).toISOString() }, ...recentlyRefused(now).filter((r) => r.origin !== origin)].slice(0, MAX_REFUSED);
    writeAtomic(refusedFile(storageDir()), JSON.stringify({ refused }, null, 2) + "\n", 0o600);
  } catch {}
}

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

type Listed = { origins: string[]; hosts: string[] };
const NOTHING: Listed = { origins: [], hosts: [] };

/** allowed.json as it is now; read again when the file changes (by its stamp, as the vault's: it is
 *  replaced whole). Nothing when there's no file, or one that can't be read: the fence stays
 *  shut. */
function listed(): Listed {
  const kept = perBuild("fence.allowed", () => ({ last: null as ({ stamp: string } & Listed) | null }));
  let file: string;
  let stamp: string;
  try {
    file = allowedFile(storageDir());
    const s = fs.statSync(file);
    stamp = `${file}\0${s.ino}:${s.mtimeMs}:${s.size}`;
  } catch {
    return NOTHING;
  }
  if (kept.last?.stamp === stamp) return kept.last;
  let origins: string[] = [];
  try {
    const entries = readJson<{ origins?: { origin?: unknown }[] }>(file, () => ({})).origins;
    origins = Array.isArray(entries) ? entries.map((o) => originOf(o?.origin)).filter((o): o is string => o !== null) : [];
  } catch {}
  kept.last = { stamp, origins, hosts: [...new Set(origins.map((o) => bareHost(new URL(o))))] };
  return kept.last;
}

/** The origins the user let through on the Vault page. */
export const alwaysAllowed = (): string[] => listed().origins;

/** Their hosts: where a secret may be kept for (a single-label name like muse-vm isn't otherwise). */
export const alwaysAllowedHosts = (): string[] => listed().hosts;

/** The hosts the user lets through, on any port, in lower case: FENCE_ALLOW's. */
export const allowedHosts = (env: NodeJS.ProcessEnv = process.env): string[] => [
  ...new Set(
    (env.FENCE_ALLOW ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  ),
];

/** Whether the user lets `origin` through: a FENCE_ALLOW host on any port, or that very origin
 *  (allowed.json). A host let through for one origin isn't for its other ports or scheme. */
export function allows(origin: string): boolean {
  return allowedHosts().includes(bareHost(new URL(origin))) || alwaysAllowed().includes(origin);
}

/** The hosts let through now for a request to `origin`, as the host checks below take them:
 *  FENCE_ALLOW's, and `origin`'s own host when allows says so. */
export function allowedFor(origin: string): Set<string> {
  const hosts = new Set(allowedHosts());
  if (allows(origin)) hosts.add(bareHost(new URL(origin)));
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
  allow = allowedFor,
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
    const never = pathRefused(parsed);
    if (never) return never;
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
