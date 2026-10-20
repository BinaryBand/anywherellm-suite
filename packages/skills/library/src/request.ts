// One request the library sends, from call or from a function's kit.http: checked (its method,
// headers and body), through policy, with a saved key put where it goes, and through the fence,
// which lets through the hosts the user let through in this run too; a chat in AnywhereLLM asks the
// user for a host the fence refuses, and sends it again once they let it through. Each caller
// decides where it may go before, and how its answer is shown after.

import { bodyOf, headersOf, methodOf, withParams } from "#shared/answer";
import { Fenced, allowedHosts } from "#shared/fence";
import * as net from "#shared/net";
import { check } from "./policy";
import { credentialed } from "./secrets";

/** A request as the agent or a function gave it, besides its address. */
export interface Spec {
  method?: unknown;
  params?: unknown;
  headers?: unknown;
  body?: unknown;
}

/** What a request may reach besides the hosts the user lets through: those let through in this run,
 *  and, in a chat in AnywhereLLM, how to ask the user for one the fence refuses (which throws what to
 *  tell the agent when they don't let it through). */
export interface Reach {
  granted: Iterable<string>;
  ask?: (refused: Fenced) => Promise<void>;
}

export interface Sent {
  method: string;
  answer: net.Answer;
  /** The key's value that went with it, to hide wherever the answer shows; null for none. */
  secret: string | null;
}

/** Sends `spec` to `target` (its params added to it), with the key `key` names; `fn` is the
 *  function it's from, or null for the agent's own call. */
export async function send(target: URL, spec: Spec, key: { label: string; as: string } | null, fn: string | null, signal?: AbortSignal, reach: Reach = { granted: [] }): Promise<Sent> {
  const method = methodOf(spec.method);
  withParams(target, spec.params);
  const headers = headersOf(spec.headers);
  const body = bodyOf(method, spec.body, headers);
  check({ op: "http", fn, method, url: target.href, key: key?.label ?? null });
  const cred = key ? await credentialed(key.label, key.as, target.href, headers) : null;
  // The fence refuses before anything is sent, so the request goes again as it was.
  const sending = () => net.send({ method, url: cred?.url ?? target.href, headers: cred?.headers ?? headers, body, signal, allow: [...allowedHosts(), ...reach.granted], ...(cred ? { next: cred.next } : {}) });
  let answer: net.Answer;
  try {
    answer = await sending();
  } catch (e) {
    if (!(e instanceof Fenced) || !reach.ask) throw e;
    await reach.ask(e);
    answer = await sending();
  }
  return { method, answer, secret: cred?.value ?? null };
}
