// The wake's settings, read from its environment, which the settings file `wake.env` fills (the
// service's EnvironmentFile; every command reads it too):
//
// | Setting             | Default                                    | What it is                          |
// |---------------------|--------------------------------------------|-------------------------------------|
// | NTFY_URL            | (none)                                     | the ntfy server, https://host[:port] |
// | NTFY_TOKEN          | (none)                                     | a token that may read the topics    |
// | WAKE                | (none)                                     | topic=job pairs, comma-separated    |
// | BURST_MS            | 30000                                      | how long a burst of messages is let finish |
// | GAP_MS              | 120000                                     | the least time between two runs a job is woken for |
// | ANYTHINGLLM_STORAGE | (none)                                     | AnythingLLM's storage: its .env holds the password |
// | ANYTHINGLLM_URL     | http://127.0.0.1:3001                      | AnythingLLM                         |
// | WAKE_STATE          | $XDG_STATE_HOME/anywherellm-wake/state.json | the last message seen on each topic |

import fs from "node:fs";
import path from "node:path";
import { anythingllmUrl } from "#shared/upstream";

export interface Rule {
  topic: string;
  job: number;
}

export interface Settings {
  ntfyUrl: string;
  ntfyToken: string;
  rules: Rule[];
  burstMs: number;
  gapMs: number;
  /** AnythingLLM's .env, which holds its password; null without a storage. */
  envFile: string | null;
  anythingllmUrl: string;
  stateFile: string;
}

export interface Place {
  env: Record<string, string | undefined>;
  home: string;
}

const xdg = (name: "XDG_CONFIG_HOME" | "XDG_STATE_HOME", fallback: string, { env, home }: Place): string => env[name] || path.join(home, fallback);

/** The settings file: WAKE_ENV_FILE, else $XDG_CONFIG_HOME/anywherellm-wake/wake.env. */
export const settingsFile = (place: Place): string => place.env.WAKE_ENV_FILE || path.join(xdg("XDG_CONFIG_HOME", ".config", place), "anywherellm-wake", "wake.env");

/** The KEY=value settings in an env file, quotes dropped; a missing file reads as empty. */
export function readEnv(file: string): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const found: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const cut = line.indexOf("=");
    const key = line.slice(0, cut).trim();
    if (cut >= 0 && key && !key.startsWith("#")) found[key] = line.slice(cut + 1).trim().replace(/^['"]+|['"]+$/g, "");
  }
  return found;
}

/** WAKE's pairs: `anythingllm=26,alerts=31`. A topic is ntfy's ([A-Za-z0-9_-], 1 to 64). */
export function rulesOf(text: string): Rule[] {
  return text
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [topic, job, more] = pair.split("=").map((s) => s.trim());
      if (more !== undefined || !/^[\w-]{1,64}$/.test(topic ?? "") || !/^[1-9]\d*$/.test(job ?? "")) throw new Error(`WAKE: "${pair}" isn't topic=job (a topic name, then a job's number)`);
      return { topic, job: Number(job) };
    });
}

const ms = (value: string | undefined, fallback: number, name: string): number => {
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} is a number of milliseconds, not "${value}"`);
  return Number(value);
};

/** The settings from the file and the environment, the environment first. */
export function loadSettings(place: Place): Settings {
  const env = { ...readEnv(settingsFile(place)), ...place.env };
  const storage = env.ANYTHINGLLM_STORAGE || "";
  return {
    ntfyUrl: (env.NTFY_URL || "").replace(/\/+$/, ""),
    ntfyToken: env.NTFY_TOKEN || "",
    rules: rulesOf(env.WAKE || ""),
    burstMs: ms(env.BURST_MS, 30_000, "BURST_MS"),
    gapMs: ms(env.GAP_MS, 120_000, "GAP_MS"),
    envFile: storage ? path.join(storage, ".env") : null,
    anythingllmUrl: anythingllmUrl(env),
    stateFile: env.WAKE_STATE || path.join(xdg("XDG_STATE_HOME", ".local/state", place), "anywherellm-wake", "state.json"),
  };
}

/** What `serve` can't start without, said; none when it can. */
export function missing(s: Settings): string[] {
  const out: string[] = [];
  if (!/^https?:\/\/[^/]+/.test(s.ntfyUrl)) out.push("NTFY_URL, the ntfy server (https://host[:port])");
  if (!s.ntfyToken) out.push("NTFY_TOKEN, a token that may read the topics");
  if (!s.rules.length) out.push("WAKE, topic=job pairs (anythingllm=26)");
  return out;
}

/** The settings file `install` writes when there is none: the user fills it in. */
export const TEMPLATE = (storage: string): string => `# anywherellm-wake's settings: the service's environment. When a message arrives on a topic, the
# wake waits BURST_MS for more, then runs that topic's AnythingLLM scheduled job (at most one
# run at a time, and runs at least GAP_MS apart). Message text never leaves ntfy through it: the
# job reads its topic itself.
NTFY_URL=
NTFY_TOKEN=
# topic=job pairs, comma-separated: the job's number is in Settings > Scheduled jobs (its address).
WAKE=
ANYTHINGLLM_STORAGE=${storage}
# BURST_MS=30000
# GAP_MS=120000
# ANYTHINGLLM_URL=http://127.0.0.1:3001
`;
