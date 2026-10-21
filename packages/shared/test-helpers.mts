// What the tests of the skills and of the shared pages share: an event a page posts, written as
// AnythingLLM's collector writes it, and the switch that keeps the Library and Vault links from the
// agent, turned on and off as the owner does. For tests only: nothing shipped imports it.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeAtomic } from "./atomic.mts";
import { hiddenFile } from "./page-links.mts";
import { eventsDir } from "./pages.mts";

let posts = 0;

/** Writes what a page posted under `title` (#shared/pages take) into the storage `storage`, as
 *  AnythingLLM's collector writes it: `payload` as JSON, or `raw` as the text when given. Each lands
 *  after the one before, as a page posts them one at a time, and a minute ago, so one that can't be
 *  read is dropped, not waited on as a file still being written. */
export function postEvent(storage: string, title: string, payload: unknown, raw?: string): void {
  const dir = eventsDir(storage);
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const file = path.join(dir, `raw-${title}-${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, title: `${title}.txt`, pageContent: raw ?? JSON.stringify(payload) }));
  const at = new Date(Date.now() - 60_000 + ++posts * 10);
  fs.utimesSync(file, at, at);
}

/** Turns the switch that keeps the Library page's and the Vault's links from the agent on or off in
 *  the storage `storage`, as `anywherellm-suite pages --hide` and `--show` do on the host. */
export function setLinksHidden(storage: string, on: boolean): void {
  if (on) writeAtomic(hiddenFile(storage), "2026-10-21T00:00:00.000Z\n");
  else fs.rmSync(hiddenFile(storage), { force: true });
}
