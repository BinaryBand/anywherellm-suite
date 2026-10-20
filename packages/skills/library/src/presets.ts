// The sign-ins the library knows, so the agent needn't work them out from the provider's docs and
// the user makes no OAuth client: each signs in with the suite's own client at the provider, a
// public one with the device flow on (device.ts), which has an ID and no secret. A provider that
// isn't here has no sign-in: its key or token goes on the Vault (secrets.ts).

import { LibraryError } from "./errors";
import type { Definition } from "./oauth";

/** The suite's GitHub OAuth app, "AnywhereLLM Suite" (github.com/settings/applications/3944676),
 *  with Enable Device Flow ticked. Its ID is public, and it has no secret. */
const GITHUB_CLIENT_ID = "Ov23li2l9pSDiyh3JA7p";

/** Where the tokens may go, how to sign in (the scopes come with the task) and the suite's client there. */
const PRESETS: Record<string, { site: string; definition: Omit<Definition, "scopes">; client_id: string }> = {
  github: {
    site: "api.github.com",
    definition: { token_url: "https://github.com/login/oauth/access_token", device_url: "https://github.com/login/device/code" },
    client_id: GITHUB_CLIENT_ID,
  },
};

/** The preset `name`, with the `scopes` the task needs in its definition. */
export function presetOf(name: unknown, scopes: unknown) {
  const key = String(name ?? "").trim().toLowerCase();
  const preset = PRESETS[key];
  if (!preset) throw new LibraryError(`there's no preset "${key}": the presets are ${Object.keys(PRESETS).join(", ")}; for another service, ask for a key or token with secret`);
  const list = String(scopes ?? "").trim();
  if (list.length > 1000) throw new LibraryError("scopes are at most 1000 characters");
  return { ...preset, definition: { ...preset.definition, scopes: list } };
}
