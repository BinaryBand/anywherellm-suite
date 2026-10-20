// Asking the user to let a host through the fence, from a chat in AnywhereLLM (the phone app) while
// it streams the answer. The skill writes the ask in the fence's folder (fence-lean/asks/<id>.json)
// and names it in a line shown in the chat; AnywhereLLM reads the line, shows the ask as its bridge
// reads it from the same folder, and the bridge writes the user's decision there: once (for the
// rest of this agent run), always (the bridge also adds the host to allowed.json) or deny. The
// skill waits for it, at most ASK_MS, and an ask nobody answered is denied. Only a chat through
// AnythingLLM's developer API, in AnythingLLM's own process, asks: a scheduled job's or Telegram's
// run (a process AnythingLLM forks) and a chat in AnythingLLM's web UI (which AnywhereLLM doesn't
// see) are refused as before.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type Invoked, perProcess, storageDir, workspaceOf } from "./anythingllm.mts";
import { readJson, updateJson } from "./atomic.mts";
import { FENCED, FENCE_DIR, NetError } from "./fence.mts";

/** How long an ask waits for the user. */
export const ASK_MS = 120 * 1000;
const POLL_MS = 1000;

export type Decision = "once" | "always" | "deny";

/** An ask as it's kept, which the bridge reads and answers. */
export interface Ask {
  id: string;
  host: string;
  origin: string;
  /** The skill that asks, by its name ("Library"). */
  skill: string;
  workspace: string;
  /** What the skill would do there, in its own words, never the model's. */
  why: string;
  asked: string;
  expires: string;
  decision: Decision | null;
  decided: string | null;
}

/** `this` in a handler, as far as asking uses it. */
export interface Asking extends Invoked {
  introspect?: (message: string) => void;
}

/** The asks' folder in AnythingLLM's storage. */
export const asksDir = (storage = storageDir()): string => path.join(storage, FENCE_DIR, "asks");

/** Whether `self` is a chat AnywhereLLM can be asking in: one through the developer API (a
 *  workspace, and none of a web UI invocation's uuid and thread), in AnythingLLM's own process
 *  (`child` is a forked job's or Telegram's), with a line to say it in. */
export function foreground(self: Asking | undefined, child = typeof process.send === "function"): boolean {
  const invocation = self?.super?.handlerProps?.invocation;
  return !child && !!workspaceOf(self) && !invocation?.uuid && (invocation?.thread_id ?? null) === null && typeof self?.introspect === "function";
}

/** The hosts the user let through once in this agent run (self.super, one object per run). */
export function grantsOf(self: Invoked | undefined): Set<string> {
  const runs = perProcess("fence.grants", () => new WeakMap<object, Set<string>>());
  const run = self?.super;
  if (!run || typeof run !== "object") return new Set();
  let hosts = runs.get(run);
  if (!hosts) runs.set(run, (hosts = new Set()));
  return hosts;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Asks the user, in AnywhereLLM, to let `host` through for `origin`, and waits for their answer:
 *  "once" or "always" (the host is then let through for the rest of this run), "deny", or
 *  "expired" when nobody answered in time. Only for a `foreground` chat. */
export async function askToReach(self: Asking, what: { skill: string; host: string; origin: string; why: string }, { waitMs = ASK_MS, pollMs = POLL_MS } = {}): Promise<Decision | "expired"> {
  const dir = asksDir();
  sweep(dir);
  const id = crypto.randomBytes(16).toString("hex");
  const file = path.join(dir, `${id}.json`);
  const asked = new Date();
  const ask: Ask = { id, ...what, host: what.host.toLowerCase(), workspace: workspaceOf(self) ?? "", asked: asked.toISOString(), expires: new Date(asked.getTime() + waitMs).toISOString(), decision: null, decided: null };
  await updateJson(file, () => ask, () => {});
  self.introspect?.(`Waiting for your approval in AnywhereLLM to reach ${ask.host} [ask:${id}]`);
  try {
    for (const end = asked.getTime() + waitMs; Date.now() < end; ) {
      await sleep(pollMs);
      let now: Ask | null;
      try {
        now = readJson<Ask | null>(file, () => null);
      } catch {
        continue; // being written: read again
      }
      if (!now) return "deny"; // taken away: nobody may say yes to it now
      if (now.decision === "once" || now.decision === "always") {
        grantsOf(self).add(ask.host);
        return now.decision;
      }
      if (now.decision === "deny") return "deny";
    }
    return "expired";
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Removes the asks whose time ran out an hour ago or more: a process that ended while it waited
 *  leaves its ask behind. */
function sweep(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const before = Date.now() - 60 * 60 * 1000;
  for (const name of names) {
    if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
    try {
      const { expires } = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Partial<Ask>;
      if (Date.parse(String(expires)) < before) fs.rmSync(path.join(dir, name), { force: true });
    } catch {}
  }
}

/** Asks the user to let the host the fence refused through, as `skill`, for what `why` says the skill
 *  would do there; resolves once they did, else throws what to tell the agent. */
export async function letThrough(self: Asking, skill: string, refused: { host: string; origin: string }, why: string): Promise<void> {
  const outcome = await askToReach(self, { skill, host: refused.host, origin: refused.origin, why });
  if (outcome === "deny") throw new NetError(`${refused.origin} isn't reached: the user declined it in AnywhereLLM. ${FENCED}`);
  if (outcome === "expired") throw new NetError(`${refused.origin} isn't reached: the user didn't answer in AnywhereLLM in time. ${FENCED}`);
}
