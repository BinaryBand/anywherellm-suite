// Running a function: its kit, its limits, and the record of what it did. A function reaches the web
// only through kit.http, and only its own toolkit's hosts, with its own toolkit's keys, which are
// added outside the script (request.ts) and hidden in everything the script and the agent are shown.
// A function runs another (a flow) with kit.run; that one gets its own toolkit's kit, and shares the
// run's deadline, its budget of requests and its log. A refusal here is a LibraryError, which the
// script sees as it is (sandbox.ts).
//
// A run is recorded as running when it starts and again when it ends, and goes on in the process
// that started it however long the chat waits for it (handler.ts). A scheduled job runs in a child
// process AnythingLLM ends at the job's timeout, so a job's run gets only the time the job has left.

import { jobTimeLeft, perProcess } from "#shared/anythingllm";
import { DATA, clipped, mask, shownHeaders, textOf } from "#shared/answer";
import { checkUrl, onSite } from "#shared/fence";
import { LibraryError } from "./errors";
import { check } from "./policy";
import { send } from "./request";
import { run as runScript, type Kit, type Outcome } from "./sandbox";
import * as store from "./store";
import type { Fn, RunRecord, Toolkit } from "./store";

/** How long a run may take (LIBRARY_RUN_MS), and what it may do in that time. */
export const LIMITS = { wallMs: Number(process.env.LIBRARY_RUN_MS) || 10 * 60 * 1000, requests: 200, depth: 4, logs: 200, logChars: 500, sleepMs: 10 * 1000 };
/** What of a scheduled job's time to leave for the agent's report after a run, and the least a run
 *  is started with. */
const JOB = { margin: 30 * 1000, least: 10 * 1000 };
/** How a run that didn't end well ended, by the sandbox's name for it. */
const ENDED: Record<string, RunRecord["status"]> = { Timeout: "timeout", Stopped: "stopped" };

export interface Start {
  trigger: RunRecord["trigger"];
  workspace: string | null;
  /** The scripts every function runs after (static/prelude). */
  prelude: Record<string, string>;
}

/** What a run and the functions it runs share. */
interface Budget {
  start: Start;
  deadline: number;
  requests: number;
  logs: string[];
  made: RunRecord["calls"];
  /** Every key a request sent, to hide wherever it shows. */
  secrets: string[];
}

/** The runs going in this process, by id: their record once they end, and how to stop them. Kept per
 *  process, since AnythingLLM loads handler.js afresh for each agent run, and a run outlives one. */
export const live = () => perProcess("library-lean.runs", () => new Map<string, { done: Promise<RunRecord>; stop: AbortController }>());

/** When a run must end: its own limit, or before a scheduled job's time runs out. */
function deadlineFor(start: Start): number {
  const now = Date.now();
  const left = start.trigger === "job" ? jobTimeLeft() : null;
  if (left === null) return now + LIMITS.wallMs;
  if (left - JOB.margin < JOB.least) throw new LibraryError("too little of the scheduled job's time is left to run a function");
  return now + Math.min(LIMITS.wallMs, left - JOB.margin);
}

/** Starts the function `qualifiedName` ("github.list_issues"), recorded as running and not shown
 *  yet: that record, and its record once it ends. */
export function begin(qualifiedName: string, input: unknown, start: Start): { running: RunRecord; done: Promise<RunRecord> } {
  const { service, name } = store.qualified(qualifiedName);
  const { kit, f } = loaded(service, name);
  const values = store.inputChecked(f, input);
  check({ op: "run", fn: `${service}.${name}`, trigger: start.trigger });
  const deadline = deadlineFor(start);
  const budget: Budget = { start, deadline, requests: 0, logs: [], made: [], secrets: [] };
  const started = new Date();
  const base = { id: store.runId(started), fn: `${service}.${name}`, trigger: start.trigger, workspace: start.workspace, started: started.toISOString(), logs: budget.logs, calls: budget.made };
  const running: RunRecord = { ...base, pid: process.pid, until: new Date(deadline).toISOString(), ended: base.started, ms: 0, status: "running" };
  store.record(running);
  store.markUnseen(base.id);
  const stop = new AbortController();
  const done = call(kit, f, values, budget, 0, stop.signal)
    .catch((e): Outcome => ({ ok: false, error: { name: "Error", message: (e as Error)?.message || String(e) } }))
    .then((outcome) => {
      const ended = new Date();
      const record: RunRecord = {
        ...base,
        ended: ended.toISOString(),
        ms: ended.getTime() - started.getTime(),
        ...(outcome.ok ? { status: "ok", result: outcome.value } : { status: ENDED[outcome.error.name] ?? "error", error: outcome.error }),
      };
      store.rewrite(record);
      return record;
    })
    .finally(() => live().delete(base.id));
  live().set(base.id, { done, stop });
  return { running, done };
}

