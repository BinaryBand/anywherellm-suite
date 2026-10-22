// The apps manager: one page for every workspace's apps (static/pages/manager.html), the user's own
// view of them on any device, which AnywhereLLM Lite opens from its Apps row. Each app shows its
// card's summary, its page, its newest changes and its earlier app.json and page.html; the user
// renames one (its title), takes back its newest change, puts back an earlier file, moves it to the
// trash, and restores one from there. What the user does is posted as an event under the manager's
// own title and applied at once while AnythingLLM's process watches, else at the skill's next call.
//
// Its address holds a random token and each event it posts carries a secret, as the Library page's
// do (#shared/token-page): anyone with the link can see what it shows and act on it, so it is
// rotated (a new token and secret) from the page. It shares apps-lean/ in the public folder with the
// apps' own pages, so its files are manager-<token>.html and .json, a shape no app page has. Its
// path is kept in the links file as `apps`, which the bridge hands to Lite; while the links are kept
// from the agent (#shared/page-links), the agent isn't told it.

import fs from "node:fs";
import path from "node:path";
import { jobTimeLeft } from "#shared/anythingllm";
import { Told } from "#shared/errors";
import { linksHidden, OPEN_PAGES } from "#shared/page-links";
import { embed, inTurn, pageKey, publicPath, sameSecret, takeEvents, watch, writePublic } from "#shared/pages";
import { type Names, tokenPage } from "#shared/token-page";
import { summary } from "./card.ts";
import { HUB_ID, root } from "./dirs.ts";
import { firstLine, publish, refresh as refreshPage, tell, unpublish, whenApplied } from "./page.ts";
import { file } from "./parts.ts";
import type { Json } from "./patch.ts";
import * as store from "./store.ts";

/** The title the manager's events are posted under, and the mark each carries. */
export const TITLE = "apps-lean-manage";
const MARK = "apps_lean_manage";
const PREFIX = "manager-";

/** How the last thing the page was asked to do went: done, or refused in the skill's own words.
 *  `n` counts them, so the page knows one is new. */
interface Result {
  n: number;
  ev: string;
  title: string;
  error: string | null;
}

interface ManagerFile extends Names {
  result?: Result;
}

/** The manager's names (#shared/token-page), kept beside the workspaces' folders (a dot, so no
 *  workspace can be named like it): its files are manager-<token>.html and .json. */
const names = tokenPage<ManagerFile>({
  kind: "apps",
  folder: HUB_ID,
  prefix: PREFIX,
  file: () => path.join(root(), ".manager.json"),
  what: "the apps manager",
  fresh: (n) => n,
  pattern: /^manager-([\w-]{24})(\.html|\.json)$/,
});

const put = (name: string, text: string): string => (writePublic(`${HUB_ID}/${name}`, text), name);
const text = (v: unknown, n = 200) => String(v ?? "").trim().slice(0, n);

/** One app as the manager shows it: nothing secret, and its page by the address relative to the
 *  manager's own (they share a folder). */
const appState = (app: Json) => ({
  name: app.name,
  title: app.title,
  summary: summary(app),
  changed: app.changed ?? "",
  page: app.pageToken ? `${app.pageToken}.html` : null,
  changes: (app.history || []).map((h: Json) => ({ n: h.n, t: h.t, by: h.by, ev: h.ev, text: typeof h.fields?.text === "string" ? text(h.fields.text, 120) : null })).reverse(),
  versions: (app.versions || []).map((v: Json) => ({ t: v.t, file: v.file })).reverse(),
});

/** The manager's state, as its page reads it every few seconds. */
function state(p: ManagerFile) {
  return {
    workspaces: store
      .workspaces()
      .sort()
      .map((workspace) => ({ workspace, apps: store.list(workspace).filter((a) => !a.broken).map(appState) }))
      .filter((w) => w.apps.length),
    trash: store.trashed(),
    trashDays: store.TRASH_DAYS,
    trashMax: store.TRASH_MAX,
    result: p.result ?? null,
  };
}

/** Writes the page and its state into the public folder; answers its address relative to
 *  AnythingLLM's. `rotated` says the token was just replaced, which the links file records. */
async function write(rotated = false, hidden = linksHidden()): Promise<string> {
  const p = await names.publish((n) => [put(`${PREFIX}${n.token}.html`, html(n)), put(`${PREFIX}${n.token}.json`, JSON.stringify(state(n)))], rotated, hidden);
  return `/${HUB_ID}/${PREFIX}${p.token}.html`;
}

/** The page's HTML under the names `n`: the template with what it reads its state and posts with. */
const html = (n: ManagerFile): string => file("pages/manager.html").replace("/*CONFIG*/null", embed({ token: `${PREFIX}${n.token}`, secret: n.secret, title: TITLE, key: pageKey() }));

/** Writes the manager's state again, where there is a manager, after the apps changed; a hint, so a
 *  failure is only logged. */
export function refresh(): void {
  try {
    names.refresh((p) => [put(`${PREFIX}${p.token}.json`, JSON.stringify(state(p)))]);
  } catch (e) {
    console.error(`apps-lean couldn't refresh the apps manager: ${(e as Error).message}`);
  }
}
whenApplied(refresh);

/** Makes sure the manager is there and answers its address under `base` (AnythingLLM's address as
 *  the user reaches it; relative without it); null where it can't be written: no key for the pages
 *  yet, or a public folder that can't be written. It is written whole the first time, or when the
 *  public folder lost it; after that only its HTML is written again when this skill's differs, so a
 *  call that changes no app writes nothing (refresh writes the state after one that does). */
