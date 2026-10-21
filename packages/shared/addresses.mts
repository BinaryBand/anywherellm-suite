// The Vault's Allowed addresses section (#shared/vault-page): the origins on this machine or its
// network the user lets the skills reach (allowed.json, which the fence reads), and the ones the
// fence refused lately (refused.json, fence.mts noteRefused), each with an Allow button, and a field
// to type one. Every skill that shows the Vault writes and applies it (pages.take claims each event
// once), so it works with the browser alone or the library alone.
//
// An origin is let through only when it's on this machine or its network: a public one needs
// nothing, and plain http to it would carry a key (fence.mts secureFor). Never a loopback address, on
// any port: inside AnythingLLM's container that is the container itself (its server, its collector),
// and on Desktop the machine has a name on its network. Never one of the suite's own services
// either: AnythingLLM's address (ANYTHINGLLM_URL), or this machine's own addresses
// (#shared/thishost: its interfaces', and those the installer recorded) on OWN_PORTS or AnythingLLM's
// port. What can't be told (a name that can't be looked up; neither the record nor AnythingLLM's
// address) is refused, and the page says why.

import dns from "node:dns";
import net from "node:net";
import { perProcess, storageDir } from "./anythingllm.mts";
import { readJson, updateJson } from "./atomic.mts";
import { Told } from "./errors.mts";
import { allowedFile, bareHost, originOf, privateAddress, privateName, recentlyRefused } from "./fence.mts";
import { OWN_PORTS, canonicalHost, isThisHost, thisHostRecorded } from "./thishost.mts";
import * as vaultPage from "./vault-page.mts";

type Allowed = { origins?: { origin?: unknown; added?: unknown }[] };

/** Every address `host` has, or null when it can't be looked up. */
export type Lookup = (host: string) => Promise<string[] | null>;
const lookupAll: Lookup = (host) =>
  net.isIP(host)
    ? Promise.resolve([host])
    : dns.promises.lookup(host, { all: true, verbatim: true }).then(
        (found) => (found.length ? found.map((a) => a.address) : null),
        () => null,
      );

/** AnythingLLM's address as a skill's call last gave it (its ANYTHINGLLM_URL setting), for the
 *  events applied between calls; null until one did. Kept for the calls of this process. */
const known = () => perProcess("addresses.base", () => ({ base: null as string | null }));

/** Why the last event the section posted was refused, for the page to say once (by `n`). */
const told = () => perProcess("addresses.told", () => ({ result: null as { n: number; error: string } | null }));

const portOf = (url: URL): number => Number(url.port) || (url.protocol === "https:" ? 443 : 80);

/** Whether `ip` is a loopback address (127.0.0.0/8, ::1; an IPv4-mapped one as its IPv4). */
const loopback = (ip: string): boolean => {
  const a = canonicalHost(ip);
  return a === "::1" || (net.isIP(a) === 4 && a.startsWith("127."));
};

/** Why `origin` isn't let through, or null: AnythingLLM's address `base` and `lookup` say where its
 *  own services are. */
export async function refusalOf(origin: string, base: string | null, lookup: Lookup = lookupAll): Promise<string | null> {
  const url = new URL(origin);
  const host = bareHost(url);
  const port = portOf(url);
  const addresses = await lookup(host);
  if (!addresses) return `${host} can't be looked up from AnythingLLM, so it can't be told from AnythingLLM's own services: check the name, or give its address`;
  if (!privateName(host) && !addresses.some(privateAddress)) return "it's on the public web, which the skills reach already: only an address on this machine or its network is let through here";
  if (addresses.some(loopback)) return "that's a loopback address, AnythingLLM's own machine or container: give the machine's name or address on your network instead";
  const anythingllm = originOf(base);
  const recorded = thisHostRecorded();
  if (!anythingllm && !recorded) return "this machine isn't recorded and AnythingLLM's address isn't set, so it can't be told from AnythingLLM's own services: run the installer on the host (it records this machine), or set the skill's ANYTHINGLLM_URL";
  let ports = OWN_PORTS;
  let theirs: string[] = [];
  if (anythingllm) {
    const at = new URL(anythingllm);
    if (canonicalHost(bareHost(at)) === canonicalHost(host) && portOf(at) === port) return "that's AnythingLLM itself";
    const found = await lookup(bareHost(at));
    if (!found && !recorded) return `AnythingLLM's own address (${bareHost(at)}) can't be looked up and this machine isn't recorded, so it can't be told from AnythingLLM: run the installer on the host`;
    theirs = (found ?? []).map(canonicalHost);
    ports = [...OWN_PORTS, portOf(at)];
  }
  if (ports.includes(port) && addresses.some((a) => isThisHost(a) || theirs.includes(canonicalHost(a)))) return `that's port ${port} of this machine, where AnythingLLM, its bridge or a proxy before them listen, which the skills never reach`;
  return null;
}

