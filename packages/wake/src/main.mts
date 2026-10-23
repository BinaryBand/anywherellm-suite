#!/usr/bin/env node
// anywherellm-wake: runs an AnythingLLM scheduled job when a message arrives on an ntfy topic, in
// place of a job that runs every hour to look. `serve` is the service; `install` writes its
// settings file (once) and its systemd user unit; `health` checks it all.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { firstLine, Told } from "#shared/errors";
import { Anything } from "./anything.mts";
import * as service from "./service.mts";
import { loadSettings, missing, settingsFile, TEMPLATE, type Place, type Settings } from "./settings.mts";
import { serve } from "./wake.mts";

const USAGE = `usage: anywherellm-wake <command>

  install [--storage DIR]   write the settings file (when there is none) and the systemd user
          [--no-start]      unit, then start it once the settings are filled in
  uninstall                 stop and remove the unit (the settings stay)
  health                    check it all; exit 1 when a check fails
  serve                     follow the topics and run their jobs (what the unit runs)
`;

const place: Place = { env: process.env, home: os.homedir() };
const log = (line: string) => console.log(line);

/** Whether the token may read `topic` on the server: a poll of the last minute. */
async function canRead(s: Settings, topic: string): Promise<string | null> {
  try {
    const res = await fetch(`${s.ntfyUrl}/${topic}/json?poll=1&since=1m`, { headers: { Authorization: `Bearer ${s.ntfyToken}` }, signal: AbortSignal.timeout(10_000) });
    await res.body?.cancel();
    return res.ok ? null : `ntfy answered ${res.status}`;
  } catch (e) {
    return `ntfy can't be reached: ${((e as Error).cause as Error | undefined)?.message ?? (e as Error).message}`;
  }
}

async function health(): Promise<boolean> {
  const file = settingsFile(place);
  const found: [string, boolean, string?][] = [];
  const s = loadSettings(place);
  const gaps = missing(s);
  found.push([`the settings (${file})`, !gaps.length, gaps.length ? `missing ${gaps.join("; ")}` : undefined]);
  if (!gaps.length) {
    const api = new Anything(s.anythingllmUrl, s.envFile);
    for (const { topic, job } of s.rules) {
      const read = await canRead(s, topic);
      found.push([`ntfy lets the token read ${topic}`, !read, read ?? undefined]);
      try {
        found.push([`job ${job} for ${topic}`, true, await api.jobName(job)]);
      } catch (e) {
        found.push([`job ${job} for ${topic}`, false, firstLine(e)]);
      }
    }
  }
  const state = service.status(service.run);
  found.push([`the service (${service.UNIT})`, state === "active", state]);
  for (const [what, ok, detail] of found) log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  return found.every(([, ok]) => ok);
}

function install(storage: string | undefined, noStart: boolean): void {
  const file = settingsFile(place);
  if (!fs.existsSync(file)) {
    if (storage && !fs.existsSync(path.join(storage, ".env"))) throw new Told(`${storage} has no .env: is it AnythingLLM's storage?`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, TEMPLATE(storage ? path.resolve(storage) : ""), { mode: 0o600 });
    log(`wrote ${file}`);
  } else if (storage) log(`${file} is kept as it is (ANYTHINGLLM_STORAGE is set there)`);
  const changed = service.define(place, service.run, process.execPath, path.resolve(process.argv[1]), file);
  log(`${changed ? "wrote" : "kept"} ${service.unitFile(place)}`);
  const gaps = missing(loadSettings(place));
  if (gaps.length) {
    log(`\nLeft for you: fill in ${file} (${gaps.join("; ")}), then run install again.`);
    return;
  }
  if (noStart) return log(`not started: systemctl --user enable --now ${service.UNIT}`);
  service.start(service.run);
  log(`started ${service.UNIT}; anywherellm-wake health checks it`);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const options: ParseArgsConfig["options"] = command === "install" ? { storage: { type: "string" }, "no-start": { type: "boolean" } } : {};
  const { values } = parseArgs({ args: rest, options });
  switch (command) {
    case "install":
      install(values.storage as string | undefined, values["no-start"] === true);
      return 0;
    case "uninstall":
      service.remove(place, service.run);
      log(`removed ${service.UNIT}; the settings stay in ${settingsFile(place)}`);
      return 0;
    case "health":
      return (await health()) ? 0 : 1;
    case "serve": {
      const s = loadSettings(place);
      const gaps = missing(s);
      if (gaps.length) throw new Told(`missing ${gaps.join("; ")} in ${settingsFile(place)}`);
      const stop = new AbortController();
      for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => stop.abort());
      log(`following ${s.rules.map((r) => `${r.topic} for job ${r.job}`).join(", ")}`);
      await serve(s, new Anything(s.anythingllmUrl, s.envFile), log, stop.signal);
      return 0;
    }
    default:
      console.error(USAGE);
      return command ? 2 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`anywherellm-wake: ${(e as Error).message}`);
    process.exit(1);
  },
);
