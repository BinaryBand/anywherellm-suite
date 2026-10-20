// What AnythingLLM supplies to the skill, as far as the skill uses it. AnythingLLM's server code is
// not a public API, so these are the skill's own description of it.

import type { Asking } from "#shared/ask";

/** `this` in the handler, as AnythingLLM's agent sets it up. */
export interface HandlerContext extends Asking {
  /** The skill's settings (plugin.json's setup_args), as the user set them in AnythingLLM. */
  runtimeArgs?: Record<string, string | undefined>;
  logger?: (message: string) => void;
}
