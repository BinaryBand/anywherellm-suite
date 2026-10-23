// Wake: runs an AnythingLLM scheduled job when a message arrives on an ntfy topic. A skill can't be
// called by ntfy, so it listens on its own: AnythingLLM loads handler.js for each agent run, and
// loading it starts one listener for AnythingLLM's process (or, when the code or the settings
// changed, stops the old one and starts another). So it listens from the first agent run after
// AnythingLLM starts; what arrives before then waits on the server and makes one run then. A
// scheduled job's own process (it ends within minutes) never listens.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { jobTimeLeft, perProcess, storageDir } from "#shared/anythingllm";
import { firstLine } from "#shared/errors";
import { anythingllmUrl } from "#shared/upstream";
import { Anything } from "./anything.ts";
import { missing, settingsIn } from "./settings.ts";
import { serve } from "./wake.ts";

const SHOWN = 8; // the listener's latest lines status shows

/** The process's listener. Its shape is kept across versions of the skill, since one install's
 *  listener is stopped by the next one's code. */
interface Listener {
  key: string;
  stop: () => void;
  lines: string[];
}

const held = () => perProcess("wake.listener", () => ({ current: null as Listener | null, problem: "" }));

const stateFile = () => path.join(storageDir(), "wake-lean", "state.json");

/** Starts the listener, or keeps the one going for this code and these settings. */
export function listen(): void {
  if (jobTimeLeft() !== null) return;
  const h = held();
  let settings;
  try {
    settings = settingsIn(path.join(__dirname, "plugin.json"));
  } catch (e) {
    h.current?.stop();
    h.current = null;
    h.problem = firstLine(e);
    return;
  }
  const key = crypto.createHash("sha256").update(fs.readFileSync(__filename)).update(JSON.stringify(settings)).digest("hex");
  if (h.current?.key === key) return;
  h.current?.stop();
  h.current = null;
  const gaps = missing(settings);
  h.problem = gaps.length ? `it isn't set up: missing ${gaps.join("; ")}` : "";
  if (gaps.length) return;
  const stop = new AbortController();
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(`${new Date().toISOString().slice(0, 19)}Z ${line}`);
    if (lines.length > SHOWN) lines.shift();
    console.log(`[wake-lean] ${line}`);
  };
  log(`following ${settings.rules.map((r) => `${r.topic} for job ${r.job}`).join(", ")}`);
  const api = new Anything(anythingllmUrl(process.env), () => process.env.AUTH_TOKEN || "");
  serve(settings, api, log, stop.signal, { stateFile: stateFile() }).catch((e) => log(`stopped: ${firstLine(e)}`));
  h.current = { key, stop: () => stop.abort(), lines };
}

function status(): string {
  if (jobTimeLeft() !== null) return "The wake listens in AnythingLLM's own process, not in a scheduled job's.";
  const { current, problem } = held();
  const where = "Its settings are in Settings > Agent Skills > Wake.";
  if (!current) return `The wake isn't listening: ${problem || "it hasn't started"}. ${where}`;
  return `The wake is listening. Its latest lines (UTC; topics, message ids and jobs only):\n${current.lines.join("\n")}\n\n${where}`;
}

try {
  listen();
} catch (e) {
  held().problem = firstLine(e);
}

export const runtime = {
  handler: async function (this: unknown, args: Record<string, unknown> = {}): Promise<string> {
    const asked = String(args.action ?? "").trim();
    if (asked.toLowerCase() !== "status") return `The wake's action is status, not "${asked}".`;
    return status();
  },
};
