// The wake as a systemd user unit, `anywherellm-wake.service`, in $XDG_CONFIG_HOME/systemd/user. It
// runs a copy of this file kept in $XDG_DATA_HOME/anywherellm-wake, so a rebuild changes nothing
// running until the next install. Its log is the journal. Linux only.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { writeAtomic, writeAtomicIfChanged } from "#shared/atomic";
import type { Place } from "./settings.mts";

export const UNIT = "anywherellm-wake.service";

export const unitFile = ({ env, home }: Place): string => path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd", "user", UNIT);
export const programFile = ({ env, home }: Place): string => path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "anywherellm-wake", "anywherellm-wake.cjs");

const quote = (word: string): string => (/[\s"'\\$%]/.test(word) ? `"${word.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%").replace(/\$/g, "$$$$")}"` : word);

export const unitText = (node: string, program: string, envFile: string): string => `# anywherellm-wake: runs AnythingLLM scheduled jobs when ntfy messages arrive. Written by
# \`anywherellm-wake install\`; its settings are ${envFile}.
[Unit]
Description=anywherellm-wake: AnythingLLM jobs woken by ntfy messages
After=network-online.target

[Service]
EnvironmentFile=${envFile}
ExecStart=${[node, program, "serve"].map(quote).join(" ")}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;

export type Run = (cmd: string, args: string[]) => { status: number | null; stdout: string };

export const run: Run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "" };
};

const systemctl = (exec: Run, ...args: string[]) => exec("systemctl", ["--user", ...args]);

/** Copies `self` (this program) beside the unit's and writes the unit; answers whether either changed. */
export function define(place: Place, exec: Run, node: string, self: string, envFile: string): boolean {
  const program = programFile(place);
  const text = fs.readFileSync(self);
  const copied = !fs.existsSync(program) || !fs.readFileSync(program).equals(text);
  if (copied) writeAtomic(program, text, 0o755);
  const written = writeAtomicIfChanged(unitFile(place), unitText(node, program, envFile));
  if (written) systemctl(exec, "daemon-reload");
  return copied || written;
}

export function start(exec: Run): void {
  systemctl(exec, "enable", UNIT);
  if (systemctl(exec, "restart", UNIT).status !== 0) throw new Error(`systemctl --user restart ${UNIT} failed; see journalctl --user -u ${UNIT}`);
}

/** Stops and disables the unit and removes it and the program's copy. */
export function remove(place: Place, exec: Run): void {
  systemctl(exec, "disable", "--now", UNIT);
  fs.rmSync(unitFile(place), { force: true });
  fs.rmSync(path.dirname(programFile(place)), { recursive: true, force: true });
  systemctl(exec, "daemon-reload");
}

export const status = (exec: Run): string => systemctl(exec, "is-active", UNIT).stdout.trim() || "unknown";
