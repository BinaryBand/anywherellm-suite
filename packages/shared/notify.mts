// A notification to the user's own ntfy topic (https://ntfy.sh, which they can host themselves): one
// HTTP POST to the address in the skill's NTFY_URL setting.

/** The topic's address and its access token, both "" when unset. */
export interface Ntfy {
  url: string;
  token: string;
}

/** A header value ntfy reads as UTF-8: as it is when it is ASCII, else RFC 2047 encoded. */
const headerText = (s: string): string => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

/** Posts `note` to the topic, with the token as its bearer token when there is one; `click` is the
 *  absolute address it opens. Does nothing when the address isn't http(s); throws when the server
 *  refuses or doesn't answer in 10 s. The address is the user's own setting, never the model's, and
 *  may well be on their network, so it isn't put through the fence. */
export async function notify(ntfy: Ntfy, note: { title: string; body: string; click?: string }): Promise<void> {
  if (!/^https?:\/\//i.test(ntfy.url)) return;
  const res = await fetch(ntfy.url, {
    method: "POST",
    body: note.body,
    headers: { Title: headerText(note.title), ...(note.click ? { Click: note.click } : {}), ...(ntfy.token ? { Authorization: `Bearer ${ntfy.token}` } : {}) },
    signal: AbortSignal.timeout(10_000),
  });
  await res.body?.cancel(); // the answer isn't read, and its connection is free again
  if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
}
