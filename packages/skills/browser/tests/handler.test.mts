// The skill as the agent uses it: the built handler.js (build/browser-lean, what AnythingLLM loads)
// driving the stand-in Puppeteer (fixtures/puppeteer). Each test uses a workspace of its own, since
// the browsers are kept per process as AnythingLLM's are. `npm run skills:test` builds it first.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as logins from "#shared/logins";
import * as vault from "#shared/vault";
import { call as called, post, publicDir, seal, site, skillDir, storage, tabConfig, tabState, world } from "./harness.mts";

const LOGIN = "https://login.example/";
site(LOGIN, {
  title: "Sign in",
  text: "Sign in to Example",
  fields: { e1: { type: "text", name: "Email" }, e2: { type: "password", name: "Password" }, e3: { kind: "button", name: "Sign in" }, e4: { type: "text", name: "Code" } },
  onclick: { e3: "https://login.example/home" },
});
site("https://login.example/home", { title: "Home", text: "Welcome back. Your password was pw-s3cret-1 (a site that shows it)." });
site("https://shop.example/", { title: "Shop", text: "Pasta 2.50\nRice 1.20", fields: { e1: { type: "search", name: "Search" }, e2: { kind: "button", name: "Go" } }, onclick: { e2: "https://shop.example/results" } });
site("https://shop.example/results", { title: "Results", text: "1 result for pasta" });

const lastPage = () => world.pages[world.pages.length - 1];
const inWorkspace = (workspace: string) => (args: Record<string, unknown>) => called(args, { workspace });
const SIGN_IN = { e1: { type: "text", name: "Email" }, e2: { type: "password", name: "Password" }, e3: { kind: "button", name: "Sign in" } };

