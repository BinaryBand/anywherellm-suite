// Requests a skill sends itself, from AnythingLLM's own Node, through the fence (fence.mts). The
// fence holds for each request: the name is looked up once, every address it gives is checked,
// and the connection goes to an address that was checked, so a name can't resolve one way for the
// check and another for the connection. Only http and https, no proxy, a time limit and a size
// limit. A redirect is followed only for a GET or a HEAD, at most MAX_REDIRECTS times, each hop
// fenced again; the caller decides what goes on to the next address (a saved key goes no further
// than its own site). Connections are kept a few seconds for the next request to the same host (a
// function paging through an API), each opened through the fenced lookup. Ported from the lean
// browser skill's net.js; the kept connections and `signal` are new: a run that runs out of time
// stops the request it's waiting on. `connect` opens a fenced TCP connection the same way, for a
// protocol other than HTTP (the library's SSH).

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net, { type LookupFunction } from "node:net";
import zlib from "node:zlib";
import { FENCED, NetError, addressesRefused, allowedFor, allowedHosts, bareHost, hostRefused, httpUrl, letThrough, noteRefused, pathRefused } from "./fence.mts";

/** A server that didn't answer, or whose answer couldn't be read: worth trying again later. */
export class Unreachable extends NetError {
  override name = "Unreachable";
}

const TIMEOUT_MS = 30 * 1000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
/** How long an idle connection is kept for the next request: shorter than servers keep theirs. */
const IDLE_MS = 4 * 1000;
const USER_AGENT = "anywherellm-suite (an AnythingLLM agent skill)";

/** Why an address is refused whatever the host is let through for, or null. */
export type Refuse = (address: string) => string | null;

type Resolve = (hostname: string, options: dns.LookupAllOptions, callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => void;

/** A lookup for http.request that refuses a name resolving to an address that isn't public and
 *  answers only addresses it checked; the hosts in `allowed` are let through. */
function fencedLookup(allowed: ReadonlySet<string>, resolve: Resolve = dns.lookup, refuse?: Refuse): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { all: true, verbatim: true }, (err, found) => {
      if (err) return callback(err, "", 0);
      // `refuse` holds even for a host let through: it is asked of every address the connection could go to.
      const why = found.map((a) => refuse?.(a.address)).find(Boolean) || (allowed.has(hostname.toLowerCase()) ? null : addressesRefused(hostname, found.map((a) => a.address)));
      if (why) return callback(Object.assign(new Error(why), { code: "EFENCED" }), "", 0);
      const usable = options?.family ? found.filter((a) => a.family === options.family) : found;
      if (!usable.length) return callback(Object.assign(new Error(`${hostname} has no address`), { code: "ENOTFOUND" }), "", 0);
      // Node's own callback takes the list when it asked for all.
      if (options?.all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, usable);
      return callback(null, usable[0].address, usable[0].family);
    });
  };
}

/** The decoder for a Content-Encoding, or null for none. */
function decoderFor(encoding: unknown) {
  const e = String(encoding ?? "").trim().toLowerCase();
  if (e === "gzip" || e === "x-gzip") return zlib.createGunzip();
  if (e === "deflate") return zlib.createInflate();
  if (e === "br") return zlib.createBrotliDecompress();
  return null;
}

export interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  url: string;
  /** Whether the body was longer than what was kept. */
  cut: boolean;
}

export type Headers = Record<string, string>;

type Once = Required<Pick<Send, "method" | "url" | "headers" | "timeout" | "maxBytes">> & Pick<Send, "body" | "allow" | "resolve" | "signal">;

type Agents = { http: http.Agent; https: https.Agent };
const AGENTS = Symbol.for("anywherellm-suite.net.agents");
/** How many allow-lists keep their connections: the public web's (FENCE_ALLOW alone), and one for
 *  each host an origin the user let through is on, so they don't pile up. */
const MAX_POOLS = 8;

