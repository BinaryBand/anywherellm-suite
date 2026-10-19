// KEY=value files as the tests read them: contract/versions.env, and the password in an .env.
import fs from "node:fs";

/** The KEY=value settings in an env file, quotes dropped; a missing file reads as empty. */
export function readEnv(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const found: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const cut = line.indexOf("=");
    const key = line.slice(0, cut).trim();
    if (cut >= 0 && key && !key.startsWith("#")) found[key] = line.slice(cut + 1).trim().replace(/^['"]+|['"]+$/g, "");
  }
  return found;
}
