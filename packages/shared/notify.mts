// A notification to the user's own ntfy topic (https://ntfy.sh, which they can host themselves): one
// HTTP POST to the address in the skill's NTFY_URL setting.

/** The topic's address (from topicUrl) and its access token, both "" when unset. */
export interface Ntfy {
  url: string;
  token: string;
}

/** A topic address as typed: https:// put before one with no scheme, no trailing slash; "" when it
 *  isn't an http(s) address, so the topic is unusable. */
export const topicUrl = (typed: string): string => {
  const url = typed.trim().replace(/\/+$/, "");
  const full = url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? `https://${url}` : url;
  return /^https?:\/\//i.test(full) ? full : "";
};

/** Posts `note` (its title ASCII) to the topic, with the token as its bearer token when there is one;
 *  `click` is the absolute address it opens. Does nothing without an address; throws when the server
 *  refuses or doesn't answer in 10 s, saying why but never what was sent (the address can hold a
 *  password, and the token is a header). The address is the user's own setting, never the model's,
 *  and may well be on their network, so it isn't put through the fence. */
export async function notify(ntfy: Ntfy, note: { title: string; body: string; click?: string }): Promise<void> {
  if (!ntfy.url) return;
  const res = await fetch(ntfy.url, {
    method: "POST",
    body: note.body,
    headers: { Title: note.title, ...(note.click ? { Click: note.click } : {}), ...(ntfy.token ? { Authorization: `Bearer ${ntfy.token}` } : {}) },
    signal: AbortSignal.timeout(10_000),
  }).catch((e: Error & { cause?: { code?: string } }) => {
    throw new Error(`ntfy wasn't reached (${e.cause?.code ?? e.name})`);
  });
  await res.body?.cancel(); // the answer isn't read, and its connection is free again
  if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
}