/** The connections kept for the hosts `allowed` lets through: one pool per allow-list, so a
 *  connection opened under a looser one is never reused under a stricter one. Kept on globalThis,
 *  since AnythingLLM loads a skill's handler.js afresh for each agent run; the pool used longest ago
 *  is let go of past MAX_POOLS, not destroyed (a request may still be using it): its idle
 *  connections close after IDLE_MS. */
function agentsFor(allowed: ReadonlySet<string>): Agents {
  const g = globalThis as unknown as Record<symbol, Map<string, Agents>>;
  const pools = (g[AGENTS] ||= new Map());
  const key = [...allowed].sort().join(",");
  let agents = pools.get(key);
  if (agents) pools.delete(key); // used now: last to go
  else {
    const options = { keepAlive: true, timeout: IDLE_MS, lookup: fencedLookup(allowed) };
    agents = { http: new http.Agent(options), https: new https.Agent(options) };
    while (pools.size >= MAX_POOLS) pools.delete(pools.keys().next().value!);
  }
  pools.set(key, agents);
  return agents;
}

/** The errors a timer and a stop end a connection with. */
const timedOut = (ms: number) => Object.assign(new Error(`no answer in ${Math.round(ms / 1000)} s`), { code: "ETIMEDOUT" });
const stopped = () => Object.assign(new Error("the run stopped"), { code: "EABORTED" });

/** The fence's refusal of a request for `origin`, noted for the Vault page to offer (noteRefused). */
function refused(origin: string, why: string): NetError {
  noteRefused(origin);
  return new NetError(`${origin} isn't reached: ${why}. ${letThrough(origin)}`);
}

/** One request and its answer, with no redirect followed: the hosts allowedFor lets through for its
 *  origin are (or `allow`'s, which tests fix). */
function once({ method, url, headers, body, timeout, maxBytes, allow, resolve, signal }: Once): Promise<Answer> {
  const parsed = httpUrl(url);
  const never = pathRefused(parsed);
  if (never) throw new NetError(`${parsed.origin}${parsed.pathname} isn't reached: ${never}`);
  const host = bareHost(parsed).toLowerCase();
  const allowed = allow ? new Set(allow) : allowedFor(parsed.origin);
  const why = hostRefused(host, allowed);
  if (why && why !== "lookup") throw refused(parsed.origin, why);
  if (signal?.aborted) throw new NetError(`${parsed.origin} wasn't asked: the run stopped`);
  const https_ = parsed.protocol === "https:";
  // A stand-in lookup (the tests') gets connections of its own; the real one, the kept ones.
  const agent = resolve ? { agent: false as const, lookup: fencedLookup(allowed, resolve) } : { agent: agentsFor(allowed)[https_ ? "https" : "http"] };
  const sent: Headers = { "user-agent": USER_AGENT, "accept-encoding": "gzip, deflate, br" };
  for (const [k, v] of Object.entries(headers || {})) sent[k.toLowerCase()] = v;
  if (body !== undefined) sent["content-length"] = String(Buffer.byteLength(body));
  return new Promise((resolveAnswer, reject) => {
    let settled = false;
    const finish = <T,>(fn: (v: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const req = (https_ ? https : http).request(parsed, { method, headers: sent, ...agent }, (res) => {
      const decoder = method === "HEAD" ? null : decoderFor(res.headers["content-encoding"]);
      const stream = decoder ? res.pipe(decoder) : res;
      const chunks: Buffer[] = [];
      let size = 0;
      const done = (cut: boolean) => finish(resolveAnswer, { status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), url: parsed.href, cut });
      stream.on("data", (chunk: Buffer) => {
        if (settled) return;
        const room = maxBytes - size;
        if (chunk.length <= room) {
          chunks.push(chunk);
          size += chunk.length;
          return;
        }
        chunks.push(chunk.subarray(0, room));
        size = maxBytes;
        done(true);
        req.destroy();
      });
      stream.on("end", () => done(false));
      stream.on("error", (e: Error) => finish(reject, new Unreachable(`${parsed.origin}'s answer couldn't be read: ${e.message}`)));
    });
    const timer = setTimeout(() => req.destroy(timedOut(timeout)), timeout);
    const onAbort = () => req.destroy(stopped());
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EFENCED") return finish(reject, refused(parsed.origin, e.message));
      return finish(reject, new Unreachable(`${parsed.origin} didn't answer: ${e.message}`));
    });
    req.end(body);
  });
}

