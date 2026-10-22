// A page whose link is a bearer capability, as the Library page and the Vault are: its files are in
// a folder of AnythingLLM's public folder under a random token, and its events carry a secret. Both
// names, and `hidden`, the mark of names made while the links were kept from the agent, are kept in
// a JSON file of the skill's, which can hold more of the page's own.
//
// What happens to the names follows the switch (#shared/page-links). Names made while it was off, or
// before it existed, may have been given to the agent, so the first call after it goes on replaces
// them once (settle), after what waited under the old secret is applied; while it is on, whatever
// is under another token is swept. Every change of the names is made under the names file's lock,
// and a writer that read them without it looks again under it after writing: a page is never left
// under a token a rotation replaced. The page's path is kept in the links file whatever the switch.

import { locked, readJson, updateJson, writeJson } from "./atomic.mts";
import { Told } from "./errors.mts";
import { linksHidden, noteLink, type PageKind } from "./page-links.mts";
import { listPublic, newSecret, removePublic, renamePublic, writePublic } from "./pages.mts";

export interface Names {
  token: string;
  secret: string;
  /** Made while the links were kept from the agent, and not given to it since. Absent: they may have been. */
  hidden?: true;
}

export interface TokenPageSpec<N extends Names> {
  /** The page's key in the links file. */
  kind: PageKind;
  /** Its folder in the public folder ("library-lean"). */
  folder: string;
  /** What its files' names start with, before the token ("manager-"), for a page that shares its
   *  folder with others; none by default. `pattern` matches it too. */
  prefix?: string;
  /** Where its names are kept. */
  file: () => string;
  /** The page, as a busy lock and a refusal name it. */
  what: string;
  /** The names file where there's none, holding `names`. */
  fresh: (names: Names) => N;
  /** The page's files in its folder: the token, and the rest of the name ("-keys.json"). */
  pattern: RegExp;
  /** Which of a replaced token's files move under the new one (by the rest of their name); the
   *  others are removed. None, by default. */
  carried?: (rest: string) => boolean;
}

/** New names, marked when made while the links are kept from the agent. */
const named = (hidden: boolean): Names => ({ token: newSecret(), secret: newSecret(), ...(hidden ? { hidden: true as const } : {}) });

/** A test seam of the page `kind`'s, at `point`: "gap", awaited under the names lock after new names
 *  are written and before the old token's files move; "written", called after a writer wrote and
 *  before it looks at the names again. Nothing shipped sets either. */
const seam = (kind: PageKind, point: "gap" | "written") => (globalThis as unknown as Record<symbol, (() => unknown) | undefined>)[Symbol.for(`anywherellm-suite.${kind}-page.${point}`)]?.();

