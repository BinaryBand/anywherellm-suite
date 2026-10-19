// The bridge as a systemd user unit, `anywherellm-bridge.service`, in the user's
// `$XDG_CONFIG_HOME/systemd/user` (`~/.config/systemd/user`). Its log is the journal.

import fs from "node:fs";
import { writeAtomicIfChanged } from "#shared/atomic";
import { configDir, pathsOf } from "#shared/paths";
import type { Definition, Host, Manager } from "./index.mts";

export const UNIT = "anywherellm-bridge.service";

export const unitFile = (host: Pick<Host, "platform" | "env" | "home">): string => pathsOf(host.platform).join(configDir("systemd", host), "user", UNIT);

const quote = (word: string): string => (/[\s"'\\$%]/.test(word) ? `"${word.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%").replace(/\$/g, "$$$$")}"` : word);

export function unitText({ command, envFile, port }: Definition): string {
  return `# anywherellm-bridge: the bridge to AnythingLLM's internal API (:${port}). Written by
# \`anywherellm-suite install --bridge\`; its settings are ${envFile}.
[Unit]
Description=anywherellm-bridge: a bridge to AnythingLLM's internal API (:${port})

[Service]
EnvironmentFile=${envFile}
ExecStart=${command.map(quote).join(" ")}
Restart=on-failure
RestartSec=10
TimeoutStopSec=20

[Install]
WantedBy=default.target
`;
}

export function systemd(host: Host): Manager {
  const file = unitFile(host);
  const systemctl = (...args: string[]) => host.run("systemctl", ["--user", ...args]);
  return {
    kind: "systemd",
    label: UNIT,
    // No systemctl, or no reachable user manager (an ssh session without a user bus), reads as an
    // empty answer.
    usable: () => ["running", "degraded", "starting"].includes(systemctl("is-system-running").stdout.trim()),
    define(definition) {
      if (!writeAtomicIfChanged(file, unitText(definition))) return false;
      systemctl("daemon-reload");
      return true;
    },
    defined: () => fs.existsSync(file),
    start() {
      systemctl("enable", UNIT);
      if (systemctl("restart", UNIT).status !== 0) throw new Error(`systemctl restart ${UNIT} failed; see \`journalctl --user -u ${UNIT}\``);
    },
    stop: () => systemctl("disable", "--now", UNIT).status === 0,
    status: () => systemctl("is-active", UNIT).stdout.trim(),
    logs: `\`journalctl --user -u ${UNIT}\``,
  };
}