export interface Send {
  method?: string;
  url: string;
  headers?: Headers;
  body?: string | Buffer;
  timeout?: number;
  maxBytes?: number;
  /** The hosts let through, whatever the origin: for tests. By default, allowedFor's for each hop. */
  allow?: Iterable<string>;
  resolve?: Resolve;
  signal?: AbortSignal;
  /** The headers to send to a redirect's address, or null not to follow it. */
  next?: (url: string) => Headers | null;
}

export interface Connect {
  host: string;
  port: number;
  /** The hosts let through although they aren't public (FENCE_ALLOW's by default). */
  allow?: string[];
  timeout?: number;
  resolve?: Resolve;
  signal?: AbortSignal;
  /** Why an address the connection could go to is refused, even for a host in `allow`: asked of a
   *  literal address and of every address the name resolves to, at connect time. */
  refuse?: Refuse;
}

/** A TCP connection to `host`:`port` for a protocol of its own (the library's SSH), through the
 *  fence as a request is: the name looked up once, every address it gives checked, the connection
 *  made to a checked one. */
export function connect({ host, port, allow = allowedHosts(), timeout = TIMEOUT_MS, resolve, signal, refuse }: Connect): Promise<net.Socket> {
  const allowed = new Set(allow);
  const where = `${host}:${port}`;
  const why = (net.isIP(host) ? refuse?.(host) : null) || hostRefused(host, allowed);
  if (why && why !== "lookup") return Promise.reject(new NetError(`${where} isn't reached: ${why}. ${FENCED}`));
  if (signal?.aborted) return Promise.reject(new NetError(`${where} wasn't asked: the run stopped`));
  return new Promise((resolveSocket, reject) => {
    const sock = net.connect({ host, port, lookup: fencedLookup(allowed, resolve, refuse) });
    const done = (e?: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      sock.off("error", done);
      if (!e) return resolveSocket(sock);
      sock.destroy();
      reject(e.code === "EFENCED" ? new NetError(`${where} isn't reached: ${e.message}. ${FENCED}`) : new Unreachable(`${where} didn't answer: ${e.message}`));
    };
    const timer = setTimeout(() => done(timedOut(timeout)), timeout);
    const onAbort = () => done(stopped());
    signal?.addEventListener("abort", onAbort, { once: true });
    sock.once("connect", () => done());
    sock.once("error", done);
  });
}

/** Sends a request; answers its status, headers and at most `maxBytes` of its body (cut when there
 *  was more). A redirect of a GET or a HEAD is followed with the headers `next(url)` answers for
 *  it, or not at all when it answers null. */
export async function send({ method = "GET", url, headers = {}, body, timeout = TIMEOUT_MS, maxBytes = MAX_BYTES, allow, resolve, signal, next = () => headers }: Send): Promise<Answer> {
  let target = url;
  let sent = headers;
  for (let hops = 0; ; hops++) {
    const answer = await once({ method, url: target, headers: sent, body, timeout, maxBytes, allow, resolve, signal });
    const location = answer.headers.location;
    if (!(answer.status >= 300 && answer.status < 400 && location) || !["GET", "HEAD"].includes(method) || hops >= MAX_REDIRECTS) return answer;
    const to = new URL(location, target).href;
    const hop = next(to);
    if (!hop) return answer;
    target = to;
    sent = hop;
  }
}
