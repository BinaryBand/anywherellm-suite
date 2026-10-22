/** A failure whose message is meant for whoever asked (the agent, a function's script, the user):
 *  safe to show as it is. Every skill's own refusals extend it, so a catch tells them from a bug by
 *  this one class; the installer's refusals and AnythingLLM's absence (upstream.mts) are one too. */
export class Told extends Error {}

/** The first line of what an error says. */
export const firstLine = (e: unknown): string => String((e as Error)?.message ?? e).split("\n")[0];
