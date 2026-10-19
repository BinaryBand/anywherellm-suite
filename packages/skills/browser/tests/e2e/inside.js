// Run inside a stock AnythingLLM container (by hand: see docs/notes/skills/browser): loads the skill
// through AnythingLLM's own loader (ImportedPlugin), sets it up on a stand-in agent as AnythingLLM's
// agent would, and drives the image's real Chrome, through the bundled Puppeteer, against a site this script
// serves on 127.0.0.1 and localhost (FENCE_ALLOW lets them through): open and read a page, act on it, sign in with
// the password given on the tab's page (sealed with the vault's key, posted as AnythingLLM's
// collector writes it), take the tab over and sign in by tapping and typing, make a passkey while
// holding the tab and sign in with it from another tab (the site checking its signature and count),
// search and look at a stand-in search page, and stay signed in (the site's cookie, kept in the
// vault) after the browser closes and starts again.
// Prints "ok" or throws.
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { HUB_ID } = process.env;
const APP = "/app/server";
const PORT = 18090;
const SITE = `http://127.0.0.1:${PORT}`;
/** The same server under another name, for a search result that isn't on the engine's own site. */
const DOCS = `http://localhost:${PORT}/docs`;
/** The passkey page, on localhost: a secure context, so WebAuthn works over http. */
const PASSKEYS = `http://localhost:${PORT}/pk`;

const ImportedPlugin = require(`${APP}/utils/agents/imported.js`);

const page = (title, body) => `<!doctype html><title>${title}</title><body>${body}</body>`;

// The passkey page: Add a passkey makes one and sends its public key here; Sign in with a passkey
// signs a challenge, which this server checks against that key and the count.
const passkeys = { keys: new Map(), challenges: new Set(), log: [] };
const PK_PAGE = page("Passkeys", `<button id="add" style="position:fixed;left:0;top:0;width:320px;height:80px">Add a passkey</button>
<button id="in" style="position:fixed;left:0;top:100px;width:320px;height:80px">Sign in with a passkey</button><p id="out" style="margin-top:200px">Not signed in</p>
<script>
const b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
const say = (t) => (document.getElementById("out").textContent = t);
const to = (path, body) => fetch(path, { method: "POST", body: JSON.stringify(body) }).then((r) => r.text());
document.getElementById("add").onclick = async () => {
  try {
    const c = await navigator.credentials.create({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rp: { name: "Passkeys", id: location.hostname }, user: { id: new TextEncoder().encode("u1"), name: "anna", displayName: "Anna" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { residentKey: "required", userVerification: "required" } } });
    say(await to("/pk/registered", { id: c.id, pub: b64(c.response.getPublicKey()) }));
  } catch (e) { say("Passkey refused: " + e.name); }
};
document.getElementById("in").onclick = async () => {
  try {
    const challenge = await (await fetch("/pk/challenge")).text();
    const a = await navigator.credentials.get({ publicKey: { challenge: Uint8Array.from(atob(challenge.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)), rpId: location.hostname, userVerification: "required" } });
    say(await to("/pk/assert", { id: a.id, cd: b64(a.response.clientDataJSON), ad: b64(a.response.authenticatorData), sig: b64(a.response.signature) }));
  } catch (e) { say("Passkey refused: " + e.name); }
};
</script>`);