export async function show(base: string | null): Promise<string | null> {
  try {
    const kept = names.read();
    let rel: string;
    if (kept && fs.existsSync(publicPath(`${HUB_ID}/${PREFIX}${kept.token}.json`))) {
      put(`${PREFIX}${kept.token}.html`, html(kept));
      rel = `/${HUB_ID}/${PREFIX}${kept.token}.html`;
    } else rel = await write();
    return `${(base ?? "").replace(/\/+$/, "")}${rel}`;
  } catch (e) {
    if (!(e instanceof Told)) console.error(`apps-lean couldn't write the apps manager: ${(e as Error).message}`);
    return null;
  }
}

/** What the agent is told about the manager: its link, or where the user opens it while the links
 *  are kept from the agent; nothing when it can't be written. */
export async function line(base: string | null): Promise<string | null> {
  const url = await show(base);
  if (!url) return null;
  return linksHidden() ? `The user manages every workspace's apps, and the trash, on the apps manager, ${OPEN_PAGES}.` : `The user manages every workspace's apps, and the trash, at ${url}`;
}

/** What every call does before its own work: the manager's names made to fit the switch (#shared/
 *  token-page settleCall), what it posted applied first. */
export const settle = (): Promise<void> => names.settleCall(caughtUp, (hidden) => write(true, hidden));

/** Applies what the manager posted, after whatever pass is already running. */
export const caughtUp = (): Promise<void> => inTurn(TITLE, drain);

/** Applies what the manager posts as it lands, for as long as AnythingLLM's process runs: not in a
 *  scheduled job's (the next chat call takes what it left). */
export function keepWatching(): void {
  if (jobTimeLeft() !== null) return;
  watch(TITLE, drain, () => Infinity);
}

/** What one event changed: an app in `workspace` (its page written again after, unless it went to
 *  the trash: `name` null), or the manager's link. */
type Applied = { workspace: string; name: string | null; said: string } | { rotate: true };

/** Applies one event the manager posted, whose secret was checked. */
async function apply(e: Record<string, unknown>): Promise<Applied | null> {
  const workspace = text(e.workspace, 128);
  const name = e.app;
  switch (e.ev) {
    case "rename": {
      const was = store.read(workspace, name).title;
      const app = await store.retitle(workspace, name, text(e.title, 120));
      return { workspace, name: app.name, said: `renamed ${was} to ${app.title}` };
    }
    case "take-back": {
      const { app, undone } = await store.undoChange(workspace, name, e.n);
      return { workspace, name: app.name, said: `took back ${undone.ev} on ${app.title}` };
    }
    case "put-back": {
      // `at`: the version's time (every event's own `t` is when it was posted).
      const app = await store.putBack(workspace, name, e.file, text(e.at, 40));
      return { workspace, name: app.name, said: `put back ${app.title}'s ${e.file} from ${text(e.at, 40)}` };
    }
    case "trash": {
      const app = store.read(workspace, name);
      await store.remove(workspace, app.name);
      unpublish(app);
      return { workspace, name: null, said: `moved ${app.title} (${app.name}) to the trash, where it stays ${store.TRASH_DAYS} days` };
    }
    case "restore": {
      const { workspace: into, app } = await store.restore(text(e.id, 300));
      await publish(app, into).catch(() => null); // no key for the pages: the app is back, with no page yet
      return { workspace: into, name: app.name, said: `restored ${app.title} (${app.name}) from the trash` };
    }
    case "rotate":
      return { rotate: true };
    default:
      return null;
  }
}

/** Applies every event the manager posted since the last time, in order, then writes its state again
 *  (or a new page, after a rotate), each app changed written again too. One the skill refuses is
 *  skipped, and its words go to the page in the state's `result`; so does what was done, so the page
 *  can say so. An event under an old link's secret, or a forgery, is dropped and says nothing. */
async function drain(): Promise<void> {
  const events = takeEvents(TITLE, MARK);
  if (!events.length) return;
  const page = names.read();
  if (!page) return; // no manager yet: none of these can be its
  let result: Omit<Result, "n"> | null = null;
  let rotate = false;
  const touched = new Map<string, { workspace: string; name: string }>();
  for (const e of events) {
    if (!sameSecret(e.secret, page.secret)) continue;
    const ev = text(e.ev, 40);
    try {
      const done = await apply(e);
      if (!done) continue;
      if ("rotate" in done) {
        rotate = true;
        continue;
      }
      if (done.name) touched.set(`${done.workspace}/${done.name}`, { workspace: done.workspace, name: done.name });
      await tell(done.workspace, [`- ${done.said}`]);
      result = { ev, title: done.said, error: null };
    } catch (err) {
      // The events are taken already: one that breaks (not a refusal) is logged, and the rest go on.
      const told = err instanceof Told;
      if (!told) console.error(`apps-lean couldn't apply an apps manager event (${ev}): ${(err as Error).message}`);
      result = { ev, title: text(e.title ?? e.app, 120), error: told ? firstLine(err).slice(0, 400) : "couldn't do that (see the log)" };
    }
  }
  for (const { workspace, name } of touched.values()) await refreshPage(workspace, name);
  const outcome = result;
  if (outcome) await names.change((p) => void (p.result = { n: (p.result?.n ?? 0) + 1, ...outcome }));
  if (rotate) {
    await names.rotate();
    await write(true);
  } else refresh();
}