export function tokenPage<N extends Names>(spec: TokenPageSpec<N>) {
  const pub = (name: string) => `${spec.folder}/${name}`;
  /** Writes `text` to the page's public file `name` (in its folder) unless it holds it already; answers the name. */
  const put = (name: string, text: string): string => (writePublic(pub(name), text), name);
  const prefix = spec.prefix ?? "";
  const underLock = <T,>(fn: () => T | Promise<T>): Promise<T> => locked(`${spec.file()}.lock`, spec.what, fn);
  /** A names file that isn't JSON is said to be damaged, never quoted: a parse error can quote it. */
  const unquoted = (e: unknown): unknown => (e instanceof SyntaxError ? new Error(`${spec.what}'s names file is damaged (not JSON)`) : e);
  /** The names file as it is now, or null where there's none; an error where it can't be read. */
  function read(): N | null {
    try {
      return readJson<N | null>(spec.file(), () => null);
    } catch (e) {
      throw unquoted(e);
    }
  }
  /** Changes the names file under its lock (new names where there's none). */
  const change = <T,>(fn: (n: N) => T): Promise<T> =>
    updateJson(spec.file(), () => spec.fresh(named(linksHidden())), fn).catch((e) => {
      throw unquoted(e);
    });

  /** The page's files in its folder under a token other than `token`. */
  const others = (token: string): string[] =>
    listPublic(spec.folder).filter((name) => {
      const found = spec.pattern.exec(name);
      return found !== null && found[1] !== token;
    });

  /** New names, if `due` holds of the names as they are under the lock (always, by default), marked
   *  as the switch is (`hidden`); the old token's files go, those `carried` move under the new one.
   *  All of it, from reading the names to the old files gone, under the one names lock, so no other
   *  call (a sweep, a writer's look) comes between the new names and the moved files. A file already
   *  gone is nothing to move; one that can't be moved is logged and left for the next sweep. Answers
   *  whether names were replaced. */
  const rotate = (due: (n: N) => boolean = () => true, hidden = linksHidden()): Promise<boolean> =>
    underLock(async () => {
      const old = read();
      if (old && !due(old)) return false;
      const names = named(hidden);
      const now = old ? ({ ...old, ...names } as N) : spec.fresh(names);
      if (!hidden) delete now.hidden;
      writeJson(spec.file(), now);
      if (!old) return false;
      await seam(spec.kind, "gap");
      for (const name of listPublic(spec.folder)) {
        const found = spec.pattern.exec(name);
        if (found?.[1] !== old.token) continue;
        if (!spec.carried?.(found[2])) {
          removePublic(pub(name));
          continue;
        }
        try {
          renamePublic(pub(name), pub(`${prefix}${now.token}${found[2]}`));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
          console.error(`${spec.folder} couldn't move ${found[2]} to the new page: ${(e as Error).message}`);
        }
      }
      return true;
    });

  /** Makes the names fit the switch (`hidden`). Off: a mark is dropped, with no rotation, since the
   *  links go out again. On, with names not made under it: the agent may hold their link, so what
   *  waits under the old secret is applied first (`applied`: a scheduled job's process doesn't drain
   *  by itself), then the names are replaced, once: the check is repeated under the lock, so two
   *  processes at once end in one rotation. Nothing without names. Answers whether they were replaced. */
  async function settle(applied: () => Promise<void>, hidden = linksHidden()): Promise<boolean> {
    const kept = read();
    if (!kept || (kept.hidden === true) === hidden) return false;
    if (!hidden) return await change((n) => void delete n.hidden), false;
    await applied();
    return rotate((n) => n.hidden !== true, true);
  }

  /** Removes the page's files under another token than the names': what a rotation that died between
   *  its steps, or a writer that read the names before one, left. The folder is listed without the
   *  lock first; the lock is taken, and the folder listed again, only when there's one to remove. */
  async function sweep(): Promise<void> {
    const kept = read();
    if (!kept || !others(kept.token).length) return;
    await underLock(() => {
      const now = read();
      if (now) for (const name of others(now.token)) removePublic(pub(name));
    });
  }

  /** settle, for a call whether or not it shows the page: names replaced are published at once
   *  (`publish`, given the switch), so the link kept is a page that is there; with the switch on and
   *  nothing replaced, a sweep repairs what a crash between new names and the old files left. With
   *  the switch off and the names unmarked, as every page was before the switch, nothing is touched. */
  async function settleCall(applied: () => Promise<void>, publish: (hidden: boolean) => Promise<unknown>): Promise<void> {
    const hidden = linksHidden();
    if (await settle(applied, hidden)) await publish(hidden);
    else if (hidden) await sweep();
  }

  /** Writes the page's files with `write`, which answers the names of those it wrote, under the names
   *  as they are (new ones where there are none). Then, under the names lock, it looks again: the
   *  token still the same, the page's path is kept in the links file (`rotated`: the token was just
   *  replaced) and, with the switch on (`hidden`), what isn't under the token is swept. A rotation
   *  that came in between (another process's) leaves what it wrote under a dead token: that is
   *  removed, and the page written again under the new names. Answers the names it was written under. */
  async function publish(write: (n: N) => string[] | Promise<string[]>, rotated = false, hidden = linksHidden()): Promise<N> {
    for (let tries = 0; tries < 3; tries++) {
      const n = read() ?? (await change((n) => n));
      const written = await write(n);
      seam(spec.kind, "written");
      const current = await underLock(async () => {
        if (read()?.token !== n.token) return false;
        await noteLink(spec.kind, `/${pub(`${prefix}${n.token}.html`)}`, rotated);
        if (hidden) for (const name of others(n.token)) removePublic(pub(name));
        return true;
      });
      if (current) return n;
      for (const name of written) removePublic(pub(name));
    }
    throw new Told(`${spec.what} was replaced while it was written: call again`);
  }

  /** Writes with `write` (as publish does) under the names as they are, where there are names, without
   *  the lock: a page's state written again. Then it looks at the names again, and removes what it
   *  wrote if a rotation replaced the token meanwhile. */
  function refresh(write: (n: N) => string[]): void {
    const n = read();
    if (!n) return;
    const written = write(n);
    seam(spec.kind, "written");
    if (read()?.token !== n.token) for (const name of written) removePublic(pub(name));
  }

  return { read, change, rotate, settle, settleCall, sweep, publish, refresh, put };
}
