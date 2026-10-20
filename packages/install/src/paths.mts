// Where a user's files live on each OS. The platform, environment and home folder are arguments,
// so one test run can ask for all three.

import path from "path";

export interface Place {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}

/** The path module that builds the platform's paths, whatever OS this runs on. */
const pathsOf = (platform: NodeJS.Platform): path.PlatformPath => (platform === "win32" ? path.win32 : path.posix);

/** AnythingLLM Desktop's storage folder, in Electron's settings folder for it (docs.anythingllm.com,
 *  installation-desktop/storage): `%APPDATA%` on Windows, `~/Library/Application Support` on macOS,
 *  `$XDG_CONFIG_HOME` (an absolute one) or `~/.config` elsewhere. */
export function desktopStorage({ platform, env, home }: Place): string {
  const p = pathsOf(platform);
  const xdg = env.XDG_CONFIG_HOME;
  const settings =
    platform === "win32" ? env.APPDATA || p.join(home, "AppData", "Roaming")
    : platform === "darwin" ? p.join(home, "Library", "Application Support")
    : xdg && p.isAbsolute(xdg) ? xdg
    : p.join(home, ".config");
  return p.join(settings, "anythingllm-desktop", "storage");
}

/** `~`, `~/x` or `~\x` with the home folder in place of the `~`. */
export const expandHome = (file: string, home: string): string => file.replace(/^~(?=[\\/]|$)/, home);
