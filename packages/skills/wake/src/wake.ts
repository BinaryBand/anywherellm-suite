// The wake: each topic in WAKE followed as a stream; a message starts a burst, and when the burst
// has been quiet for BURST_MS the topic's job is run, once, if none of its runs is going and its
// last run the wake started is GAP_MS behind. Messages that come while it waits or while a run
// goes make one more run after. The last message a run was started for is kept per topic, so a
// restart (or ntfy coming back) runs the job once for what came while the wake was away.

import { setTimeout as sleep } from "node:timers/promises";
import { readJson, writeJson } from "#shared/atomic";
import { firstLine } from "#shared/errors";
import type { Anything } from "./anything.ts";
import { follow } from "./ntfy.ts";
import { BURST_MS, GAP_MS, type Rule, type Settings } from "./settings.ts";

/** How long to wait before asking again whether a run has ended, or after AnythingLLM failed (ms). */
export const RECHECK_MS = 15_000;
const RECONNECT_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000]; // waits between tries at the stream

type Api = Pick<Anything, "busy" | "trigger">;
export type Log = (line: string) => void;

export interface Timing {
  burstMs: number;
  gapMs: number;
  recheckMs: number;
}

/** One topic's job: when to run it. `note` each message; `onRun` hears of each run started, with
 *  the last message id it covers. */
export class Waker {
  readonly #rule: Rule;
  readonly #api: Api;
  readonly #timing: Timing;
  readonly #log: Log;
  readonly #onRun: (id: string) => void;
  #latest: string | null = null; // the newest message noted
  #covered: string | null = null; // the newest message a run was started for
  #timer: NodeJS.Timeout | undefined;
  #lastRun = -Infinity;
  #stopped = false;
  #firing = false; // a run is being asked for: a message waits for its answer, not a timer of its own

  constructor(rule: Rule, api: Api, timing: Timing, log: Log, onRun: (id: string) => void = () => {}) {
    this.#rule = rule;
    this.#api = api;
    this.#timing = timing;
    this.#log = log;
    this.#onRun = onRun;
  }

  /** A message arrived: (re)starts the burst's wait, or, while a run is being asked for, is run
   *  for after it. */
  note(id: string): void {
    this.#latest = id;
    if (!this.#firing) this.#arm(this.#timing.burstMs);
  }

  /** Stops its timer: no run starts after. */
  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
  }

  #arm(ms: number): void {
    if (this.#stopped) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#fire(), ms);
  }

  async #fire(): Promise<void> {
    const { topic, job } = this.#rule;
    const latest = this.#latest;
    if (latest === null || latest === this.#covered) return;
    const wait = this.#lastRun + this.#timing.gapMs - Date.now();
    if (wait > 0) return this.#arm(wait);
    this.#firing = true;
    try {
      if (await this.#api.busy(job)) return this.#arm(this.#timing.recheckMs);
      if (this.#stopped) return;
      await this.#api.trigger(job);
    } catch (e) {
      this.#log(`${topic}: job ${job} not run: ${firstLine(e)}; trying again in ${Math.round(this.#timing.recheckMs / 1000)} s`);
      return this.#arm(this.#timing.recheckMs);
    } finally {
      this.#firing = false;
    }
    this.#lastRun = Date.now();
    this.#covered = latest;
    this.#log(`${topic}: ran job ${job} (up to message ${latest})`);
    this.#onRun(latest);
    if (this.#latest !== latest) this.#arm(this.#timing.burstMs); // more came while it was asked
  }
}

/** The last message each topic's run was started for, as the state file keeps it. */
type State = Record<string, string>;

export interface Options {
  /** Where the last message each topic's run was started for is kept. */
  stateFile: string;
  /** Tests shorten the waits. */
  burstMs?: number;
  gapMs?: number;
  recheckMs?: number;
  reconnectMs?: number[];
}

/** Follows every topic of the settings until `signal` aborts. */
export async function serve(settings: Settings, api: Api, log: Log, signal: AbortSignal, { stateFile, burstMs = BURST_MS, gapMs = GAP_MS, recheckMs = RECHECK_MS, reconnectMs = RECONNECT_MS }: Options): Promise<void> {
  const saved = readJson<State>(stateFile, () => ({}));
  const timing = { burstMs, gapMs, recheckMs };
  await Promise.all(
    settings.rules.map(async (rule) => {
      const waker = new Waker(rule, api, timing, log, (id) => {
        try {
          // Read again: a listener stopped for new settings may have written it meanwhile.
          const now = readJson<State>(stateFile, () => ({}));
          now[rule.topic] = id;
          writeJson(stateFile, now);
        } catch (e) {
          log(`${rule.topic}: the run's message wasn't kept: ${firstLine(e)}`);
        }
      });
      signal.addEventListener("abort", () => waker.stop(), { once: true });
      let since = saved[rule.topic];
      let tries = 0;
      while (!signal.aborted) {
        try {
          await follow(settings.ntfyUrl, settings.ntfyToken, rule.topic, {
            since,
            signal,
            onOpen: () => {
              if (tries) log(`${rule.topic}: following again`);
              tries = 0;
            },
            onMessage: (id) => {
              since = id;
              waker.note(id);
            },
          });
          if (signal.aborted) return;
          log(`${rule.topic}: ntfy ended the stream`);
        } catch (e) {
          log(firstLine(e));
        }
        await sleep(reconnectMs[Math.min(tries++, reconnectMs.length - 1)], undefined, { signal }).catch(() => {});
      }
    }),
  );
}
