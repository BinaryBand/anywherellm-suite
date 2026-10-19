import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { counted, forHost, list, passkeys, remove, save, savePasskey } from "./logins.mts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logins-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
beforeEach(() => {
  process.env.STORAGE_DIR = path.join(tmp, `s${n++}`);
  process.env.SIG_KEY = "sig-key";
  process.env.SIG_SALT = "sig-salt";
  delete process.env.VAULT_KEY_FILE;
});

const credential = (id: string, signCount = 0) => ({ credentialId: id, rpId: "keys.example", privateKey: `private-${id}`, signCount, isResidentCredential: true });

test("a login is listed by site and user only, and the closest site's is the one for a host", async () => {
  await save("example.com", "ada", "pw-parent");
  await save("shop.example.com", "ada", "pw-shop");
  await save("shop.example.com", "ada", "pw-shop-2"); // the same site and user: replaced
  assert.deepEqual(list().map(({ site, user, kind }) => [site, user, kind]), [["example.com", "ada", "password"], ["shop.example.com", "ada", "password"]]);
  assert.ok(!JSON.stringify(list()).includes("pw-"), "no password in the list");
  assert.equal(forHost("shop.example.com")?.pass, "pw-shop-2");
  assert.equal(forHost("mail.example.com")?.pass, "pw-parent", "a parent site's, for a host under it");
  assert.equal(forHost("example.org"), null);
});

test("a passkey keeps its count going up only, and its deletion names its credential", async () => {
  await savePasskey("keys.example", "ada", credential("c-1", 2));
  assert.equal(forHost("keys.example", "passkey")?.site, "keys.example");
  assert.equal(await counted("c-1", 1), null, "a count that goes back is refused");
  assert.equal((await counted("c-1", 5))?.signCount, 5);
  assert.equal(passkeys()[0].signCount, 5);
  const [kept] = list();
  assert.ok(!JSON.stringify(list()).includes("private-"), "no key in the list");
  assert.deepEqual(await remove(kept.id), { kind: "passkey", credentialId: "c-1" });
  assert.equal(await remove(kept.id), null, "gone");
  assert.deepEqual(passkeys(), []);
});
