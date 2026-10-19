// AnythingLLM's internal API (`<ANYTHINGLLM_URL>/api`), the one its own pages use, for what the
// developer API (/api/v1) doesn't have.
//
// It logs in as the pages do: `POST /api/request-token` with the password, which is AUTH_TOKEN in
// the environment AnythingLLM starts the control server with. The token is kept and the login made
// again after a 401. With no password set, AnythingLLM asks for none, and none is sent. Multi-user
// mode isn't supported. No error text holds a token.

import { Told } from "#shared/errors";
import { DEFAULT_TIMEOUT, request, type Reply } from "#shared/upstream";

/** The reason an answer gives, its `error` or `message`, or null. */
export const said = (found: unknown): string | null => {
  const f = found as { error?: unknown; message?: unknown } | null;
  const reason = f && typeof f === "object" ? f.error || f.message : null;
  return reason && reason !== true ? String(reason) : null;
};

export class Upstream {
  readonly #base: string;
  readonly #password: string;
  readonly #where: string;
  #token: Promise<string> | null = null;

  /** `password` is empty for none; `where` names it in errors. */
  constructor(baseUrl: string, password: string, where: string) {
    this.#base = baseUrl.replace(/\/+$/, "");
    this.#password = password;
    this.#where = where;
  }

  async #login(): Promise<string> {
    if (!this.#password) return "";
    const { status, json } = await request(`${this.#base}/api/request-token`, { method: "POST", body: { password: this.#password } });
    const token = (json as { token?: unknown } | null)?.token;
    if (status !== 200 || !token) throw new Told(`AnythingLLM refused the login with ${this.#where}: ${said(json) ?? status}`);
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
    if (again.status === 401) throw new Told(`AnythingLLM refused the login (${this.#where})`);
    return again;
  }
}
