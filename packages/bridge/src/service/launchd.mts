// The bridge as a launchd agent of the user's GUI session, `local.anywherellm-bridge`, in
// `~/Library/LaunchAgents`. It starts at login (RunAtLoad) and again after a crash, not after a clean
// exit (KeepAlive SuccessfulExit false). Its output goes to `~/Library/Logs/anywherellm-bridge.log`.
// It is loaded with the bootstrap/bootout commands, which replaced load/unload in macOS 10.11.
// Not yet run on a real Mac: the commands follow launchctl(1).

import fs from "node:fs";
import path from "node:path";
import { writeAtomicIfChanged } from "#shared/atomic";
import type { Definition, Host, Manager } from "./index.mts";

export const LABEL = "local.anywherellm-bridge";

const xml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const string = (text: string): string => `<string>${xml(text)}</string>`;

export function plistText({ command, envFile }: Definition, log: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by \`anywherellm-suite install --bridge\`: the bridge to AnythingLLM's internal API. -->
<plist version="1.0">
<dict>
  <key>Label</key>${string(LABEL)}
  <key>ProgramArguments</key>
  <array>
${command.map((word) => `    ${string(word)}`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BRIDGE_ENV_FILE</key>${string(envFile)}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key>${string(log)}
  <key>StandardErrorPath</key>${string(log)}
</dict>
</plist>
`;
}

export function launchd(host: Host): Manager {
  const file = path.posix.join(host.home, "Library", "LaunchAgents", `${LABEL}.plist`);
  const log = path.posix.join(host.home, "Library", "Logs", "anywherellm-bridge.log");
  const domain = `gui/${host.uid}`;
  const target = `${domain}/${LABEL}`;
  const launchctl = (...args: string[]) => host.run("launchctl", args);
  return {
    kind: "launchd",
    label: LABEL,
    // The user's GUI domain answers only while they are logged in at the screen.
    usable: () => launchctl("print", domain).status === 0,
    define(definition) {
      if (!writeAtomicIfChanged(file, plistText(definition, log))) return false;
      fs.mkdirSync(path.dirname(log), { recursive: true });
      return true;
    },
    defined: () => fs.existsSync(file),
    start() {
      launchctl("enable", target);
      launchctl("bootout", target); // fails when it isn't loaded, which is fine
      if (launchctl("bootstrap", domain, file).status !== 0) throw new Error(`launchctl bootstrap ${domain} ${file} failed; see ${log}`);
    },
    stop() {
      const done = launchctl("bootout", target).status === 0;
      launchctl("disable", target);
      return done;
    },
    status() {
      const found = launchctl("print", target);
      return found.status === 0 && /^\s*state = running$/m.test(found.stdout) ? "active" : "inactive";
    },
    logs: log,
  };
}