/** `raw` as an origin, or a Told saying how to write one. */
function originChecked(raw: unknown): string {
  const origin = originOf(String(raw ?? "").trim().slice(0, 300));
  if (!origin) throw new Told(`"${String(raw ?? "").slice(0, 100)}" isn't an address: write its scheme, host and port, like http://muse-vm:8463`);
  return origin;
}

/** Lets `raw`'s origin through (allowed.json), unless refusalOf says why not; answers the origin. */
export async function allow(raw: unknown, lookup: Lookup = lookupAll): Promise<string> {
  const origin = originChecked(raw);
  const why = await refusalOf(origin, known().base, lookup);
  if (why) throw new Told(`${origin} isn't let through: ${why}`);
  await updateJson<Allowed, void>(allowedFile(storageDir()), () => ({}), (a) => {
    const origins = Array.isArray(a.origins) ? a.origins : (a.origins = []);
    if (!origins.some((o) => originOf(o?.origin) === origin)) origins.push({ origin, added: new Date().toISOString() });
  });
  return origin;
}

/** Stops letting `raw`'s origin through. */
export async function remove(raw: unknown): Promise<void> {
  const origin = originChecked(raw);
  await updateJson<Allowed, void>(allowedFile(storageDir()), () => ({}), (a) => void (a.origins = (Array.isArray(a.origins) ? a.origins : []).filter((o) => originOf(o?.origin) !== origin)));
}

/** The origins let through, as allowed.json lists them; none when it can't be read. */
function allowedNow(): { origin: string; added: string }[] {
  try {
    const listed = readJson<Allowed>(allowedFile(storageDir()), () => ({})).origins;
    if (!Array.isArray(listed)) return [];
    return listed.flatMap((o) => {
      const origin = originOf(o?.origin);
      return origin ? [{ origin, added: String(o.added ?? "") }] : [];
    });
  } catch {
    return [];
  }
}

/** The section as the page shows it: the origins let through, the ones refused lately and not let
 *  through since, and why the last event was refused. Nothing secret. */
export function state() {
  const origins = allowedNow();
  return { origins, refused: recentlyRefused().filter((r) => !origins.some((o) => o.origin === r.origin)), result: told().result };
}

/** Writes the section again, when there's a Vault. Never throws: it's written after a call, whatever
 *  the call did, and again at the next. What failed is logged by its code alone: a Node file error
 *  names the page's token. */
export function refresh(): void {
  try {
    vaultPage.refresh("addresses", state());
  } catch (e) {
    console.error(`vault-lean couldn't write the Allowed addresses section (${(e as NodeJS.ErrnoException)?.code ?? "error"})`);
  }
}

/** Applies what the user did in the section since the last time (#shared/vault-page take checked its
 *  secret), then writes it again. One that's refused says why on the page. */
async function drain(): Promise<void> {
  const events = vaultPage.take("addresses");
  if (!events.length) return;
  for (const e of events) {
    try {
      if (e.ev === "address-allow") await allow(e.origin);
      else if (e.ev === "address-remove") await remove(e.origin);
      else if (e.ev === "rotate") await vaultPage.rotate();
    } catch (err) {
      const said = err instanceof Told;
      if (!said) console.error(`vault-lean couldn't apply an Allowed addresses event (${String(e.ev).slice(0, 40)}): ${(err as Error)?.message ?? err}`);
      told().result = { n: Date.now(), error: said ? err.message.slice(0, 400) : "couldn't do that (see the log)" };
    }
  }
  refresh();
}

/** Applies what the section posted, for a call, in its turn with its watch's; `base` is AnythingLLM's
 *  address as the call has it (null: not set). */
export function caughtUp(base: string | null): Promise<void> {
  if (base) known().base = base;
  return vaultPage.inTurnFor("addresses", drain);
}

/** Writes the section beside the Vault a skill just showed, and applies its events as they come for a
 *  while, as the skill's own section's are. */
export function show(base: string | null): void {
  if (base) known().base = base;
  refresh();
  vaultPage.watchFor("addresses", drain);
}
