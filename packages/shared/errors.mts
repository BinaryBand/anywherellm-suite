/** A failure whose message is meant for whoever asked (the agent, a function's script, the user):
 *  safe to show as it is. Every part's own refusals extend it, so a catch tells them from a bug by
 *  this one class. */
export class Told extends Error {}

// A failure with the status it stands for: 400 a bad request (the installer's refusals), 502
// AnythingLLM can't be reached or refused the login (upstream.mts). The text is shown to whoever
// asked, the agent or the person at the terminal.

export class StatusError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const invalid = (message: string): StatusError => new StatusError(400, message);
export const upstream = (message: string): StatusError => new StatusError(502, message);
