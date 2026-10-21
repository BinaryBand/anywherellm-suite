import fs from "fs";
import path from "path";
import { serial } from "./anythingllm.mts";
import { Told } from "./errors.mts";

/** Writes `data` to `file` atomically, making its folder: a reader never sees half of it. */
export function writeAtomic(file: string, data: string | Uint8Array, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temp, data, { mode });
    fs.renameSync(temp, file);
  } catch (e) {
    fs.rmSync(temp, { force: true });
    throw e;
  }
}

/** What `file` holds, or null when there is no file. */
export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Whether `file` holds exactly `text`; false when there is no file. */
export const sameText = (file: string, text: string): boolean => readText(file) === text;

/** Writes `text` to `file` atomically unless it holds it already; whether it wrote. */
export function writeAtomicIfChanged(file: string, text: string, mode?: number): boolean {
  if (sameText(file, text)) return false;
  writeAtomic(file, text, mode);
  return true;
}

const LOCK_WAIT_MS = 5 * 1000;
const LOCK_STALE_MS = 10 * 1000;
const LOCK_RETRY_MS = 20;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** mkdir's answer for a lock folder that's there, or (Windows) still being removed. */
const busy = (code?: string) => code === "EEXIST" || (process.platform === "win32" && (code === "EPERM" || code === "EACCES"));

/** Runs `fn` holding the lock folder `lock`: one process at a time (the folder is made, or waited
 *  for), and in this process one call at a time. `fn` should be quick and do no network, so the
 *  lock is held for milliseconds; a lock older than LOCK_STALE_MS is one a process left behind when
 *  it died, and is broken. `what` names what's locked in the Told said when it stays busy. */
export function locked<T>(lock: string, what: string, fn: () => T | Promise<T>): Promise<T> {
  return serial(`lock:${lock}`, async () => {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const until = Date.now() + LOCK_WAIT_MS;
    // Every try but the one that takes it waits a little: on Windows a folder being removed can
    // refuse both mkdir and stat for a while, which mustn't spin.
    for (;;) {
      try {
        fs.mkdirSync(lock);
        break;
      } catch (e) {
        if (!busy((e as NodeJS.ErrnoException).code)) throw e;
      }
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
      } catch {} // released meanwhile, or still being removed
      if (Date.now() > until) throw new Told(`${what} is busy; try again in a moment`);
      await sleep(LOCK_RETRY_MS);
    }
    try {
      return await fn();
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  });
}

/** What the JSON file `file` holds, or `fresh()` when there's none. A file that can't be parsed is an
 *  error, never taken for an empty one: a change would write over what it held. */
export function readJson<S>(file: string, fresh: () => S): S {
  const text = readText(file);
  return text === null ? fresh() : (JSON.parse(text) as S);
}

/** Changes the JSON file `file` under its lock (`file`.lock): `change` gets what it holds now (or
 *  `fresh` when there's none) and changes it in place; what it answers is answered. */
export function updateJson<S, T>(file: string, fresh: () => S, change: (value: S) => T): Promise<T> {
  return locked(`${file}.lock`, path.basename(file), () => {
    const value = readJson(file, fresh);
    const answer = change(value);
    writeAtomic(file, JSON.stringify(value, null, 2) + "\n", 0o600);
    return answer;
  });
}
