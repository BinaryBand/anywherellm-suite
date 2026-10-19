// Where a user's files live on each OS. The platform, environment and home folder are arguments,
// so one test run can ask for all three.

import path from "path";

export type Env = Record<string, string | undefined>;

export interface Place {
  platform: NodeJS.Platform;
  env: Env;
  home: string;
}

/** The path module that builds the platform's paths, whatever OS this runs on. */
export const pathsOf = (platform: NodeJS.Platform): path.PlatformPath => (platform === "win32" ? path.win32 : path.posix);

/** An app's settings folder: `%APPDATA%\<app>` on Windows, `~/Library/Application Support/<app>`
 *  on macOS, `$XDG_CONFIG_HOME/<app>` (an absolute one) or `~/.config/<app>` elsewhere. */
export function configDir(app: string, { platform, env, home }: Place): string {
  const p = pathsOf(platform);
  if (platform === "win32") return p.join(env.APPDATA || p.join(home, "AppData", "Roaming"), app);
  if (platform === "darwin") return p.join(home, "Library", "Application Support", app);
  const xdg = env.XDG_CONFIG_HOME;
  return p.join(xdg && p.isAbsolute(xdg) ? xdg : p.join(home, ".config"), app);
}

/** AnythingLLM Desktop's storage folder, which is Electron's settings folder for it on every OS
 *  (docs.anythingllm.com, installation-desktop/storage). */
export const desktopStorage = (place: Place): string => pathsOf(place.platform).join(configDir("anythingllm-desktop", place), "storage");

/** Whether two paths name one folder; file names on Windows and macOS ignore case. */
export function samePath(platform: NodeJS.Platform, a: string, b: string): boolean {
  const fold = (p: string) => (platform === "linux" ? path.resolve(p) : path.resolve(p).toLowerCase());
  return fold(a) === fold(b);
}

/** `~`, `~/x` or `~\x` with the home folder in place of the `~`. */
export const expandHome = (file: string, home: string): string => file.replace(/^~(?=[\\/]|$)/, home);
