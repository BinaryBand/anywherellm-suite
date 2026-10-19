// KEY=value files: the settings file, `bridge.env` (settings.mts says where), which the runner's
// service reads as its environment and every command reads too, and AnythingLLM's own .env, where
// its password is.

import fs from "node:fs";
import { writeAtomic } from "#shared/atomic";

const HEADER = [
  "# anywherellm-bridge's settings: the runner's environment. `install` writes the first",
  "# ones; the README lists every setting.",
];

/** The KEY=value settings in an env file, quotes dropped; a missing file reads as empty. */
export function readEnv(file: string): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const found: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const cut = line.indexOf("=");
    const key = line.slice(0, cut).trim();
    if (cut >= 0 && key && !key.startsWith("#")) found[key] = line.slice(cut + 1).trim().replace(/^['"]+|['"]+$/g, "");
  }
  return found;
}

/** Set (or, with null, drop) settings in the file, keeping its others and its comments. A new file
 *  starts with `header` (the bridge's own settings header by default). The file is the user's alone
 *  (mode 600). */
export function saveEnv(file: string, changes: Record<string, string | null>, header: string[] = HEADER): void {
  const left = new Map(Object.entries(changes));
  const kept: string[] = [];
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [...header];
  if (existing.at(-1) === "") existing.pop();
  for (const line of existing) {
    const key = line.split("=", 1)[0].trim();
    if (!left.has(key)) {
      kept.push(line);
    } else {
      const value = left.get(key);
      left.delete(key);
      if (value != null) kept.push(`${key}=${value}`);
    }
  }
  for (const [key, value] of left) if (value !== null) kept.push(`${key}=${value}`);
  writeAtomic(file, kept.join("\n") + "\n", 0o600);
}