test("open reads the page with refs and ends with the tab's card, whose page and picture are written", async () => {
  const call = (args: Record<string, unknown>) => called(args, { workspace: "open", base: "https://ai.example" });
  const opened = await call({ action: "open", url: "https://shop.example/" });
  assert.match(opened, /^Opened https:\/\/shop\.example\/ in this chat's tab\.\n\nPage: Shop\nAddress: https:\/\/shop\.example\/\n\nElements \(2\):\n\[e1\] input\[search\] "Search"\n\[e2\] button "Go"/);
  const link = opened.match(/\[!\[Shop\]\((https:\/\/ai\.example\/browser-lean\/([\w-]+))-card\.jpg\?v=\w+\)\]\(\1\.html\)/);
  assert.ok(link, "a card that opens the tab's page");
  for (const ending of [".jpg", "-card.jpg", ".json", ".html"]) assert.ok(fs.existsSync(path.join(publicDir, "browser-lean", `${link[2]}${ending}`)), ending);
  assert.match(await call({ action: "read", find: "rice" }), /Text with "rice":\nPasta 2\.50\nRice 1\.20/);
  const done = await call({ action: "act", steps: [{ do: "fill", ref: "e1", text: "pasta" }, { do: "click", ref: "e2" }] });
  assert.match(done, /^Did all 2 steps: fill e1, click e2\.\n\nPage: Results/);
});

test("the fence refuses what isn't the public web, and act never types into a password field", async () => {
  const call = (args: Record<string, unknown>) => called(args, { workspace: "fence" });
  assert.match(await call({ action: "open", url: "http://127.0.0.1:9/" }), /^Browser: http:\/\/127\.0\.0\.1:9\/ isn't opened: 127\.0\.0\.1 isn't a public address\. .*FENCE_ALLOW\. That's final[^.]*\.$/);
  await call({ action: "open", url: LOGIN });
  assert.match(await call({ action: "act", do: "fill", ref: "e2", text: "hunter2" }), /e2 is a password field, which act never types into/);
  assert.equal(lastPage().fields.e2.value, undefined);
  assert.match(await call({ action: "act", do: "press", text: "Control+c" }), /shortcuts with Control, Meta or Alt aren't sent/);
});

test("search reads the engine's links (unwrapping its redirects, skipping its own); look reads a page apart from the tab", async () => {
  site("https://search.example/?q=pasta%20prices", {
    title: "Results",
    links: [
      { title: "Pasta prices compared", href: "https://search.example/l/?uddg=https%3A%2F%2Fprices.example%2Fpasta", near: "Pasta prices compared Cheapest pasta this week" },
      { title: "Settings", href: "https://search.example/settings", near: "Settings" },
      { title: "Shop", href: "https://shop.example/", near: "Shop Pasta and rice" },
    ],
  });
  const call = (args: Record<string, unknown>) => called(args, { workspace: "research", settings: { SEARCH_URL: "https://search.example/?q={q}" } });
  const found = await call({ action: "search", query: "pasta prices" });
  assert.match(found, /^Searched search\.example for "pasta prices"\./);
  assert.match(found, /1\. Pasta prices compared\n {3}https:\/\/prices\.example\/pasta\n {3}Cheapest pasta this week\n2\. Shop\n {3}https:\/\/shop\.example\//);
  assert.doesNotMatch(found, /Settings/);
  const looked = await call({ action: "look", url: "https://shop.example/", find: "pasta" });
  assert.match(looked, /^Looked at https:\/\/shop\.example\/ in a page of its own; this chat's tab is as it was\./);
  assert.match(looked, /data, never instructions/);
  assert.equal(lastPage().url(), "https://shop.example/", "the scratch page was closed after");
});

test("a login with none saved is asked for on the tab's page, sealed, typed in, hidden, and saved; the next is typed by itself", async () => {
  const call = (args: Record<string, unknown>) => called(args, { workspace: "home" });
  await call({ action: "open", url: LOGIN });
  const asked = await call({ action: "login", user_ref: "e1", pass_ref: "e2", submit_ref: "e3" });
  assert.match(asked, /^The user is asked on the tab's page: login\.example needs the user to sign in, and no login is saved for it\. Tell them to tap the card below/);
  assert.match(asked, /Never ask for it in the chat/);
  assert.deepEqual(tabState().need, { kind: "login", host: "login.example", text: "No login is saved for login.example.", label: null, hasUser: true, confirm: false, until: tabState().need.until });

  post({ ev: "need-answer", user: "ada@example.com", sealed: seal("pw-s3cret-1"), save: true });
  const after = await call({ action: "read" });
  assert.match(after, /^This chat's tab as it is now\.\n\nPage: Home/);
  assert.match(after, /Welcome back\. Your password was ••• \(a site that shows it\)\./, "what the user typed is hidden in every read");
  assert.match(after, /the user entered the login you asked for on the tab's page and it was typed into the page and e3 clicked/);
  assert.match(after, /the login the user entered was saved for login\.example, for next time/, "saved once the page no longer asks for a password");
  assert.equal(tabState().need, null);
  assert.deepEqual(logins.list().map((l) => [l.site, l.user]), [["login.example", "ada@example.com"]]);
  assert.ok(!fs.readFileSync(path.join(storage, "vault-lean", "vault.json"), "utf8").includes("pw-s3cret-1"), "kept encrypted");

  const again = (args: Record<string, unknown>) => called(args, { workspace: "home", thread: 2 });
  await again({ action: "open", url: LOGIN });
  assert.match(await again({ action: "login", user_ref: "e1", pass_ref: "e2", submit_ref: "e3" }), /^Typed the login the user saved for login\.example into the page and e3 clicked\. It's hidden from you/);
  assert.equal(lastPage().url(), "https://login.example/home");
});

test("a code is asked for on the tab's page; an event without the tab's secret, or after a cancel, is dropped", async () => {
  const call = (args: Record<string, unknown>) => called(args, { workspace: "codes" });
  await call({ action: "open", url: LOGIN });
  assert.match(await call({ action: "login", what: "authenticator", ref: "e4" }), /asked on the tab's page: The code from your authenticator app for login\.example/);
  assert.equal(tabState("codes").need.text, "For login.example.", "the page's words, under a title that is already the code's");
  assert.match(await call({ action: "login", what: "pigeon", ref: "e4" }), /what: code, authenticator, sms, email/);
  const opts = { workspace: "codes" };
  post({ ev: "need-answer", text: "999999", secret: "not-the-tab's" }, opts);
  await call({ action: "read" });
  assert.equal(lastPage().fields.e4.value, undefined, "a forged event does nothing");
  post({ ev: "need-answer", text: "123456" }, opts);
  assert.match(await call({ action: "read" }), /entered the code you asked for .* but nothing was submitted: submit it with act/);
  assert.equal(lastPage().fields.e4.value, "123456");

  await call({ action: "login", what: "sms", ref: "e4" });
  post({ ev: "need-cancel" }, opts);
  assert.match(await call({ action: "read" }), /the user chose not to enter it now/);
  post({ ev: "need-answer", text: "000000" }, opts);
  await call({ action: "read" });
  assert.equal(lastPage().fields.e4.value, "123456", "nothing waits for it any more");
});

test("call goes from the tab with its session only; the library calls APIs with keys", async () => {
  const call = (args: Record<string, unknown>) => called(args, { workspace: "calls" });
  await call({ action: "open", url: "https://shop.example/" });
  world.apis["https://shop.example/api/me"] = { status: 200, headers: { "content-type": "application/json" }, text: '{"name":"Ada","plan":{"tier":"pro"}}', cut: false };
  assert.match(await call({ action: "call", url: "https://shop.example/api/me" }), /give auth "session"\. A call to an API with a key is the library skill's/);
  const got = await call({ action: "call", url: "https://shop.example/api/me", auth: "session", keep: "plan.tier" });
  assert.match(got, /^GET https:\/\/shop\.example\/api\/me \(with the tab's session\)\nStatus: 200/);
  assert.match(got, /Kept plan\.tier: pro/);
  assert.equal(world.fetched.at(-1)!.from, "https://shop.example/");
  assert.match(await call({ action: "call", url: "https://shop.example/api/me", auth: "session", headers: { Cookie: "x" } }), /can't set Cookie/);
});

test("a saved login is set whole into the page's own fields, never typed key by key; a frame, or a page that moved, gets nothing", async () => {
  const call = inWorkspace("fills");
  site("https://fills.example/", { title: "Sign in", fields: { e1: { type: "text", name: "User" }, e2: { type: "password", name: "Password" } } });
  site("https://fills.example/framed", { title: "Sign in", fields: { e1: { type: "password", name: "Password", framed: "ads.example" } } });
  site("https://fills.example/moved", { title: "Sign in", fields: { e1: { type: "password", name: "Password", movedTo: "evil.example" } } });
  await logins.save("fills.example", "bo", "pw-fills-1");
  await call({ action: "open", url: "https://fills.example/" });
  assert.match(await call({ action: "login", user_ref: "e1", pass_ref: "e2" }), /^Typed the login the user saved for fills\.example into the page, but nothing was submitted/);
  const page = lastPage();
  assert.deepEqual([page.fields.e1.value, page.fields.e2.value], ["bo", "pw-fills-1"]);
  assert.deepEqual(page.typed, [], "no keystrokes, which a page moving the focus could send elsewhere");

  await call({ action: "open", url: "https://fills.example/framed" });
  assert.match(await call({ action: "login", pass_ref: "e1" }), /that field is in a frame inside the page, not on fills\.example's page itself; nothing was typed/);
  assert.equal(lastPage().fields.e1.value, undefined);
  await call({ action: "open", url: "https://fills.example/moved" });
  assert.match(await call({ action: "login", pass_ref: "e1" }), /the page moved off fills\.example meanwhile; nothing was typed/);
  assert.equal(lastPage().fields.e1.value, undefined);
});

test("the tab's page links to the Vault once the library has shown it", async () => {
  const call = inWorkspace("vaultlink");
  await call({ action: "open", url: "https://shop.example/" });
  assert.equal(tabState("vaultlink").vault, null, "no Vault yet");
  vault.setPagePath("/library-lean/tok-vault.html");
  await call({ action: "read" });
  assert.equal(tabState("vaultlink").vault, "/library-lean/tok-vault.html");
});

test("the lean browser's vaults are imported once: logins, passkeys and keys, not OAuth, none twice", async () => {
  const lean = path.join(storage, "browser-lean", "old");
  fs.mkdirSync(lean, { recursive: true });
  fs.rmSync(path.join(storage, "browser-lean", ".imported"), { force: true });
  (globalThis as Record<symbol, { imported: boolean }>)[Symbol.for("anythingllm-suite.browser-lean.state")].imported = false; // as after a restart
  const key = Buffer.from(crypto.hkdfSync("sha256", "test-sig-key", "test-sig-salt", "browser-lean vault", 32));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const leanLogins = [
    { id: "a", kind: "password", site: "old.example", user: "ada", pass: "old-pass" },
    { id: "b", kind: "key", site: "api.old.example", user: "old-api", value: "k-123", writes: false },
    { id: "c", kind: "oauth", site: "mail.example", user: "mail", oauth: {} },
    { id: "d", site: "older.example", user: "bob", pass: "p" },
    { id: "e", kind: "passkey", site: "keys.old.example", user: "ada", credential: { credentialId: "old-cred", rpId: "keys.old.example", privateKey: "old-private-key", signCount: 3, isResidentCredential: true } },
  ];
  const data = Buffer.concat([cipher.update(JSON.stringify({ priv: null, logins: leanLogins }), "utf8"), cipher.final()]);
  fs.writeFileSync(path.join(lean, "vault.json"), JSON.stringify({ pub: null, box: { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") } }));
  await called({ action: "guide" }, { workspace: "imports" });
  await called({ action: "guide" }, { workspace: "imports" });
  await called({ action: "open", url: "https://shop.example/" }, { workspace: "imports" });
  const sites = logins.list().map((l) => l.site).sort();
  assert.ok(sites.includes("old.example") && sites.includes("older.example"), "passwords, and a login saved before kinds");
  assert.equal(sites.filter((s: string) => s === "old.example").length, 1, "once");
  assert.ok(logins.list().some((l) => l.kind === "passkey" && l.site === "keys.old.example"), "a passkey");
  assert.equal(world.pages.at(-1)!.session!.credentials.get("old-cred")?.signCount, 3, "and it's in the tab's authenticator");
  const vault = fs.readFileSync(path.join(storage, "vault-lean", "vault.json"), "utf8");
  assert.ok(!vault.includes("old-pass") && !vault.includes("old-private-key"), "kept encrypted");
});

test("guide gives the overview, each topic it lists, and names the topics when one isn't there", async () => {
  const overview = await called({ action: "guide" }, { workspace: "guide" });
  const topics = [...overview.matchAll(/^- `(\w+)`/gm)].map((m) => m[1]);
  assert.deepEqual(topics.sort(), fs.readdirSync(path.join(skillDir, "static", "guide")).map((f) => f.slice(0, -3)).filter((f) => f !== "index").sort());
  for (const topic of topics) assert.doesNotMatch(await called({ action: "guide", topic }, { workspace: "guide" }), /^Browser:/, topic);
  assert.match(await called({ action: "guide", topic: "nothing" }, { workspace: "guide" }), /no topic "nothing"; the topics are: /);
  assert.match(await called({ action: "fly" }, { workspace: "guide" }), /^The browser's action is guide, search, look, open, read, act, login, call, not "fly"\.$/);
});

test("a chat with no thread (AnythingLLM's developer API) gets the workspace's own tab", async () => {
  await called({ action: "open", url: "https://shop.example/" }, { workspace: "api", thread: null });
  assert.ok(JSON.parse(fs.readFileSync(path.join(storage, "browser-lean", "api", "tabs.json"), "utf8"))._, "the tab \"_\"");
});

test("a workspace's cookies are kept in the vault and given back, and Chrome's profile is never in the storage", async () => {
  const oldProfile = path.join(storage, "browser-lean", "keep", "profile");
  fs.mkdirSync(path.join(oldProfile, "Default"), { recursive: true });
  await called({ action: "open", url: "https://shop.example/" }, { workspace: "keep" });
  const first = world.launched.at(-1) as { options: { userDataDir: string }; cookies: Record<string, unknown>[] };
  assert.ok(!first.options.userDataDir.startsWith(storage), "the profile is a temporary folder");
  for (let i = 0; i < 50 && fs.existsSync(oldProfile); i++) await new Promise((r) => setTimeout(r, 20)); // removed in the background
  assert.ok(!fs.existsSync(oldProfile), "the profile kept in the storage before is gone");
  const now = Date.now() / 1000;
  first.cookies.push(
    { name: "sid", value: "s-123", domain: "shop.example", path: "/", expires: now + 3600, size: 9, httpOnly: true, secure: true, session: false, sameSite: "Lax" },
    { name: "cart", value: "c-1", domain: "shop.example", path: "/", expires: -1, session: true },
    { name: "old", value: "o-1", domain: "shop.example", path: "/", expires: now - 60, session: false },
    { name: "embed", value: "e-1", domain: "widget.example", path: "/", expires: now + 60, session: false, partitionKey: "https://shop.example" },
  );
  for (const other of ["keep-2", "keep-3", "keep-4"]) await called({ action: "open", url: "https://shop.example/" }, { workspace: other }); // past 3 browsers, the oldest closes
  const sealed = fs.readFileSync(path.join(storage, "vault-lean", "sealed", "session-keep.json"), "utf8");
  assert.ok(!sealed.includes("s-123"), "sealed beside the vault, not in clear");
  await called({ action: "open", url: "https://shop.example/" }, { workspace: "keep" });
  const again = world.launched.at(-1) as { cookies: Record<string, unknown>[] };
  assert.notEqual(again, first);
  assert.deepEqual(
    again.cookies.map((c) => [c.name, c.value, "expires" in c, "size" in c]),
    [["cart", "c-1", false, false], ["sid", "s-123", true, false]],
    "unexpired, unpartitioned, as setCookies takes them",
  );
});

test("a login the site seems to refuse is said on the tab's page and asked again, and not saved", async () => {
  site("https://strict.example/", { title: "Sign in", fields: SIGN_IN });
  const call = inWorkspace("strict");
  await call({ action: "open", url: "https://strict.example/" });
  await call({ action: "login", user_ref: "e1", pass_ref: "e2", submit_ref: "e3" });
  const first = tabState("strict").need.until;
  post({ ev: "need-answer", user: "ada@example.com", sealed: seal("wrong-pw-1", tabConfig("strict").pub), save: true }, { workspace: "strict" });
  assert.match(await call({ action: "read" }), /e3 clicked, but the page still asks for a password: the site may have refused it\. The user is asked again on the tab's page/);
  const { need } = tabState("strict");
  assert.equal(need.kind, "login", "asked again");
  assert.equal(need.text, "strict.example still asks for a password: it may not have been accepted. Check it and enter it again", "and told why, on the request itself");
  assert.ok(need.until >= first);
  site("https://strict.example/about", { title: "About", text: "About us" });
  await call({ action: "open", url: "https://strict.example/about" }); // on its site, no password asked: where an agreed login is kept
  assert.ok(!logins.list().some((l) => l.site === "strict.example"), "the refused login isn't saved");

  // A sign-in page that comes back as a new page, its fields new: said, but not asked again by itself.
  site("https://retry.example/", { title: "Sign in", fields: SIGN_IN, onclick: { e3: "https://retry.example/again" } });
  site("https://retry.example/again", { title: "Try again", text: "Wrong password.", fields: { e7: { type: "password", name: "Password" } } });
  const other = inWorkspace("retry");
  await other({ action: "open", url: "https://retry.example/" });
  await other({ action: "login", user_ref: "e1", pass_ref: "e2", submit_ref: "e3" });
  post({ ev: "need-answer", user: "ada@example.com", sealed: seal("wrong-pw-2", tabConfig("retry").pub) }, { workspace: "retry" });
  assert.match(await other({ action: "read" }), /the page still asks for a password: the site may have refused it\. Read the page, tell the user, and use login again/);
  const after = tabState("retry");
  assert.match(after.msg.text, /Take the tab over to try again, or ask the agent to\./, "kept past the agent's own read");
  assert.ok(after.msg.id > 0, "with an id the page shows it once by");
  assert.equal(after.need, null);
});

test("a field read as a password stays one after Show password, and login takes only a field for the username", async () => {
  site("https://shown.example/", {
    title: "Enter your password",
    fields: { e1: { kind: "link", name: "Not you?" }, e2: { type: "text", name: "Password", attrs: { "data-bw-secret": "1" } }, e4: { kind: "button", name: "Sign in" } },
  });
  const call = inWorkspace("shown");
  await call({ action: "open", url: "https://shown.example/" });
  assert.match(await call({ action: "act", steps: [{ do: "fill", ref: "e2", text: "pw-shown-1" }] }), /e2 is a password field, which act never types into/);
  assert.equal(lastPage().fields.e2.value, undefined);
  assert.match(await call({ action: "login", user_ref: "e1", pass_ref: "e2", submit_ref: "e4" }), /e1 is a link, not a field for the username: .* leave it out on a page that asks only for the password/);
  assert.match(await call({ action: "login", pass_ref: "e2", submit_ref: "e4" }), /asked on the tab's page/);
  assert.equal(tabState("shown").need.hasUser, false);
});

test("a new account's password is asked for with confirm_ref and typed into both fields", async () => {
  site("https://signup.example/", {
    title: "Create account",
    fields: { e1: { type: "email", name: "Email" }, e2: { type: "password", name: "Password" }, e3: { type: "password", name: "Confirm password" }, e4: { kind: "button", name: "Next" }, e5: { kind: "button", name: "Back" } },
  });
  const call = inWorkspace("signup");
  await call({ action: "open", url: "https://signup.example/" });
  assert.match(await call({ action: "login", user_ref: "e1", pass_ref: "e2", confirm_ref: "e5", submit_ref: "e4" }), /e5 isn't a password field; confirm_ref is a new account's "Confirm password"/);
  assert.match(await call({ action: "login", user_ref: "e1", pass_ref: "e2", confirm_ref: "e3", submit_ref: "e4" }), /^The user is asked on the tab's page: signup\.example needs a password for the new account, which the user chooses\./);
  assert.equal(tabState("signup").need.confirm, true);
  assert.equal(tabState("signup").need.text, "For a new account on signup.example.");
  const page = lastPage();
  post({ ev: "need-answer", user: "dana@example.com", sealed: seal("pw-new-1", tabConfig("signup").pub), save: true }, { workspace: "signup" });
  assert.match(await call({ action: "read" }), /it was typed into the page and e4 clicked/);
  assert.deepEqual([page.fields.e1.value, page.fields.e2.value, page.fields.e3.value], ["dana@example.com", "pw-new-1", "pw-new-1"]);
  assert.deepEqual(page.clicks.slice(-1), ["e4"]);
});

test("a login typed into a form that still needs something else (a CAPTCHA) isn't sent, and the page says what's missing", async () => {
  site("https://captcha.example/", {
    title: "Sign in",
    fields: { ...SIGN_IN, e3: { ...SIGN_IN.e3, blockedBy: ["e4"] }, e4: { type: "text", name: "Type the digits shown" } },
    onclick: { e3: "https://captcha.example/home" },
  });
  const call = inWorkspace("captcha");
  await call({ action: "open", url: "https://captcha.example/" });
  await call({ action: "login", user_ref: "e1", pass_ref: "e2", submit_ref: "e3" });
  post({ ev: "need-answer", user: "ada@example.com", sealed: seal("pw-cap-1", tabConfig("captcha").pub) }, { workspace: "captcha" });
  const after = await call({ action: "read" });
  assert.match(after, /but e3 wasn't clicked: the page still needs e4 "Type the digits shown" first/);
  assert.doesNotMatch(after, /may have refused/);
  assert.equal(lastPage().url(), "https://captcha.example/", "not sent");
  assert.equal(tabState("captcha").msg.text, 'Your login is in; the page still needs "Type the digits shown" before it can be sent: take the tab over to fill it');
});

test("a field behind a dialog isn't typed into or clicked: the dialog and its buttons are named, and login doesn't ask", async () => {
  const behind = { title: "We value your privacy", buttons: [{ ref: "e5", label: "Accept all" }, { ref: "e6", label: "Reject all" }] };
  site("https://consent.example/", {
    title: "Log in",
    fields: { e1: { ...SIGN_IN.e1, behind }, e2: { ...SIGN_IN.e2, behind }, e3: { ...SIGN_IN.e3, behind }, e5: { kind: "button", name: "Accept all" }, e6: { kind: "button", name: "Reject all" } },
  });
  const call = inWorkspace("consent");
  await call({ action: "open", url: "https://consent.example/" });
  const filled = await call({ action: "act", do: "fill", ref: "e1", text: "ada@example.com" });
  assert.match(filled, /e1 is behind a dialog \("We value your privacy"; its buttons: e5 "Accept all", e6 "Reject all"\), so nothing reaches it: close the dialog first/);
  assert.equal(lastPage().fields.e1.value, undefined);
  assert.match(await call({ action: "act", do: "click", ref: "e3" }), /e3 is behind a dialog/);
  assert.match(await call({ action: "login", user_ref: "e1", pass_ref: "e2", submit_ref: "e3" }), /e2 is behind a dialog/);
  assert.equal(tabState("consent").need, null, "nothing asked of the user while the page can't take it");
});

test("a submit the page keeps disabled isn't clicked, and both the agent and the user are told", async () => {
  site("https://gate.example/", { title: "Sign in", fields: { ...SIGN_IN, e3: { ...SIGN_IN.e3, disabled: true } }, onclick: { e3: "https://gate.example/home" } });
  const call = inWorkspace("gate");
  await call({ action: "open", url: "https://gate.example/" });
  await call({ action: "login", user_ref: "e1", pass_ref: "e2", submit_ref: "e3" });
  post({ ev: "need-answer", user: "ada@example.com", sealed: seal("pw-gate-1", tabConfig("gate").pub) }, { workspace: "gate" });
  const after = await call({ action: "read" });
  assert.match(after, /but e3 wasn't clicked: the page keeps it disabled, so it wants something else first\. .*"verify you are human"/);
  assert.ok(!lastPage().clicks.includes("e3"), "not sent");
  assert.equal(tabState("gate").msg.text, "Your login is in; the page still needs something else before it can be sent: take the tab over to finish it");
});

test("a date field is set whole, as YYYY-MM-DD, and another format is refused", async () => {
  site("https://wizard.example/", { title: "Profile", fields: { e1: { type: "date", name: "Date of birth" } } });
  const call = inWorkspace("wizard");
  await call({ action: "open", url: "https://wizard.example/" });
  assert.match(await call({ action: "act", do: "fill", ref: "e1", text: "05/01/1990" }), /a date field takes its value as YYYY-MM-DD; "05\/01\/1990" isn't that/);
  assert.match(await call({ action: "act", do: "fill", ref: "e1", text: "1990-05-01" }), /^Did fill e1\./);
  assert.equal(lastPage().fields.e1.value, "1990-05-01");
});

test("a code taken on a new page isn't asked again for the same ref there; one the page still asks for is", async () => {
  site("https://step.example/code", {
    title: "Two-step",
    text: "Check your phone: we sent a code by text message.",
    fields: { e4: { type: "text", name: "Authentication code" }, e6: { kind: "button", name: "Verify" }, e7: { kind: "button", name: "Resend" } },
    onclick: { e6: "https://step.example/account" },
  });
  site("https://step.example/account", { title: "Account", fields: { e4: { kind: "link", name: "Create API key" } } });
  const call = inWorkspace("step");
  await call({ action: "open", url: "https://step.example/code" });
  const asked = await call({ action: "login", what: "code", ref: "e4", submit_ref: "e6" });
  assert.match(asked, /The code sent to your phone for step\.example/, "the page's words choose which code");
  assert.match(asked, /\n\[!\[Two-step\][^\n]*\n[\s\S]*\nPage: Two-step/, "the card before the read while the user is asked");
  post({ ev: "need-answer", text: "123456" }, { workspace: "step" });
  const after = await call({ action: "read" });
  assert.doesNotMatch(after, /may not have been accepted|may have refused/);
  assert.equal(tabState("step").need, null);
  // The same field, still there: asked again.
  await call({ action: "open", url: "https://step.example/code" });
  await call({ action: "login", what: "sms", ref: "e4", submit_ref: "e7" });
  post({ ev: "need-answer", text: "654321" }, { workspace: "step" });
  assert.match(await call({ action: "read" }), /the page still asks for the code: the site may have refused it/);
  assert.match(tabState("step").need.text, /Check it and enter it again/);
});

test("a read of a page with a password or a code field points to login", async () => {
  site("https://sudo.example/", { title: "Confirm it's you", fields: { e1: { type: "password", name: "Password" }, e2: { kind: "button", name: "Confirm" } } });
  site("https://otp.example/", { title: "Verify", fields: { e1: { type: "text", name: "Verification code" } } });
  const call = inWorkspace("hint");
  assert.match(await call({ action: "open", url: "https://sudo.example/" }), /This page has a password field: to sign in or confirm it's you, use login\./);
  assert.match(await call({ action: "open", url: "https://otp.example/" }), /This page asks for a code: use login with what/);
  assert.doesNotMatch(await call({ action: "open", url: "https://shop.example/" }), /use login/);
});

test("a check that a person is at the browser isn't clicked or ticked by the agent", async () => {
  site("https://gate2.example/", { title: "Sign in", fields: { ...SIGN_IN, e8: { type: "checkbox", name: "Verify you are human", attrs: { "aria-label": "Verify you are human" } }, e9: { type: "checkbox", name: "Remember me" } } });
  const call = inWorkspace("gate2");
  await call({ action: "open", url: "https://gate2.example/" });
  assert.match(await call({ action: "act", do: "check", ref: "e8" }), /e8 is a check that a person is at the browser \("Verify you are human"\): that's the user's to do/);
  assert.match(await call({ action: "act", do: "click", ref: "e8" }), /that's the user's to do/);
  assert.deepEqual(lastPage().clicks, []);
  assert.match(await call({ action: "act", do: "check", ref: "e9" }), /^Did check e9\./);
});

test("a code field the page shows again under another ref counts as still asked, without typing into the old ref", async () => {
  site("https://moved.example/code", {
    title: "Two-step",
    fields: { e4: { type: "text", name: "Authentication code" }, e6: { kind: "button", name: "Verify" } },
    onclick: { e6: "https://moved.example/again" },
  });
  site("https://moved.example/again", { title: "Two-step", fields: { e3: { kind: "link", name: "Try another way" }, e4: { kind: "button", name: "Resend" }, e5: { type: "text", name: "Authentication code" } } });
  const call = inWorkspace("moved");
  await call({ action: "open", url: "https://moved.example/code" });
  await call({ action: "login", what: "authenticator", ref: "e4", submit_ref: "e6" });
  post({ ev: "need-answer", text: "111111" }, { workspace: "moved" });
  assert.match(await call({ action: "read" }), /the page still asks for the code: the site may have refused it\. Read the page, tell the user, and use login again/);
  assert.equal(tabState("moved").need, null, "not asked again under a ref that's now another element");
});
