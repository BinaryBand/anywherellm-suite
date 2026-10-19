// The bridge as a service of the user's own service manager, so it starts at logon and again after
// a crash: systemd on Linux, launchd on macOS, the Task Scheduler on Windows. Where none can be
// driven (no user systemd, an ssh session without a GUI login), or when the settings say
// BRIDGE_SERVICE=foreground, `serve` runs under the owner's own supervisor (a terminal, tmux, a
// container, a process manager) and reads the same settings file.

import { spawnSync } from "node:child_process";
import type { Place } from "#shared/paths";
import { invalid } from "#shared/errors";
import { launchd } from "./launchd.mts";
import { systemd } from "./systemd.mts";
import { windows } from "./windows.mts";

/** Runs a command, never through a shell. A command that isn't installed reads as a failed run
 *  (status null). */
export type Run = (command: string, args: string[]) => { status: number | null; stdout: string };

export const run: Run = (command, args) => {
  const done = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  return { status: done.status, stdout: done.stdout ?? "" };
};

/** What a manager runs: the command that serves, with the settings file and the port it reads. */
export interface Definition {
  command: string[];
  envFile: string;
  port: number;
}

/** Where a manager writes, and how it runs its commands. */
export interface Host extends Place {
  run: Run;
  /** The user's id, for launchd's GUI domain. */
  uid: number;
}

export interface Manager {
  kind: Kind;
  /** What health and the messages call it. */
  label: string;
  /** Whether the manager answers here. */
  usable(): boolean;
  /** Writes the definition; whether it changed. */
  define(definition: Definition): boolean;
  /** Whether install defined it. */
  defined(): boolean;
  /** Enables and (re)starts it; throws when the manager refuses. */
  start(): void;
  /** Stops it and keeps it from starting again; whether the manager agreed. */
  stop(): boolean;
  /** "active" while it runs, else the manager's own word. */
  status(): string;
  /** Where its output goes, for a message. */
  logs: string;
}

export const KINDS = ["systemd", "launchd", "windows", "foreground"] as const;
export type Kind = (typeof KINDS)[number];
const OWN: Partial<Record<NodeJS.Platform, Kind>> = { linux: "systemd", darwin: "launchd", win32: "windows" };

/** No manager: nothing to define, start or stop. */
export const foreground: Manager = {
  kind: "foreground",
  label: "the bridge",
  usable: () => true,
  define: () => false,
  defined: () => false,
  start: () => {},
  stop: () => true,
  status: () => "not managed",
  logs: "the terminal or supervisor that runs `anywherellm-suite serve`",
};

const BUILD: Record<Kind, (host: Host) => Manager> = { systemd, launchd, windows, foreground: () => foreground };

/** A BRIDGE_SERVICE value: one of KINDS, or "" (also for "auto") to choose by the platform. */
export function parseKind(value: string | undefined): Kind | "" {
  const kind = (value ?? "").trim().toLowerCase();
  if (kind === "" || kind === "auto") return "";
  if (!(KINDS as readonly string[]).includes(kind)) throw invalid(`BRIDGE_SERVICE is one of ${KINDS.join(", ")} or auto, not ${JSON.stringify(value)}`);
  return kind as Kind;
}

/** The manager `wanted` names, else the platform's own (foreground where it has none), without
 *  asking whether it answers: what uninstall and health look in. */
export const managerOf = (wanted: Kind | "", host: Host): Manager => BUILD[wanted || OWN[host.platform] || "foreground"](host);

/** The manager `wanted` names, else the platform's own when it answers, else foreground: what
 *  install starts the bridge under. Only the platform's own manager is asked. */
export function choose(wanted: Kind | "", host: Host): Manager {
  const manager = managerOf(wanted, host);
  return wanted || manager.usable() ? manager : foreground;
}