function passkeyRoute(url, body, res) {
  if (url.pathname === "/pk") return res.end(PK_PAGE);
  if (url.pathname === "/pk/challenge") {
    const challenge = crypto.randomBytes(32).toString("base64url");
    passkeys.challenges.add(challenge);
    return res.end(challenge);
  }
  const sent = JSON.parse(body || "{}");
  if (url.pathname === "/pk/registered") {
    passkeys.keys.set(sent.id, { pub: sent.pub, count: 0 });
    passkeys.log.push("registered");
    return res.end("Passkey added");
  }
  const known = passkeys.keys.get(sent.id);
  const cd = Buffer.from(sent.cd, "base64url");
  const ad = Buffer.from(sent.ad, "base64url");
  const client = JSON.parse(cd);
  const signed = Buffer.concat([ad, crypto.createHash("sha256").update(cd).digest()]);
  const key = known && crypto.createPublicKey({ key: Buffer.from(known.pub, "base64url"), format: "der", type: "spki" });
  const count = ad.readUInt32BE(33);
  const ok = !!key && passkeys.challenges.delete(client.challenge) && ad.subarray(0, 32).equals(crypto.createHash("sha256").update("localhost").digest()) && crypto.verify("sha256", signed, key, Buffer.from(sent.sig, "base64url")) && count > known.count;
  if (ok) known.count = count;
  passkeys.log.push(ok ? "signed in" : "refused");
  res.end(ok ? `Signed in with a passkey, count ${count}` : "Refused");
}
/** The sign-in form, with `extra` fields before its button. */
const loginForm = (extra = "") => `<form method="post" action="/login"><label>User <input name="user"></label><label>Password <input id="p" name="pass" type="password"></label>${extra}<button>Sign in</button></form>`;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("Content-Type", "text/html");
    const url = new URL(req.url, SITE);
    if (url.pathname === "/login" && req.method === "POST") {
      const form = new URLSearchParams(body);
      for (const [user, pass] of [["ada", "e2e-pass-123"], ["bea", "e2e-pass-456"]]) {
        if (form.get("user") !== user || form.get("pass") !== pass) continue;
        res.setHeader("Set-Cookie", `sid=${user}; Path=/; HttpOnly; Max-Age=3600`);
        return res.end(page("Home", `<p>Welcome, ${user}.</p>`));
      }
      return res.end(page("Sign in", "<p>Wrong password.</p>"));
    }
    if (url.pathname === "/me") {
      const sid = /(?:^|; )sid=(\w+)/.exec(req.headers.cookie || "");
      return res.end(page("Me", sid ? "<p>Signed in.</p>" : "<p>Not signed in.</p>"));
    }
    if (url.pathname === "/login") return res.end(page("Sign in", loginForm()));
    if (url.pathname === "/shadow") return res.end(page("Sign in", `<sign-in></sign-in><script>customElements.define("sign-in", class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = ${JSON.stringify(loginForm())}; } });</script>`));
    if (url.pathname === "/show") return res.end(page("Sign in", loginForm(`<label><input type="checkbox" onchange="p.type = this.checked ? 'text' : 'password'"> Show password</label>`)));
    if (url.pathname === "/captcha") return res.end(page("Sign in", loginForm('<label>Digits in the image <input name="digits" required></label>')));
    if (url.pathname === "/consent") return res.end(page("Sign in", `<main inert>${loginForm()}</main><div role="dialog" aria-modal="true" aria-label="Cookies on this site"><p>We use cookies.</p><button onclick="this.parentElement.remove(); document.querySelector('main').inert = false">Reject all</button><button>Accept all</button></div>`));
    if (url.pathname === "/dob") return res.end(page("Profile", '<form><label>Date of birth <input type="date" name="dob" required></label><button disabled>Next</button></form><script>const f = document.forms[0]; f.oninput = () => (f.querySelector("button").disabled = !f.checkValidity());</script>'));
    if (url.pathname === "/code" && req.method === "POST") {
      if (new URLSearchParams(body).get("code") === "123456") return res.end(page("Account", '<a href="/keys">Create API key</a>'));
      return res.end(page("Two-step", '<p>That code is wrong.</p><form method="post" action="/code"><label>Code <input name="code"></label><button>Verify</button></form>'));
    }
    if (url.pathname === "/code") return res.end(page("Two-step", '<p>Check your phone: we sent a code by text message.</p><form method="post" action="/code"><label>Code <input name="code"></label><button>Verify</button></form>'));
    if (url.pathname === "/signup" && req.method === "POST") {
      const form = new URLSearchParams(body);
      const ok = form.get("pass") && form.get("pass") === form.get("confirm");
      return res.end(ok ? page("Welcome", `<p>Account made for ${form.get("user")}.</p>`) : page("Create account", "<p>The passwords don't match.</p>"));
    }
    if (url.pathname === "/signup") return res.end(page("Create account", '<form method="post" action="/signup"><label>Email <input name="user"></label><label>Password <input name="pass" type="password"></label><label>Confirm password <input name="confirm" type="password"></label><button>Next</button></form>'));
    if (url.pathname.startsWith("/pk")) return passkeyRoute(url, body, res);
    if (url.pathname === "/search") return res.end(page("Search", `<div><a href="${SITE}/go?u=${encodeURIComponent(DOCS)}">Docs for ${url.searchParams.get("q")}</a> The docs</div>`));
    if (url.pathname === "/docs") return res.end(page("Docs", "<h1>Docs</h1><p>The export button is under Settings.</p>"));
    res.statusCode = 404;
    res.end(page("Not found", ""));
  });
});

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  assert.ok(ImportedPlugin.validateImportedPluginHandler(HUB_ID), "the handler is where AnythingLLM looks");
  const plugin = ImportedPlugin.loadPluginByHubId(HUB_ID).plugin({ SEARCH_URL: `${SITE}/search?q={q}` });
  const call = async (args, thread = 7, workspace = "e2e") => {
    let fn;
    const agent = { handlerProps: { invocation: { workspace: { slug: workspace }, thread_id: thread }, log: (m) => console.error(m) }, introspect: () => {}, function: (def) => (fn = def) };
    plugin.setup(agent);
    assert.equal(fn.name, HUB_ID);
    return fn.handler.call(fn, args);
  };

  const opened = await call({ action: "open", url: `${SITE}/login` });
  assert.match(opened, /Page: Sign in/, opened);
  const ref = (label) => opened.match(new RegExp(`\\[(e\\d+)\\] ${label}`))[1];
  const [user, pass, submit] = [ref('input\\[text\\] "User'), ref('input\\[password\\] "Password'), ref('button "Sign in"')];
  assert.match(opened, /\[!\[Sign in\]\(\/browser-lean\/[\w-]+-card\.jpg\?v=\w+\)\]\(\/browser-lean\/[\w-]+\.html\)/, "the card");

  assert.match(await call({ action: "act", do: "fill", ref: pass, text: "nope" }), /password field, which act never types into/);
  assert.match(await call({ action: "login", user_ref: user, pass_ref: pass, submit_ref: submit }), /The user is asked on the tab's page/);

  // A thread's tab page: its settings, its state, and what it posts (written as AnythingLLM's
  // collector writes an upload), each applied by the next call.
  const storage = process.env.STORAGE_DIR || `${APP}/storage`;
  const tabPage = (thread) => {
    const { token } = JSON.parse(fs.readFileSync(`${storage}/browser-lean/e2e/tabs.json`, "utf8"))[String(thread)];
    const cfg = JSON.parse(fs.readFileSync(`${APP}/public/browser-lean/${token}.html`, "utf8").match(/const cfg = (\{.*?\});/)[1]);
    const state = () => JSON.parse(fs.readFileSync(`${APP}/public/browser-lean/${token}.json`, "utf8"));
    const seal = (text) => crypto.publicEncrypt({ key: crypto.createPublicKey({ key: Buffer.from(cfg.pub, "base64"), format: "der", type: "spki" }), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(text)).toString("base64");
    const events = `${storage}/documents/custom-documents`;
    const post = async (...steps) => {
      fs.mkdirSync(events, { recursive: true });
      for (const step of steps) {
        const event = { browser_lean_event: 1, workspace: "e2e", tab: String(thread), secret: cfg.secret, ...step };
        fs.writeFileSync(path.join(events, `raw-${cfg.title}-${crypto.randomUUID()}.json`), JSON.stringify({ pageContent: JSON.stringify(event) }));
        await new Promise((r) => setTimeout(r, 20)); // in order, as the page posts them
      }
      return call({ action: "read" }, thread);
    };
    return { state, seal, post };
  };
  // The Vault the tab pages link to, and its logins section: what it shows, and what it posts.
  const vaultPage = () => {
    const { token, secret } = JSON.parse(fs.readFileSync(`${storage}/vault-lean/vault-page.json`, "utf8"));
    const logins = () => JSON.parse(fs.readFileSync(`${APP}/public/vault-lean/${token}-logins.json`, "utf8")).logins;
    const post = (event) => {
      fs.mkdirSync(`${storage}/documents/custom-documents`, { recursive: true });
      fs.writeFileSync(path.join(`${storage}/documents/custom-documents`, `raw-vault-lean-logins-${crypto.randomUUID()}.json`), JSON.stringify({ pageContent: JSON.stringify({ vault_lean_event: 1, secret, ...event }) }));
    };
    return { token, logins, post };
  };
  const seven = tabPage(7);
  assert.equal(seven.state().need.kind, "login");
  const signedIn = await seven.post({ ev: "need-answer", user: "ada", sealed: seven.seal("e2e-pass-123"), save: true });
  assert.match(signedIn, /Page: Home/, signedIn);
  assert.match(signedIn, /Welcome, ada\./, "a username isn't a secret: only the password is hidden");
  assert.match(signedIn, /the login the user entered was saved for 127\.0\.0\.1, for next time/, "saved once the page no longer asks for a password");

  // ---- The user takes a tab over: taps the user field, types into it and the password, sealed,
  // then Enter; the page offers the login, they save it and hand the tab back.
  const eight = await call({ action: "open", url: `${SITE}/login` }, 8);
  const tab8 = tabPage(8);
  assert.match(await tab8.post({ ev: "take" }), /^The user has taken this tab over/);
  assert.match(await call({ action: "act", do: "click", ref: eight.match(/\[(e\d+)\] button "Sign in"/)[1] }, 8), /^Browser: the user has taken the tab over/);
  const fields = tab8.state().fields;
  const [userField, passField] = [fields.find((f) => f.kind === "text"), fields.find((f) => f.kind === "password")];
  assert.ok(userField && passField, `the fields in view: ${JSON.stringify(fields)}`);
  await tab8.post({ ev: "tap", x: userField.x + 5, y: userField.y + 5 }, { ev: "type", ref: userField.ref, text: "bea", then: "Tab" }, { ev: "type", ref: passField.ref, sealed: tab8.seal("e2e-pass-456"), then: "Enter" });
  const offered = tab8.state();
  assert.equal(offered.title, "Home", "Enter sent the form");
  assert.deepEqual(offered.offer, { kind: "password", site: "127.0.0.1", user: "bea" });
  await tab8.post({ ev: "offer", save: true });
  assert.ok(vaultPage().logins().some((l) => l.user === "bea"), "saved, and listed on the Vault");
  const handedBack = await tab8.post({ ev: "give" });
  assert.match(handedBack, /handed it back to you/);
  assert.match(handedBack, /Welcome, •••\./, "what the user typed is hidden from the agent");
  assert.equal(tab8.state().who, "agent");

  // ---- Passkeys: one the page makes while the agent has the tab is taken out again; one made
  // while the user holds it is offered and saved, and signs in from another tab, the site checking
  // its signature and count; deleted on the Vault, it signs in no more.
  const said = (reply) => reply.match(/Not signed in|Passkey added|Signed in with a passkey, count \d+|Passkey refused: \w+|Refused/)?.[0];
  const nine = await call({ action: "open", url: PASSKEYS }, 9);
  const add = nine.match(/\[(e\d+)\] button "Add a passkey"/)[1];
  const byAgent = (await call({ action: "act", do: "click", ref: add }, 9)) + (await call({ action: "read" }, 9));
  assert.match(byAgent, /made a passkey for localhost while you had the tab, and it was taken out again/, byAgent);
  const tab9 = tabPage(9);
  await tab9.post({ ev: "take" }, { ev: "tap", x: 20, y: 20 });
  for (let i = 0; !tab9.state().offer && i < 20; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(tab9.state().offer, { kind: "passkey", site: "localhost", user: "" });
  await tab9.post({ ev: "offer", save: true }, { ev: "give" });
  assert.ok(vaultPage().logins().some((l) => l.kind === "passkey" && l.site === "localhost"));

  const ten = await call({ action: "open", url: PASSKEYS }, 10);
  const signIn = ten.match(/\[(e\d+)\] button "Sign in with a passkey"/)[1];
  const read10 = async () => (await call({ action: "act", do: "click", ref: signIn }, 10)) + (await new Promise((r) => setTimeout(r, 300)), await call({ action: "read" }, 10));
  const first = await read10();
  assert.match(first, /Signed in with a passkey, count \d+/, first);
  assert.match(first, /the page signed in with the passkey saved for localhost/);
  assert.match(await read10(), /Signed in with a passkey, count \d+/, "the count went forward, so the site takes it again");
  const vault = vaultPage();
  assert.equal(new URL(`http://x${tabPage(10).state().vault}`).pathname, `/vault-lean/${vault.token}.html`, "the tab's page links to the Vault");
  vault.post({ ev: "login-delete", id: vault.logins().find((l) => l.kind === "passkey").id });
  assert.match(await read10(), /Passkey refused: NotAllowedError/, "deleted on the Vault, it signs in no more");
  assert.deepEqual(passkeys.log, ["registered", "registered", "signed in", "signed in"]);

  // ---- Fields in a shadow root, "Show password", a form that needs more than the login, and a new
  // account's "Confirm password".
  const refIn = (text, label) => text.match(new RegExp(`\\[(e\\d+)\\] ${label}`))[1];
  const shadow = await call({ action: "open", url: `${SITE}/shadow` }, 11);
  const inShadow = await call({ action: "login", user_ref: refIn(shadow, 'input\\[text\\] "User'), pass_ref: refIn(shadow, 'input\\[password\\]'), submit_ref: refIn(shadow, 'button "Sign in"') }, 11);
  assert.match(inShadow, /Page: Home/, `a saved login typed into a shadow root's fields: ${inShadow}`);

  const show = await call({ action: "open", url: `${SITE}/show` }, 12);
  const shownPass = refIn(show, 'input\\[password\\]');
  await call({ action: "act", do: "check", ref: refIn(show, 'input\\[checkbox\\]') }, 12);
  const shown = await call({ action: "read" }, 12);
  assert.match(shown, new RegExp(`\\[${shownPass}\\] input\\[password\\]`), "still read as a password field once shown");
  assert.match(await call({ action: "act", do: "fill", ref: shownPass, text: "e2e-pass-123" }, 12), /password field, which act never types into/);

  const captcha = await call({ action: "open", url: `${SITE}/captcha` }, 13);
  const unsent = await call({ action: "login", user_ref: refIn(captcha, 'input\\[text\\] "User'), pass_ref: refIn(captcha, 'input\\[password\\]'), submit_ref: refIn(captcha, 'button "Sign in"') }, 13);
  assert.match(unsent, /, but e\d+ wasn't clicked: the page still needs e\d+ "Digits in the image" first/, unsent);
  assert.match(unsent, /Page: Sign in/, "not sent");

  const signup = await call({ action: "open", url: `${SITE}/signup` }, 14);
  assert.match(await call({ action: "login", user_ref: refIn(signup, 'input\\[text\\] "Email'), pass_ref: refIn(signup, 'input\\[password\\] "Password'), confirm_ref: refIn(signup, 'input\\[password\\] "Confirm'), submit_ref: refIn(signup, 'button "Next"') }, 14), /needs a password for the new account/);
  const tab14 = tabPage(14);
  assert.equal(tab14.state().need.confirm, true);
  assert.match(await tab14.post({ ev: "need-answer", user: "dana", sealed: tab14.seal("e2e-new-789"), save: true }), /Page: Welcome/, "the same password in both fields");

  // ---- A cookie dialog that makes the page behind it inert, a date field, and a code taken on a
  // new page whose first ref is something else.
  const consent = await call({ action: "open", url: `${SITE}/consent` }, 15);
  assert.match(consent, /Elements \(\d+\):\n\[e\d+\] button "Reject all"/, `the dialog's buttons first: ${consent}`);
  assert.match(consent, /input\[text\] "User" \(behind a dialog\)/);
  const login15 = { user_ref: refIn(consent, 'input\\[text\\] "User'), pass_ref: refIn(consent, "input\\[password\\]"), submit_ref: refIn(consent, 'button "Sign in"') };
  assert.match(await call({ action: "login", ...login15 }, 15), /is behind a dialog \("Cookies on this site"; its buttons: e\d+ "Reject all", e\d+ "Accept all"\)/);
  await call({ action: "act", do: "click", ref: refIn(consent, 'button "Reject all"') }, 15);
  assert.match(await call({ action: "login", ...login15 }, 15), /Page: Home/, "the saved login, once the dialog is closed");

  const dob = await call({ action: "open", url: `${SITE}/dob` }, 16);
  const dobRef = refIn(dob, 'input\\[date\\]');
  assert.match(await call({ action: "act", do: "fill", ref: dobRef, text: "05/01/1990" }, 16), /a date field takes its value as YYYY-MM-DD/);
  const dated = await call({ action: "act", do: "fill", ref: dobRef, text: "1990-05-01" }, 16);
  assert.match(dated, /input\[date\] "Date of birth" value="1990-05-01"/, dated);
  assert.match(dated, /button "Next"\n/, "the page saw it: Next is enabled");

  const code = await call({ action: "open", url: `${SITE}/code` }, 17);
  const codeRef = refIn(code, 'input\\[text\\] "Code');
  assert.match(await call({ action: "login", what: "code", ref: codeRef, submit_ref: refIn(code, 'button "Verify"') }, 17), /The code sent to your phone/);
  const tab17 = tabPage(17);
  const wrong = await tab17.post({ ev: "need-answer", text: "000000" });
  assert.match(wrong, /the page still asks for the code/, "the same field after a wrong code: asked again");
  const taken = await tab17.post({ ev: "need-answer", text: "123456" });
  assert.match(taken, /Page: Account/, taken);
  assert.doesNotMatch(taken, /still asks for the code/, `${codeRef} on the new page is a link, not the code field`);
  assert.equal(tab17.state().need, null);

  const found = await call({ action: "search", query: "export" });
  assert.match(found, /1\. Docs for export\n {3}http:\/\/localhost:\d+\/docs/, found);
  assert.match(await call({ action: "look", url: DOCS, find: "export" }), /The export button is under Settings\./);
  assert.match(await call({ action: "open", url: "http://10.1.2.3/" }), /isn't a public address/);

  // Signed in, the browser closes (past three browsers, the oldest does) and starts again signed in.
  assert.match(await call({ action: "open", url: `${SITE}/me` }), /Signed in\./);
  for (const other of ["e2e-2", "e2e-3", "e2e-4"]) await call({ action: "open", url: DOCS }, 1, other);
  assert.ok(!fs.readFileSync(path.join(storage, "vault-lean", "sealed", "session-e2e.json"), "utf8").includes("sid"), "the cookie is sealed beside the vault");
  assert.ok(!fs.existsSync(path.join(storage, "browser-lean", "e2e", "profile")), "no profile in the storage");
  assert.match(await call({ action: "open", url: `${SITE}/me` }), /Signed in\./, "signed in again after the restart");

  server.close();
  console.log("ok");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
