// One request the library sends, from call or from a function's kit.http: checked (its method,
// headers and body), through policy, with a saved key put where it goes, and through the fence.
// Each caller decides where it may go before, and how its answer is shown after.

import { bodyOf, headersOf, methodOf, withParams } from "#shared/answer";
import * as net from "#shared/net";
import { LibraryError } from "./errors";
import { check } from "./policy";
import { credentialed } from "./secrets";
import { keyBar, type Toolkit } from "./store";

/** A request as the agent or a function gave it, besides its address. */
export interface Spec {
  method?: unknown;
  params?: unknown;
  headers?: unknown;
  body?: unknown;
}

export interface Sent {
  method: string;
  answer: net.Answer;
  /** The key's value that went with it, to hide wherever the answer shows; null for none. */
  secret: string | null;
}

/** Who sends a request: a function, with its toolkit, or null for the agent's own call. */
export type From = { kit: Toolkit; fn: string } | null;

/** Sends `spec` to `target` (its params added to it), with the key `key` names, from `from`. */
export async function send(target: URL, spec: Spec, key: { label: string; as: string } | null, from: From, signal?: AbortSignal): Promise<Sent> {
  const method = methodOf(spec.method);
  withParams(target, spec.params);
  const headers = headersOf(spec.headers);
  const body = bodyOf(method, spec.body, headers);
  const bar = key && keyBar(key.label, from?.kit);
  if (bar) throw new LibraryError(`the key "${key.label}" can't be used ${from ? `by the ${from.kit.service} toolkit` : "in call"}: ${bar}; run the locked toolkit's function instead, or ask the user to unlock it`);
  check({ op: "http", fn: from?.fn ?? null, method, url: target.href, key: key?.label ?? null });
  const cred = key ? await credentialed(key.label, key.as, target.href, headers) : null;
  const answer = await net.send({ method, url: cred?.url ?? target.href, headers: cred?.headers ?? headers, body, signal, ...(cred ? { next: cred.next } : {}) });
  return { method, answer, secret: cred?.value ?? null };
}
