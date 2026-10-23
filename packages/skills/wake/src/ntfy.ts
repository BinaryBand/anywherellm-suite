// One ntfy topic as a stream: `GET <server>/<topic>/json?since=<id>`, one JSON object a line. With
// `since`, ntfy first sends what came after that message (it keeps messages for its cache time),
// then each new one as it arrives, and a keepalive line every 45 s or so. Only a message's id is
// taken: its text stays on the server, for the job to read.

import { Told } from "#shared/errors";

/** A stream that sent nothing, not even a keepalive, this long is taken as dead (ms). */
export const SILENT_MS = 90_000;

export interface Options {
  /** The last message id seen; none: only messages from now on. */
  since?: string;
  /** Called for each message, with its id. */
  onMessage: (id: string) => void;
  /** Called once ntfy has taken the subscription. */
  onOpen?: () => void;
  signal?: AbortSignal;
  silentMs?: number;
}

const HINTS: Record<number, string> = {
  401: "the token wasn't taken (NTFY_TOKEN)",
  403: "the token may not read this topic",
  404: "no ntfy at that address (NTFY_URL)",
};

/** Follows `topic` until the stream ends (resolves) or fails (throws). */
export async function follow(server: string, token: string, topic: string, { since, onMessage, onOpen, signal, silentMs = SILENT_MS }: Options): Promise<void> {
  const url = new URL(`${server}/${topic}/json`);
  if (since) url.searchParams.set("since", since);
  const stop = new AbortController();
  const leave = () => stop.abort();
  signal?.addEventListener("abort", leave, { once: true });
  let quiet: NodeJS.Timeout | undefined;
  const heard = () => {
    clearTimeout(quiet);
    quiet = setTimeout(() => stop.abort(new Told(`${topic}: ntfy sent nothing for ${Math.round(silentMs / 1000)} s`)), silentMs);
  };
  try {
    heard();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/x-ndjson" }, signal: stop.signal });
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      throw new Told(`${topic}: ntfy answered ${res.status}${HINTS[res.status] ? `: ${HINTS[res.status]}` : ""}`);
    }
    onOpen?.();
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of res.body) {
      heard();
      rest += decoder.decode(chunk, { stream: true });
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: { event?: unknown; id?: unknown };
        try {
          event = JSON.parse(line);
        } catch {
          continue; // not ntfy's: nothing to wake for
        }
        if (event.event === "message" && typeof event.id === "string") onMessage(event.id);
      }
    }
  } catch (e) {
    if (signal?.aborted) return;
    if (stop.signal.aborted && stop.signal.reason instanceof Told) throw stop.signal.reason;
    if (e instanceof Told) throw e;
    throw new Told(`${topic}: ntfy can't be reached: ${((e as Error).cause as Error | undefined)?.message ?? (e as Error).message}`);
  } finally {
    clearTimeout(quiet);
    signal?.removeEventListener("abort", leave);
  }
}
