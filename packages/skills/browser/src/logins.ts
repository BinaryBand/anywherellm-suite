// The lean browser's logins, imported once into the instance's vault, where #shared/logins keeps
// them with the rest.
//
// The lean browser kept a vault per workspace (<storage>/browser-lean/<workspace>/vault.json, under
// a key of its own). Its logins, passkeys (kept for when the browser signs in with them again) and
// API keys (the library's now) are imported once, without one already there; its OAuth sign-ins
// aren't (the library signs in its own way). Its files are left as they were.

import fs from "node:fs";
import path from "node:path";
import * as vault from "#shared/vault";
import { skillDir, state } from "./state";

const LEAN_INFO = "browser-lean vault";
const LEAN_KINDS = new Set(["password", "passkey", "key"]);

/** The same secret: a login or passkey of the same kind, site and user; a key of the same name. */
const same = (a: vault.Entry, b: vault.Entry) =>
  a.kind === b.kind && (a.kind === "key" ? a.user.toLowerCase() === b.user.toLowerCase() : a.site === b.site && a.user === b.user);

/** Imports the lean browser's vaults once (a marker says it's done); answers how many entries came.
 *  A vault that can't be opened is skipped and said in `log`. */
export async function importLean(log: (message: string) => void = () => {}): Promise<number> {
  const marker = path.join(skillDir(), ".imported");
  if (state().imported || fs.existsSync(marker) || !fs.existsSync(skillDir())) return void (state().imported = true), 0;
  const found: vault.Entry[] = [];
  for (const ws of fs.readdirSync(skillDir(), { withFileTypes: true })) {
    const file = path.join(skillDir(), ws.name, "vault.json");
    if (!ws.isDirectory() || !fs.existsSync(file)) continue;
    try {
      const opened = vault.openLegacy(file, LEAN_INFO, path.join(skillDir(), "vault.key")) as { logins?: vault.Entry[] } | null;
      found.push(...(opened?.logins ?? []).map((l) => ({ ...l, kind: l.kind || "password" })).filter((e) => LEAN_KINDS.has(e.kind)));
    } catch (e) {
      log(`browser-lean couldn't import the logins of ${ws.name}: ${(e as Error).message}`);
    }
  }
  const added = !found.length ? 0 : await vault.update((v) => {
    let n = 0;
    for (const e of found) {
      if (v.entries.some((x) => same(x, e))) continue;
      const { writes, ...kept } = e; // a key's "let the agent change things", which the library doesn't keep
      v.entries.push({ ...kept, id: vault.newId() });
      n++;
    }
    return n;
  });
  fs.writeFileSync(marker, new Date().toISOString() + "\n");
  state().imported = true;
  return added;
}
