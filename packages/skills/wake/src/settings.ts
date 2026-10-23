// The wake's settings, the skill's own (Settings > Agent Skills > Wake), as AnythingLLM keeps them:
// in its plugin.json, each `setup_args.<NAME>.value`. The listener reads them there, since it starts
// when AnythingLLM loads handler.js, before any call brings them as runtimeArgs.

import fs from "node:fs";

/** How long a burst of messages is let finish before the job runs (ms). */
export const BURST_MS = 30_000;
/** The least time between two runs of a job the wake starts (ms): a leaked write token can't run
 *  it more often. */
export const GAP_MS = 120_000;

export interface Rule {
  topic: string;
  job: number;
}

export interface Settings {
  ntfyUrl: string;
  ntfyToken: string;
  rules: Rule[];
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

/** The settings in the skill's plugin.json `file`, as AnythingLLM reads them (a value, else the
 *  default). */
export function settingsIn(file: string): Settings {
  const args = (JSON.parse(fs.readFileSync(file, "utf8")) as { setup_args?: Record<string, { value?: unknown; default?: unknown }> }).setup_args ?? {};
  const get = (name: string) => String(args[name]?.value || args[name]?.default || "").trim();
  return { ntfyUrl: get("NTFY_URL").replace(/\/+$/, ""), ntfyToken: get("NTFY_TOKEN"), rules: rulesOf(get("WAKE")) };
}

/** What the listener can't start without, said; none when it can. */
export function missing(s: Settings): string[] {
  const out: string[] = [];
  if (!/^https?:\/\/[^/]+/.test(s.ntfyUrl)) out.push("NTFY_URL, the ntfy server (https://host[:port])");
  if (!s.ntfyToken) out.push("NTFY_TOKEN, a token that may read the topics");
  if (!s.rules.length) out.push("WAKE, topic=job pairs (anythingllm=26)");
  return out;
}
