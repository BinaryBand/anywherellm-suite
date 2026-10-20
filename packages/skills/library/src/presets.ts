// The sign-ins the library knows already, so the agent needn't work them out from the provider's
// docs and the user makes no OAuth client: each signs in with the suite's own client at the
// provider, a public one with the device flow on (device.ts), which has an ID and no secret.

import { LibraryError } from "./errors";

/** The suite's GitHub OAuth app, "AnywhereLLM Suite" (github.com/settings/applications/3944676),
 *  with Enable Device Flow ticked. Its ID is public, and it has no secret. */
const GITHUB_CLIENT_ID = "Ov23li2l9pSDiyh3JA7p";

export interface Preset {
  /** Where the tokens may go. */
  site: string;
  definition: Record<string, unknown>;
  client_id: string;
}

const PRESETS: Record<string, Preset> = {
  github: {
    site: "api.github.com",
    definition: { authorize_url: "https://github.com/login/oauth/authorize", token_url: "https://github.com/login/oauth/access_token", device_url: "https://github.com/login/device/code", pkce: false },
    client_id: GITHUB_CLIENT_ID,
  },
};

/** The preset `name`, with the `scopes` the task needs in its definition. */
export function presetOf(name: unknown, scopes: unknown): Preset {
  const key = String(name ?? "").trim().toLowerCase();
  const preset = PRESETS[key];
  if (!preset) throw new LibraryError(`there's no preset "${key}": the presets are ${Object.keys(PRESETS).join(", ")}; for another provider, give the definition`);
  if (!preset.client_id) throw new LibraryError(`the suite's ${key} client isn't registered yet: give the definition and the user's own client instead`);
  return { ...preset, definition: { ...preset.definition, scopes: scopes ?? "" } };
}
