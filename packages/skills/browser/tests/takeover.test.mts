// The user taking a tab over on its page, and passkeys: what the page posts (take, tap, type, give,
// offer…) applied to the stand-in Chrome, and the virtual authenticator's events played as Chrome
// would send them. `guide` stands for any call: each applies what the page posted first.

import assert from "node:assert/strict";
import test from "node:test";
import * as logins from "#shared/logins";
import { call as called, post, seal, site, tabConfig, tabState, world } from "./harness.mts";

const HERE = "https://take.example/";
site(HERE, {
  title: "Sign in",
  fields: { e1: { type: "text", name: "Email", box: { x: 20, y: 100, w: 300, h: 40 } }, e2: { type: "password", name: "Password", box: { x: 20, y: 160, w: 300, h: 40 } }, e3: { kind: "button", name: "Sign in" } },
  onenter: "https://take.example/home",
});
site("https://take.example/home", { title: "Home", text: "Signed in as ada. Your password was pw-take-1." });
const KEYS = "https://keys.example/";
site(KEYS, { title: "Keys", text: "Sign in with a passkey", fields: { e1: { type: "email", name: "Email" }, e2: { type: "password", name: "Password" }, e3: { kind: "button", name: "Sign in with a passkey" } } });

const lastPage = () => world.pages[world.pages.length - 1];
/** The saved passkeys, as the Vault lists them (the vault is the instance's: other tests' logins are there too). */
const passkeys = () => logins.list().filter((l) => l.kind === "passkey");
const browserState = () => (globalThis as unknown as Record<symbol, { browsers: Map<string, { holds: Map<string, { last: number }> }> }>)[Symbol.for("anythingllm-suite.browser-lean.state")];

