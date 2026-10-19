// What AnythingLLM supplies to the skill, as far as the skill uses it. AnythingLLM's server code is
// not a public API, so these are the skill's own description of it.

/** `this` in the handler, as AnythingLLM's agent sets it up. */
export interface HandlerContext {
  super?: {
    handlerProps?: { invocation?: { workspace?: { slug?: string } | null } };
  };
  /** The skill's settings (plugin.json's setup_args), as the user set them in AnythingLLM. */
  runtimeArgs?: Record<string, string | undefined>;
  /** AnythingLLM's approval prompt for a tool call: the agent pauses until the user answers. Not
   *  part of the documented skill contract (docs/.scratch/TODO.md), and absent in a scheduled job. */
  requestToolApproval?: (request: { payload: Record<string, unknown>; description: string }) => Promise<{ approved: boolean; message?: string }>;
  logger?: (message: string) => void;
}
