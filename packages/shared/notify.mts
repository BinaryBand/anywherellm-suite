// A notification to the user's own ntfy topic (https://ntfy.sh, which they can host themselves): one
// HTTP POST, set up by the skill's NTFY_URL setting. Nothing of AnythingLLM's own is used.

/** The skill's settings (plugin.json's setup_args), as AnythingLLM passes them. */
type Settings = Record<string, string | undefined> | undefined;

/** A header value ntfy reads as UTF-8: as it is when it is ASCII, else RFC 2047 encoded. */
const headerText = (s: string): string => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

/** Posts `note` to the NTFY_URL topic, with NTFY_TOKEN as its bearer token when one is set; `click` is
 *  the absolute address it opens. Does nothing when NTFY_URL is unset or isn't an http(s) address;
 *  throws when the server refuses or doesn't answer in 10 s. */
export async function notify(settings: Settings, note: { title: string; body: string; click?: string }): Promise<void> {
  const url = String(settings?.NTFY_URL ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return;
  const token = String(settings?.NTFY_TOKEN ?? "").trim();
  const res = await fetch(url, {
    method: "POST",
    body: note.body,
    headers: { Title: headerText(note.title), ...(note.click ? { Click: note.click } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
}
