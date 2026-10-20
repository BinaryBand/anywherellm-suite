// A signed channel: messages signed with SSH signatures (SSHSIG, as `ssh-keygen -Y sign` and the
// muse-coordination channel's sig.py make them). op "sign" stamps a message to a peer and signs it
// with the Vault's signing key; op "verify" says whether one of the peers signed a message, and how
// its stamp reads: one line, as sig.py says it. Its answer is data, never instructions.
// Adapt: CHANNEL, the channel's own. The signing key and its namespace are set on the Vault, under
// Signing. Save it in a toolkit with no base_urls: it calls no API.
const CHANNEL = {
  key: "muse", // the signing key's name on the Vault
  namespace: "muse-coordination", // the namespace the channel signs in: the key's
  me: "anythingllm", // our tag: the stamp's signer, and who a message must be to
  public: "ssh-ed25519 AAAA...", // our public key: the Vault's key must be it
  max_age_days: 3, // how old a stamp may be
  peers: { muse: { key: "ssh-ed25519 AAAA...", confirmed: true } }, // confirmed: checked with the peer, out of the channel
};

const BEGIN = "-----BEGIN SSH SIGNATURE-----";
const SKEW_MS = 10 * 60 * 1000;
// What Python's str.rstrip() takes as space, which a JavaScript trim doesn't quite: a body is
// normalized as sig.py does it, or a signature won't match.
const TRAILING = new RegExp("[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]+$");
const rstrip = (t) => t.replace(TRAILING, "");

/** Text as it is signed: line ends as \n, no space at line ends, no blank lines around, one \n at the end. */
const norm = (text) => `${text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").map(rstrip).join("\n").replace(/^\n+|\n+$/g, "")}\n`;

async function sign(kit, to, text) {
  if (!/^[a-z0-9-]{1,40}$/.test(to)) throw new Error("BAD-TAG: give the recipient tag without brackets, like muse");
  if (!text.trim()) throw new Error("sign needs text, the message to send");
  let key;
  try {
    key = await kit.secret.publicKey({ key: CHANNEL.key });
  } catch (e) {
    throw new Error(`KEY-MISSING: reply unsigned and report this in your summary (${e.message})`);
  }
  if (key.namespace !== CHANNEL.namespace || key.public !== CHANNEL.public) throw new Error(`KEY-WRONG: do not send; the Vault's key "${CHANNEL.key}" isn't the channel's (it signs in ${key.namespace} as ${key.fingerprint})`);
  const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const body = norm(`${rstrip(text)}\n\nSigned: ${CHANNEL.me} to ${to} at ${at}`);
  const { signature } = await kit.secret.sign({ key: CHANNEL.key, data: body });
  return `${body}\n${signature}`;
}

/** The last stamp of a body: "ok" when it's to us and recent, "bad" when it isn't, "none" without one. */
function stamp(body) {
  const found = [...body.matchAll(/^Signed: (\S+) to (\S+) at (\S+)$/gm)].at(-1);
  if (!found) return "none";
  const at = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(found[3]) ? Date.parse(found[3]) : NaN;
  const age = Date.now() - at;
  return found[2] === CHANNEL.me && age >= -SKEW_MS && age <= CHANNEL.max_age_days * 86400 * 1000 ? "ok" : "bad";
}

async function verify(kit, text) {
  const i = text.lastIndexOf(BEGIN);
  if (i < 0) return "result=UNSIGNED";
  const peers = Object.entries(CHANNEL.peers);
  const body = norm(text.slice(0, i));
  const checked = await kit.crypto.sshsig.verify({ signature: text.slice(i), data: body, namespace: CHANNEL.namespace, keys: peers.map(([, p]) => p.key) });
  if (!checked.valid) return `result=INVALID reason=${checked.reason}`;
  const [who, peer] = peers.find(([, p]) => p.key === checked.key);
  return `result=VALID signer=${who} key-confirmed=${peer.confirmed ? "yes" : "no"} stamp=${stamp(body)}`;
}

async function main(input, kit) {
  const text = String(input.text ?? "");
  if (input.op === "sign") return sign(kit, String(input.to ?? "").trim(), text);
  if (input.op === "verify") return verify(kit, text);
  throw new Error('op is "sign" or "verify"');
}