test("the user takes the tab over, types a login sealed, is offered to save it, and hands it back; the agent waits meanwhile", async () => {
  const call = (args: Record<string, unknown>, thread = 1) => called(args, { workspace: "take", thread });
  await call({ action: "open", url: HERE });
  const opts = { workspace: "take" };
  post({ ev: "take" }, opts);
  await call({ action: "guide" });
  assert.equal(tabState("take").who, "user");
  assert.deepEqual(tabState("take").fields.map((f: { ref: string; kind: string }) => [f.ref, f.kind]), [["e1", "text"], ["e2", "password"]], "the fields in view, for the page to type into");
  assert.match(await call({ action: "act", do: "click", ref: "e3" }), /^Browser: the user has taken the tab over on its page: you can read it, but not act/);
  assert.match(await call({ action: "read" }), /^The user has taken this tab over on its page: read it, but don't act in it until they hand it back\./);

  post({ ev: "type", ref: "e99", text: "gone" }, opts);
  await call({ action: "guide" });
  assert.equal(tabState("take").msg.text, "That field changed on the page: tap it again", "said in the user's words, not the agent's");
  post({ ev: "type", ref: "e1", text: "ada" }, opts);
  post({ ev: "type", ref: "e2", text: "in the clear" }, opts);
  await call({ action: "guide" });
  assert.match(tabState("take").msg.text, /^A password has to come sealed/);
  assert.equal(lastPage().fields.e2.value, undefined);
  post({ ev: "type", ref: "e2", sealed: seal("pw-take-1", tabConfig("take").pub), then: "Enter" }, opts);
  await call({ action: "guide" });
  assert.equal(lastPage().url(), "https://take.example/home");
  assert.deepEqual(tabState("take").offer, { kind: "password", site: "take.example", user: "ada" }, "the page no longer asks for a password: the login is offered");
  assert.match(await call({ action: "read" }), /Signed in as •••\. Your password was •••\./, "what the user typed is hidden from the agent");

  post({ ev: "offer", save: true }, opts);
  await call({ action: "guide" });
  assert.equal(tabState("take").msg.text, "Saved for take.example");
  assert.equal(tabState("take").offer, null);
  assert.ok(logins.list().some((l) => l.site === "take.example" && l.user === "ada"));

  post({ ev: "give" }, opts);
  const back = await call({ action: "read" });
  assert.match(back, /the user had the tab and handed it back to you; what they typed stays hidden/);
  assert.doesNotMatch(back, /^The user has taken/);
  assert.equal(tabState("take").who, "agent");
  assert.equal(tabState("take").fields.length, 0, "no fields to type into while the agent has it");
});

test("taps and scrolls only while the user holds the tab, kept on its screen; back, reload and the screen's size", async () => {
  const call = (args: Record<string, unknown>) => called(args, { workspace: "taps" });
  await call({ action: "open", url: HERE });
  const opts = { workspace: "taps" };
  post({ ev: "tap", x: 10, y: 10 }, opts);
  await call({ action: "guide" });
  assert.equal(tabState("taps").msg.text, "Take over the tab first");
  assert.deepEqual(lastPage().taps, []);

  post({ ev: "take" }, opts);
  post({ ev: "tap", x: 9999, y: -5 }, opts);
  post({ ev: "scroll", dy: 99999 }, opts);
  post({ ev: "nav", do: "back" }, opts);
  post({ ev: "nav", do: "reload" }, opts);
  post({ ev: "size", w: 1200, h: 800, dpr: 2 }, opts);
  await call({ action: "guide" });
  assert.deepEqual(lastPage().taps, [[429, 0]]);
  assert.deepEqual(lastPage().wheels, [3000]);
  assert.deepEqual(lastPage().navs, ["back", "reload"]);
  assert.deepEqual(lastPage().viewport(), { width: 1200, height: 800, deviceScaleFactor: 1 }, "wider than a phone is drawn at 1x");
  assert.deepEqual(tabState("taps").size, { w: 1200, h: 800 });

  post({ ev: "take", secret: "not the tab's" }, opts);
  browserState().browsers.get("taps")!.holds.get("1")!.last = 0; // ten minutes and more without a step
  const lapsed = await call({ action: "read" });
  assert.match(lapsed, /the user took the tab over but did nothing on it for 10 minutes, so it's yours again/);
  assert.equal(tabState("taps").who, "agent", "a take without the tab's secret does nothing");
  assert.match(await call({ action: "act", do: "scroll_down" }), /^Did scroll_down\./);
});

test("a passkey the site makes is taken out unless the user holds the tab; saved, it's in every tab and signs in by itself", async () => {
  const call = (args: Record<string, unknown>, thread = 1) => called(args, { workspace: "pk", thread });
  const opts = { workspace: "pk" };
  const made = (id: string, signCount = 1) => ({ credentialId: id, isResidentCredential: true, rpId: "keys.example", privateKey: `key-of-${id}`, userHandle: "dTE", signCount });
  await call({ action: "open", url: KEYS });
  const first = lastPage().session!;
  assert.equal(first.options.protocol, "ctap2");
  assert.equal(first.options.automaticPresenceSimulation && first.options.isUserVerified, true, "no dialog to wait on");

  await first.emit("WebAuthn.credentialAdded", { credential: made("by-agent") });
  assert.equal(first.credentials.has("by-agent"), false);
  assert.match(await call({ action: "read" }), /made a passkey for keys\.example while you had the tab, and it was taken out again/);

  post({ ev: "take" }, opts);
  await call({ action: "guide" });
  first.credentials.set("by-user", made("by-user"));
  await first.emit("WebAuthn.credentialAdded", { credential: made("by-user") });
  assert.deepEqual(tabState("pk").offer, { kind: "passkey", site: "keys.example", user: "" }, "offered, and the tab drawn again to show it");
  post({ ev: "offer", save: true }, opts);
  await call({ action: "guide" });
  assert.deepEqual(passkeys().map((l: { site: string }) => l.site), ["keys.example"]);
  assert.ok(!JSON.stringify(tabState("pk")).includes("key-of-"), "the tab's state holds no key");
  post({ ev: "give" }, opts);

  await call({ action: "open", url: KEYS }, 2);
  const second = lastPage().session!;
  assert.equal(second.credentials.get("by-user")?.privateKey, "key-of-by-user", "a new tab has the saved passkeys");
  await second.emit("WebAuthn.credentialAsserted", { credential: made("by-user", 4) });
  assert.equal(first.credentials.get("by-user")?.signCount, 4, "the other tab's copy counts on from there");
  assert.match(await call({ action: "read" }, 2), /the page signed in with the passkey saved for keys\.example/);
  assert.match(await call({ action: "login", user_ref: "e1", pass_ref: "e2" }, 2), /^Browser: no password is saved for keys\.example, but a passkey is: click the site's passkey sign-in with act/);

  // Deleted on the Vault (library-lean's page), it leaves every tab at the next step.
  const [kept] = passkeys();
  assert.deepEqual(await logins.remove(kept.id), { kind: "passkey", credentialId: "by-user" });
  assert.deepEqual(passkeys(), []);
  assert.ok(world.authenticators.some((a) => a.credentials.has("by-user")), "still in the tabs until a step");
  await call({ action: "act", do: "scroll_down" }, 2);
  assert.equal(world.authenticators.some((a) => a.credentials.has("by-user")), false, "taken out of every tab");

  post({ ev: "take" }, opts);
  await call({ action: "guide" });
  first.credentials.set("declined", made("declined"));
  await first.emit("WebAuthn.credentialAdded", { credential: made("declined") });
  post({ ev: "offer", save: false }, opts);
  await call({ action: "guide" });
  assert.match(tabState("pk").msg.text, /^Not saved: remove the passkey in the site's own settings too/);
  assert.equal(first.credentials.has("declined"), false);
});