/** Whether process `pid` is there. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A run as it is: one recorded as running whose process ended first (or that is a minute past its
 *  time, should its process id have been reused) was interrupted, and is kept so. */
function settled(run: RunRecord): RunRecord {
  if (run.status !== "running") return run;
  if (run.pid === process.pid ? live().has(run.id) : alive(run.pid!) && Date.now() < Date.parse(run.until!) + 60 * 1000) return run;
  const ended = new Date();
  const { pid, until, ...rest } = run;
  const out: RunRecord = { ...rest, status: "interrupted", ended: ended.toISOString(), ms: ended.getTime() - Date.parse(run.started), error: { name: "Interrupted", message: "its process ended before it did: AnythingLLM restarted, or its scheduled job's time ran out" } };
  store.rewrite(out);
  return out;
}

/** The last `n` runs, newest first, of a service's functions (`service`) or of all. */
export const recentRuns = (n = 5, service = ""): RunRecord[] => store.recentRuns(n, service).map(settled);

/** A run by its id; null when it isn't kept. */
export const runOf = (id: string): RunRecord | null => {
  const run = store.runOf(id);
  return run && settled(run);
};

/** The runs that ended with no answer showing it yet, oldest first. */
export const unseen = (): RunRecord[] => store.unseen().map(settled).filter((r) => r.status !== "running");

/** How a run ended, as one line of text: its result as JSON, or its error. */
export const outcomeOf = (run: RunRecord): string => (run.status === "ok" ? (JSON.stringify(run.result) ?? "null") : run.error ? `${run.error.name}: ${run.error.message}` : run.status);

function loaded(service: string, name: string): { kit: Toolkit; f: Fn } {
  const kit = store.toolkit(service);
  if (!kit) throw new LibraryError(`there's no toolkit "${service}"; library lists them`);
  const f = store.fn(service, name);
  if (!f) throw new LibraryError(`the toolkit ${service} has no function "${name}"; library with service "${service}" lists its functions`);
  return { kit, f };
}

/** Runs one function inside a run; `parent` is the stop signal of the function that runs it. */
async function call(kit: Toolkit, f: Fn, input: unknown, budget: Budget, depth: number, parent: AbortSignal | null): Promise<Outcome> {
  const stop = new AbortController(); // the sandbox aborts it as the function ends
  const onParent = () => stop.abort();
  parent?.addEventListener("abort", onParent, { once: true });
  const state = { read: false, value: null as unknown, changed: false };
  try {
    const outcome = await runScript({ source: f.source, input, kit: kitFor(kit, f, budget, depth, state, stop.signal), prelude: budget.start.prelude, deadline: budget.deadline, stop });
    if (outcome.ok && state.changed) store.saveState(kit.service, f.name, state.value);
    return outcome;
  } finally {
    parent?.removeEventListener("abort", onParent);
  }
}

const logged = (v: unknown) => (typeof v === "string" ? v : (JSON.stringify(v) ?? String(v)));

function kitFor(kit: Toolkit, f: Fn, budget: Budget, depth: number, state: { read: boolean; value: unknown; changed: boolean }, signal: AbortSignal): Kit {
  return {
    http: (req) => http(kit, f, (req ?? {}) as Request, budget, signal),
    log: (...args) => {
      if (budget.logs.length < LIMITS.logs) budget.logs.push(mask(args.map(logged).join(" "), budget.secrets).slice(0, LIMITS.logChars));
    },
    run: async (name, input) => {
      if (depth + 1 >= LIMITS.depth) throw new LibraryError(`functions run functions at most ${LIMITS.depth} deep`);
      const q = store.qualified(name);
      const next = loaded(q.service, q.name);
      const outcome = await call(next.kit, next.f, store.inputChecked(next.f, input), budget, depth + 1, signal);
      if (outcome.ok) return outcome.value;
      throw new LibraryError(`${q.service}.${q.name} failed: ${outcome.error.name}: ${outcome.error.message}${outcome.error.line ? ` (its line ${outcome.error.line})` : ""}`);
    },
    state: {
      get: () => {
        if (!state.read) Object.assign(state, { read: true, value: store.stateOf(kit.service, f.name) });
        return state.value;
      },
      set: (value) => {
        if ((JSON.stringify(value ?? null) ?? "").length > store.MAX_STATE) throw new LibraryError(`what a function keeps is at most ${store.MAX_STATE / 1024} KB as JSON`);
        Object.assign(state, { read: true, value: value ?? null, changed: true });
      },
    },
    sleep: (ms) =>
      new Promise((resolve, reject) => {
        const stopped = () => (clearTimeout(timer), reject(new LibraryError("the run stopped")));
        const timer = setTimeout(() => (signal.removeEventListener("abort", stopped), resolve(undefined)), Math.min(Math.max(Number(ms) || 0, 0), LIMITS.sleepMs));
        signal.addEventListener("abort", stopped, { once: true });
      }),
  };
}

