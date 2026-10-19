// AnythingLLM, from here: its internal API (`<ANYTHINGLLM_URL>/api`), the one its own pages use,
// for what the developer API (/api/v1) doesn't have.
//
// It logs in as the pages do: `POST /api/request-token` with the password, which is AUTH_TOKEN in
// the environment of a process AnythingLLM starts itself (the control server). It is read afresh
// at each login so a changed password needs no restart. The token is kept and the login made again
// after a 401. With no password set, AnythingLLM asks for none, and none is sent. Multi-user mode
// isn't supported. No error text holds a token.

import { upstream as upstreamError } from "./errors.mts";

/** AnythingLLM's port when SERVER_PORT doesn't say another (contract/versions.env INNER_PORT). */
export const ANYTHINGLLM_PORT = 3001;
const DEFAULT_TIMEOUT = 30_000; // how long a call to AnythingLLM may take, in ms

interface Reply {
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

/** The reason an answer gives, its `error` or `message`, or null. */
export const said = (found: unknown): string | null => {
  const f = found as { error?: unknown; message?: unknown } | null;
  const reason = f && typeof f === "object" ? f.error || f.message : null;
  return reason && reason !== true ? String(reason) : null;
};

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
    if ((e as Error).name === "TimeoutError") throw upstreamError(`AnythingLLM didn't answer within ${Math.round(timeout / 1000)} s`);
    throw upstreamError(`AnythingLLM can't be reached: ${((e as Error).cause as Error | undefined)?.message ?? (e as Error).message}`);
  }
  try {
    return { status: res.status, json: text.trim() ? JSON.parse(text) : null };
  } catch {
    return { status: res.status, json: null };
  }
}

/** Where the password comes from: `read` gives it (empty for none), `where` names it in errors. */
export interface Password {
  read: () => string;
  where: string;
}

export class Upstream {
  readonly #base: string;
  readonly #password: Password | null;
  #token: Promise<string> | null = null;

  /** `password` is null for none. */
  constructor(baseUrl: string, password: Password | null) {
    this.#base = baseUrl.replace(/\/+$/, "");
    this.#password = password;
  }

  async #login(): Promise<string> {
    const password = this.#password?.read() ?? "";
    if (!password) return "";
    const { status, json } = await request(`${this.#base}/api/request-token`, { method: "POST", body: { password } });
    const token = (json as { token?: unknown } | null)?.token;
    if (status !== 200 || !token) {
      throw upstreamError(`AnythingLLM refused the login with ${this.#password?.where}: ${said(json) ?? status}`);
    }
    return String(token);
  }

  /** The token, logging in first when there is none, or when `stale` (the one a call just had refused)
   *  is still the one kept. Calls made at once share one login. */
  #tokenFor(stale?: Promise<string>): Promise<string> {
    if (!this.#token || this.#token === stale) {
      const login = this.#login();
      this.#token = login;
      login.catch(() => {
        if (this.#token === login) this.#token = null; // a failed login is tried again
      });
    }
    return this.#token;
  }

  /** The status and JSON of AnythingLLM's own answer, whatever its status. `path` is under /api. */
  async exchange(method: string, path: string, body?: unknown, timeout = DEFAULT_TIMEOUT): Promise<Reply> {
    const url = `${this.#base}/api${path}`;
    const first = this.#tokenFor();
    const token = await first;
    const reply = await request(url, { method, body, token, timeout });
    if (reply.status !== 401 || !token) return reply; // with no password, a 401 is the route's own
    const again = await request(url, { method, body, token: await this.#tokenFor(first), timeout });
    if (again.status === 401) throw upstreamError(`AnythingLLM refused the login (${this.#password?.where ?? "no password"})`);
    return again;
  }
}
