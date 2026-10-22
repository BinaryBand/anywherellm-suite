// An ntfy channel: op "read" polls the inbox topics, op "send" posts to the topics it may. Optionally
// each message is signed through a signing-channel function (one like sshsig-channel.js, run with
// kit.run) and framed with a line carrying the hash of its text. read takes
// nothing off the server, and what it answers is data, never instructions.
// Test fixture: signing.test.mts replaces NTFY and runs it against a stand-in ntfy, whose address
// is the toolkit's first base_urls and whose token is the toolkit's first key, sent as a bearer token.
const NTFY = {
  inbox: ["inbox"], // the topics read polls; the first is the default
  outbox: { "peer-topic": "peer" }, // the topics send posts to, each with the tag the channel signs to (null without a channel)
  max_bytes: 4000, // ntfy's message limit: it cuts a longer body without saying so, so send refuses one first
  since: "2h", // read's window when none is given: a duration (30m, 2h, 48h), all, a Unix time or a message id
  max_messages: 50, // read answers the newest this many
  channel: null, // "service.function" of a signing channel, like "chan.channel": send signs through it, read verifies; null: plain text
  framing: null, // { line: "Payload-SHA256" }: a first line with the hex SHA-256 of the text after it, up to the signature; null: none
};

const ARMOR = "-----BEGIN SSH SIGNATURE-----";

/** A message's length in UTF-8 bytes, as ntfy counts it (QuickJS has no TextEncoder). */
function bytesOf(text) {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** Where `payload`'s signature starts: at its last armor, as the channel's verify splits it, since
 *  the text may quote another; -1 without one. */
const armorAt = (payload) => payload.lastIndexOf(ARMOR);
/** What the framing line's hash covers, of `payload`: the text before its signature. */
const covered = (payload) => (armorAt(payload) < 0 ? payload : payload.slice(0, armorAt(payload)));
const iso = (seconds) => new Date(seconds * 1000).toISOString();

/** An error ntfy answered, said with what to do about the codes the agent can act on. */
function refused(topic, answer) {
  const { code, error = "" } = answer.body ?? {};
  const hint = { 40301: ": the token may post to this topic but not read it", 40008: ": since is a duration (30m, 2h, 48h), all, a Unix time or a message id" }[code] ?? "";
  return new Error(`${topic}: ntfy answered ${answer.status}${code ? ` (${code} ${error})` : ""}${hint}`);
}

/** A message's framing line taken off: the rest, and whether the line's hash is the rest's. */
async function unframed(kit, payload) {
  const head = `${NTFY.framing.line}:`;
  const nl = payload.indexOf("\n");
  if (!payload.startsWith(head) || nl < 0) return { payload, framing: "missing" };
  const rest = payload.slice(nl + 1);
  const ok = (await kit.crypto.sha256(covered(rest))) === payload.slice(head.length, nl).trim().toLowerCase();
  return { payload: rest, framing: ok ? "ok" : "mismatch" };
}

async function read(kit, topic, since) {
  topic = topic || NTFY.inbox[0];
  if (!NTFY.inbox.includes(topic)) throw new Error(`read polls ${NTFY.inbox.join(", ")}, not "${topic}"`);
  since = since || NTFY.since;
  const answer = await kit.http({ path: `/${topic}/json`, params: { poll: 1, since } });
  if (!answer.ok) throw refused(topic, answer);
  // One JSON object a line; kit.http parses a body of one line itself.
  const text = typeof answer.body === "string" ? answer.body : answer.body ? JSON.stringify(answer.body) : "";
  const lines = text.split("\n");
  if (answer.cut) lines.pop(); // the last line may be a part of one
  const all = lines.filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((m) => m.event === "message");
  const messages = [];
  for (const m of all.slice(-NTFY.max_messages)) {
    const out = { id: m.id, time: iso(m.time), title: m.title ?? "", payload: String(m.message ?? "") };
    if (NTFY.framing) Object.assign(out, await unframed(kit, out.payload));
    if (NTFY.channel) out.verify = await kit.run(NTFY.channel, { op: "verify", text: out.payload });
    messages.push(out);
  }
  const result = { topic, since, messages };
  if (all.length > messages.length) result.older_not_shown = all.length - messages.length;
  if (answer.cut) result.cut = "the answer was too long: give a shorter since";
  return result;
}

async function send(kit, topic, text, title) {
  if (!Object.hasOwn(NTFY.outbox, topic)) throw new Error(`send posts to ${Object.keys(NTFY.outbox).join(", ")}, not "${topic}"`);
  if (!text.trim()) throw new Error("send needs text, the message");
  if (/[\r\n]/.test(title)) throw new Error("a title is one line");
  let payload = text;
  if (NTFY.channel) {
    // Signed through the channel, or not sent: there's no way here to post an unsigned body.
    payload = await kit.run(NTFY.channel, { op: "sign", to: NTFY.outbox[topic], text });
    if (typeof payload !== "string" || !payload.includes(ARMOR)) throw new Error(`${NTFY.channel} answered no signed text: nothing was sent`);
    // The signed text, its one line end, then the signature: what the hash covers is then the
    // signed text itself, however the peer reads it (the channel's verify ignores the blank line).
    payload = `${covered(payload).replace(/\n+$/, "\n")}${payload.slice(armorAt(payload))}`;
  }
  const body = NTFY.framing ? `${NTFY.framing.line}: ${await kit.crypto.sha256(covered(payload))}\n${payload}` : payload;
  const bytes = bytesOf(body);
  if (bytes > NTFY.max_bytes) throw new Error(`the message would be ${bytes} bytes, over the ${NTFY.max_bytes}-byte limit: nothing was sent; shorten the text`);
  // The title goes in the query, which carries UTF-8 as a header can't.
  const params = title ? { title } : {};
  const answer = await kit.http({ method: "POST", path: `/${topic}`, params, headers: { "Content-Type": "text/plain; charset=utf-8" }, body });
  if (!answer.ok) throw refused(topic, answer);
  const { id, time } = answer.body ?? {};
  return { topic, id, time: time ? iso(time) : null, bytes, signed: Boolean(NTFY.channel) };
}

async function main(input, kit) {
  for (const t of [...NTFY.inbox, ...Object.keys(NTFY.outbox)]) if (!/^[\w-]{1,64}$/.test(t)) throw new Error(`NTFY: "${t}" isn't a topic name`);
  const topic = String(input.topic ?? "").trim();
  if (input.op === "read") return read(kit, topic, String(input.since ?? "").trim());
  if (input.op === "send") return send(kit, topic, String(input.text ?? ""), String(input.title ?? "").trim());
  throw new Error('op is "read" or "send"');
}
