// AnythingLLM's internal API as the tools call it: a JSON answer, or a ControlError whose message
// reaches the agent. A 404 is a missing thing; any other error keeps the reason AnythingLLM gave.
// Every error reaches the agent as its message, so there is one error type.
//
// Also what a tool reads an answer with, which never throws (an answer of another shape reads as
// empty), and the checks on what a tool puts into a path.

import { said } from "./upstream.mts";

export class ControlError extends Error {}

/** One call to AnythingLLM: its status and JSON (null for an empty or plain-text body). */
export type Exchange = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: unknown }>;

export type Obj = Record<string, unknown>;

const SAID_MAX = 300;
const SLUG = /^[A-Za-z0-9_-]{1,100}$/;

/** `value` when it is an object, else an empty one. */
export const obj = (value: unknown): Obj => (value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {});

/** `value` when it is a list, else an empty one. */
export const items = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** `value` when it is a string, else an empty one. */
export const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** `value` when it is a workspace's or a chat's slug: one path segment of letters, digits, `-` and `_`. */
export function slug(value: string, what: string): string {
  if (!SLUG.test(value)) throw new ControlError(`${what} must be a slug of letters, digits, - and _ (up to 100); got ${JSON.stringify(value.slice(0, 40))}`);
  return value;
}

/** `value` trimmed, when it is 1 to `maximum` characters. */
export function bounded(value: string, what: string, maximum: number): string {
  const found = value.trim();
  if (found.length < 1 || found.length > maximum) throw new ControlError(`${what} is 1 to ${maximum} characters`);
  return found;
}

/** What an error answer means to the agent. */
function refusal(status: number, json: unknown): string {
  const reason = (said(json) ?? text(json)).slice(0, SAID_MAX);
  if (status === 404) return reason || "AnythingLLM has no such workspace, chat or job";
  return `${status}: ${reason || "no reason given"}`;
}

export class Anything {
  readonly #exchange: Exchange;

  constructor(exchange: Exchange) {
    this.#exchange = exchange;
  }

  /** AnythingLLM's JSON for `method` on `path` (under its /api), with an optional JSON `body`. */
  async call(method: string, path: string, body?: unknown): Promise<unknown> {
    let reply;
    try {
      reply = await this.#exchange(method, path, body);
    } catch (e) {
      throw new ControlError((e as Error).message); // can't be reached, didn't answer, refused the login
    }
    if (reply.status >= 400) throw new ControlError(refusal(reply.status, reply.json));
    return reply.json;
  }
}
