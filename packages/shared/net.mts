// Requests a skill sends itself, from AnythingLLM's own Node, through the fence (fence.mts). The
// fence holds for each request: the name is looked up once, every address it gives is checked,
// and the connection goes to an address that was checked, so a name can't resolve one way for the
// check and another for the connection. Only http and https, no proxy, a time limit and a size
// limit. A redirect is followed only for a GET or a HEAD, at most MAX_REDIRECTS times, each hop
// fenced again; the caller decides what goes on to the next address (a saved key goes no further
// than its own site). Connections are kept a few seconds for the next request to the same host (a
// function paging through an API), each opened through the fenced lookup. Ported from the lean
// browser skill's net.js; the kept connections and `signal` are new: a run that runs out of time
// stops the request it's waiting on.

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import zlib from "node:zlib";
import { FENCED, Fenced, NetError, addressesRefused, allowedNow, bareHost, hostRefused, httpUrl } from "./fence.mts";

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

type Resolve = (hostname: string, options: dns.LookupAllOptions, callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => void;

/** A lookup for http.request that refuses a name resolving to an address that isn't public and
 *  answers only addresses it checked; the hosts in `allowed` are let through. */
function fencedLookup(allowed: ReadonlySet<string>, resolve: Resolve = dns.lookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { all: true, verbatim: true }, (err, found) => {
      if (err) return callback(err, "", 0);
      const why = allowed.has(hostname.toLowerCase()) ? null : addressesRefused(hostname, found.map((a) => a.address));
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

type Once = Required<Pick<Send, "method" | "url" | "headers" | "timeout" | "maxBytes">> & Pick<Send, "body" | "resolve" | "signal"> & { allowed: ReadonlySet<string> };

type Agents = { http: http.Agent; https: https.Agent };
const AGENTS = Symbol.for("anywherellm-suite.net.agents");
/** How many allow-lists keep their connections: one per run the user let a host through in, so they
 *  don't pile up. */
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

/** One request and its answer, with no redirect followed. */
function once({ method, url, headers, body, timeout, maxBytes, allowed, resolve, signal }: Once): Promise<Answer> {
  const parsed = httpUrl(url);
  const host = bareHost(parsed).toLowerCase();
  const why = hostRefused(host, allowed);
  if (why && why !== "lookup") throw new Fenced(`${parsed.origin} isn't reached: ${why}. ${FENCED}`, host, parsed.origin);
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
    const timer = setTimeout(() => req.destroy(Object.assign(new Error(`no answer in ${Math.round(timeout / 1000)} s`), { code: "ETIMEDOUT" })), timeout);
    const onAbort = () => req.destroy(Object.assign(new Error("the run stopped"), { code: "EABORTED" }));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EFENCED") return finish(reject, new Fenced(`${parsed.origin} isn't reached: ${e.message}. ${FENCED}`, host, parsed.origin));
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
  /** The hosts let through: by default, those let through now (allowedNow). */
  allow?: Iterable<string>;
  resolve?: Resolve;
  signal?: AbortSignal;
  /** The headers to send to a redirect's address, or null not to follow it. */
  next?: (url: string) => Headers | null;
}

/** Sends a request; answers its status, headers and at most `maxBytes` of its body (cut when there
 *  was more). A redirect of a GET or a HEAD is followed with the headers `next(url)` answers for
 *  it, or not at all when it answers null. */
export async function send({ method = "GET", url, headers = {}, body, timeout = TIMEOUT_MS, maxBytes = MAX_BYTES, allow = allowedNow(), resolve, signal, next = () => headers }: Send): Promise<Answer> {
  const allowed = new Set(allow);
  let target = url;
  let sent = headers;
  for (let hops = 0; ; hops++) {
    const answer = await once({ method, url: target, headers: sent, body, timeout, maxBytes, allowed, resolve, signal });
    const location = answer.headers.location;
    if (!(answer.status >= 300 && answer.status < 400 && location) || !["GET", "HEAD"].includes(method) || hops >= MAX_REDIRECTS) return answer;
    const to = new URL(location, target).href;
    const hop = next(to);
    if (!hop) return answer;
    target = to;
    sent = hop;
  }
}