interface Request {
  method?: string;
  path?: string;
  url?: string;
  params?: unknown;
  headers?: unknown;
  body?: unknown;
  /** The toolkit key to send, by its name; the first by default; false for none. */
  auth?: string | false;
}

/** One request a function sends: to its toolkit's hosts only, with its toolkit's key. */
async function http(kit: Toolkit, f: Fn, req: Request, budget: Budget, signal: AbortSignal) {
  if (++budget.requests > LIMITS.requests) throw new LibraryError(`a run sends at most ${LIMITS.requests} requests`);
  const target = new URL(req.url ? checkUrl(req.url) : `${kit.base_urls[0]}/${String(req.path ?? "").replace(/^\//, "")}`);
  const hosts = store.hostsOf(kit);
  if (!hosts.some((h) => onSite(target.hostname, h))) throw new LibraryError(`${target.hostname} isn't one of the ${kit.service} toolkit's hosts (${hosts.join(", ")}): add it to the toolkit's hosts if its API sends there`);
  const label = req.auth === false || req.auth === "none" ? null : typeof req.auth === "string" ? req.auth : (kit.secrets[0]?.label ?? null);
  const key = label ? kit.secrets.find((s) => s.label.toLowerCase() === label.toLowerCase()) : null;
  if (label && !key) throw new LibraryError(`the ${kit.service} toolkit has no key "${label}"; its keys are ${kit.secrets.map((s) => s.label).join(", ") || "none"}`);
  const made = { method: String(req.method || "GET").toUpperCase(), host: target.host, path: target.pathname, ms: 0 };
  const t0 = Date.now();
  try {
    const sent = await send(target, req, key ?? null, `${kit.service}.${f.name}`, signal);
    if (sent.secret && !budget.secrets.includes(sent.secret)) budget.secrets.push(sent.secret);
    budget.made.push({ ...made, status: sent.answer.status, ms: Date.now() - t0 });
    const got = textOf(sent.answer);
    const text = mask(got.text, budget.secrets);
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    const status = sent.answer.status;
    return { status, ok: status >= 200 && status < 300, headers: shownHeaders(sent.answer.headers), body: got.binary ? null : body, cut: got.cut, ...(got.binary ? { binary: got.bytes } : {}) };
  } catch (e) {
    budget.made.push({ ...made, error: (e as Error).message.slice(0, 200), ms: Date.now() - t0 });
    throw e;
  }
}

/** A run as the agent reads it. */
export function runText(run: RunRecord): string {
  const lines = [`Ran ${run.fn} (${run.id}): ${run.status}, ${(run.ms / 1000).toFixed(1)} s, ${run.calls.length} request${run.calls.length === 1 ? "" : "s"}.`];
  if (run.status === "ok") lines.push(...clipped("Result", "JSON", JSON.stringify(run.result, null, 1) ?? "null", run.result));
  else if (run.error) lines.push(`Error: ${run.error.name}: ${run.error.message}${run.error.line ? ` (line ${run.error.line} of the function)` : ""}`);
  if (run.logs.length) lines.push("", `Log (${run.logs.length > 20 ? "the last 20 lines" : "every line"}):`, ...run.logs.slice(-20));
  if (run.calls.length) {
    lines.push("", "Requests:");
    for (const c of run.calls.slice(-20)) lines.push(`- ${c.method} ${c.host}${c.path}: ${c.status ?? c.error} (${c.ms} ms)`);
  }
  lines.push("", DATA);
  return lines.join("\n");
}
