// AnythingLLM, from here: one JSON call to it, and where it is. The installer asks it about the pages' key.

import { Told } from "./errors.mts";

/** AnythingLLM's port when SERVER_PORT doesn't say another (tools/versions.env INNER_PORT). */
const ANYTHINGLLM_PORT = 3001;
export const DEFAULT_TIMEOUT = 30_000; // how long a call to AnythingLLM may take, in ms

export interface Reply {
  status: number;
  /** null when the body is empty or isn't JSON. */
  json: unknown;
}

interface Options {
  method?: string;
  body?: unknown;
  token?: string;
  timeout?: number;
}

/** AnythingLLM's address: ANYTHINGLLM_URL, else this machine at its own SERVER_PORT, else 3001. */
export const anythingllmUrl = (env: Record<string, string | undefined>): string =>
  (env.ANYTHINGLLM_URL || `http://127.0.0.1:${env.SERVER_PORT || ANYTHINGLLM_PORT}`).replace(/\/+$/, "");

/** One JSON call: its status and its JSON. */
export async function request(url: string, { method = "GET", body, token = "", timeout = DEFAULT_TIMEOUT }: Options = {}): Promise<Reply> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    text = await res.text();
  } catch (e) {
    if ((e as Error).name === "TimeoutError") throw new Told(`AnythingLLM didn't answer within ${Math.round(timeout / 1000)} s`);
    throw new Told(`AnythingLLM can't be reached: ${((e as Error).cause as Error | undefined)?.message ?? (e as Error).message}`);
  }
  try {
    return { status: res.status, json: text.trim() ? JSON.parse(text) : null };
  } catch {
    return { status: res.status, json: null };
  }
}
