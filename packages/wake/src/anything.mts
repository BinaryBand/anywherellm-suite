// AnythingLLM, from the wake: its internal API (`/api`), the one its own pages use, since the
// developer API (/api/v1) has no scheduled jobs. It logs in as the pages do, `POST
// /api/request-token` with the password (AUTH_TOKEN in AnythingLLM's .env, read afresh at each
// login), keeps the token and logs in again after a 401. No password set: none is sent. Only
// single-user mode, where the job routes are. No error text holds the password or a token.

import { Told } from "#shared/errors";
import { request } from "#shared/upstream";
import { readEnv } from "./settings.mts";

/** A job's run, as `GET /api/scheduled-jobs/<id>/runs` lists it (the newest 50, newest first). */
interface Run {
  id: number;
  status: string;
}

/** A run that hasn't ended. */
const ACTIVE = new Set(["queued", "running"]);

const reason = (json: unknown): string => {
  const j = json as { error?: unknown; message?: unknown } | null;
  return j && typeof j === "object" && (j.error || j.message) ? `: ${String(j.error || j.message)}` : "";
};

export class Anything {
  readonly #base: string;
  readonly #envFile: string | null;
  #token: string | null = null;

  constructor(base: string, envFile: string | null) {
    this.#base = base.replace(/\/+$/, "");
    this.#envFile = envFile;
  }

  async #login(): Promise<string> {
    const password = this.#envFile ? readEnv(this.#envFile).AUTH_TOKEN || "" : "";
    if (!password) return "";
    const { status, json } = await request(`${this.#base}/api/request-token`, { method: "POST", body: { password } });
    const token = (json as { token?: unknown } | null)?.token;
    if (status !== 200 || !token) throw new Told(`AnythingLLM refused the login with the password in ${this.#envFile}${reason(json) || ` (${status})`}`);
    return String(token);
  }

  /** One call under /api, logged in; a 2xx reply's JSON, else a Told with AnythingLLM's reason. */
  async call(method: string, path: string): Promise<unknown> {
    for (let tries = 0; ; tries++) {
      this.#token ??= await this.#login();
      const { status, json } = await request(`${this.#base}/api${path}`, { method, token: this.#token });
      if (status === 401 && tries === 0) {
        this.#token = null;
        continue;
      }
      if (status >= 300) throw new Told(`AnythingLLM answered ${method} /api${path} with ${status}${reason(json)}`);
      return json;
    }
  }

  /** The job's name; a Told when there's no such job. */
  async jobName(id: number): Promise<string> {
    const { job } = ((await this.call("GET", `/scheduled-jobs/${id}`)) ?? {}) as { job?: { name?: string } | null };
    if (!job) throw new Told(`AnythingLLM has no scheduled job ${id}`);
    return String(job.name ?? "");
  }

  /** Whether one of the job's runs is queued or running. */
  async busy(id: number): Promise<boolean> {
    const { runs } = ((await this.call("GET", `/scheduled-jobs/${id}/runs`)) ?? {}) as { runs?: Run[] };
    return (runs ?? []).some((r) => ACTIVE.has(r.status));
  }

  /** Runs the job now, as its Run now button does. */
  async trigger(id: number): Promise<void> {
    const reply = ((await this.call("POST", `/scheduled-jobs/${id}/trigger`)) ?? {}) as { success?: boolean; error?: unknown };
    if (reply.success === false) throw new Told(`AnythingLLM didn't run job ${id}${reason(reply)}`);
  }
}
