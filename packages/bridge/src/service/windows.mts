// The bridge as a Task Scheduler task of the user's, `anywherellm-bridge`, started at logon. The
// task runs `serve.cmd` in `%LOCALAPPDATA%\anywherellm-bridge`, which sets the settings file and
// appends the bridge's output to `bridge.log` beside it. It runs through `conhost.exe --headless`,
// so no console window stays open on the desktop. A task has no restart after a crash here; the
// next logon starts it again. Not yet run on a real Windows: the commands follow schtasks' help.

import path from "node:path";
import { writeAtomicIfChanged } from "#shared/atomic";
import type { Definition, Host, Manager } from "./index.mts";

export const TASK = "anywherellm-bridge";
/** SCHED_S_TASK_RUNNING (0x41301): the last result of a task that is running, in any display language. */
const RUNNING = "267009";

/** One word for cmd.exe, in double quotes, with `%` doubled so it isn't expanded. */
function quoted(word: string): string {
  if (word.includes('"')) throw new Error(`a path with a double quote can't go into serve.cmd: ${word}`);
  return `"${word.replace(/%/g, "%%")}"`;
}

export function scriptText({ command, envFile }: Definition, log: string): string {
  return [
    "@echo off",
    "rem Written by `anywherellm-suite install --bridge`: the bridge to AnythingLLM's internal API, started at logon.",
    `set ${quoted(`BRIDGE_ENV_FILE=${envFile}`)}`,
    `${command.map(quoted).join(" ")} >> ${quoted(log)} 2>&1`,
    "",
  ].join("\r\n");
}

/** The fields of one CSV line, as schtasks writes them (every field quoted). */
export const csvFields = (line: string): string[] => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));

export function windows(host: Host): Manager {
  const dir = path.join(host.env.LOCALAPPDATA || path.join(host.home, "AppData", "Local"), "anywherellm-bridge");
  const script = path.join(dir, "serve.cmd");
  const log = path.join(dir, "bridge.log");
  const schtasks = (...args: string[]) => host.run("schtasks", args);
  const exists = () => schtasks("/Query", "/TN", TASK).status === 0;
  return {
    kind: "windows",
    label: `task ${TASK}`,
    usable: () => schtasks("/Query", "/FO", "CSV", "/NH").status === 0,
    define(definition) {
      if (!writeAtomicIfChanged(script, scriptText(definition, log)) && exists()) return false;
      const done = schtasks("/Create", "/TN", TASK, "/TR", `conhost.exe --headless cmd.exe /d /c ${quoted(script)}`, "/SC", "ONLOGON", "/F");
      if (done.status !== 0) throw new Error(`schtasks /Create failed: ${done.stdout.trim() || "no reason given"}`);
      return true;
    },
    defined: exists,
    start() {
      schtasks("/Change", "/TN", TASK, "/ENABLE");
      schtasks("/End", "/TN", TASK); // fails when it isn't running, which is fine
      if (schtasks("/Run", "/TN", TASK).status !== 0) throw new Error(`schtasks /Run /TN ${TASK} failed; see ${log}`);
    },
    stop() {
      schtasks("/End", "/TN", TASK);
      return schtasks("/Change", "/TN", TASK, "/DISABLE").status === 0;
    },
    status() {
      const found = schtasks("/Query", "/TN", TASK, "/V", "/FO", "CSV", "/NH");
      const fields = found.status === 0 ? csvFields(found.stdout.trim().split(/\r?\n/)[0] ?? "") : [];
      if (fields.length < 7) return "inactive";
      const [status, lastResult] = [fields[3], fields[6]];
      return status.toLowerCase() === "running" || lastResult === RUNNING ? "active" : status.toLowerCase() || "inactive";
    },
    logs: log,
  };
}
