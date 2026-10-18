// Where a function runs: QuickJS, a JavaScript engine compiled to WebAssembly, inside AnythingLLM's
// own process (docs/notes/skills/library). A function is a script defining
// `async function main(input, kit)`; it sees its input, the `kit` the host hands it and nothing
// else: no require, no process, no files, no network but what a kit function does for it. Each run
// gets a runtime of its own, with a memory limit, a stack limit and a deadline; a run that passes
// its deadline is stopped whether it's computing or waiting on the host.
//
// The host's kit functions take and answer JSON values. One that answers a promise is awaited by the
// script as a promise; the host resolves it and runs the script on from there. The sync build of
// QuickJS is used, which can't suspend inside a host call, so every await is a real promise: the
// script reads the same as with the async build, and one compiled module serves every run.

import { newQuickJSWASMModuleFromVariant, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSWASMModule } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import { perProcess } from "#shared/anythingllm";
import { Told } from "#shared/errors";

export const LIMITS = {
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  /** What the run's answer may be, as JSON. */
  resultChars: 64 * 1024,
  sourceChars: 32 * 1024,
  /** The longest a script computes without awaiting: it runs on AnythingLLM's own thread, which
   *  serves nothing else meanwhile, and can't be stopped from outside until it awaits. */
  busyMs: 2 * 1000,
};

/** What a script's kit offers: functions that take JSON values and answer one, or a promise of one,
 *  and groups of them (kit.state.get). An error that is Told reaches the script by its name and
 *  message; any other only as "kit.<name> failed", so nothing of the host leaks into it. */
export interface Kit {
  [name: string]: ((...args: unknown[]) => unknown) | Kit;
}

/** A script that went wrong: what the agent is shown. `line` is the script's own, when known. */
export interface Failure {
  name: string;
  message: string;
  line?: number;
}

/** A failure as one line: its name, its message and its line. */
export const failureText = (f: Failure): string => `${f.name}: ${f.message}${f.line ? ` (line ${f.line})` : ""}`;

export type Outcome = { ok: true; value: unknown } | { ok: false; error: Failure };

export interface Run {
  source: string;
  input: unknown;
  kit: Kit;
  /** Scripts run before the function, by name ("prelude/paginate.js"): they may add to `kit`. */
  prelude?: Record<string, string>;
  /** When the run is stopped, in ms since the epoch. */
  deadline: number;
  /** Aborted when the run stops, so the host can drop what it was doing for it. */
  stop?: AbortController;
}

/** The compiled QuickJS module, made once per process. */
const quickjs = (): Promise<QuickJSWASMModule> => perProcess(`library-lean.quickjs ${VENDORED_VERSIONS}`, () => newQuickJSWASMModuleFromVariant(variant));

/** The line in the function's own source that an error's stack names, if any. */
function lineOf(stack: unknown): number | undefined {
  const m = String(stack ?? "").match(/main\.js:(\d+)/);
  return m ? Number(m[1]) : undefined;
}

/** What went wrong, from a value the script threw (an Error, or anything else). */
function failureOf(thrown: unknown): Failure {
  if (thrown && typeof thrown === "object" && "message" in thrown) {
    const e = thrown as { name?: string; message?: string; stack?: string };
    return { name: e.name || "Error", message: String(e.message), line: lineOf(e.stack) };
  }
  return { name: "Error", message: `the function threw ${JSON.stringify(thrown)?.slice(0, 200)}` };
}

/** What went wrong, from the error handle an evaluation gave, which it disposes. */
function failure(ctx: QuickJSContext, error: QuickJSHandle): Failure {
  const thrown = ctx.dump(error);
  error.dispose();
  return failureOf(thrown);
}

const isPromise = (v: unknown): v is Promise<unknown> => !!v && typeof (v as Promise<unknown>).then === "function";

/** Why `source` doesn't compile or define main, with its line; null when it does. Its top level
 *  runs (as it would before main), briefly: it should only define things. */
export async function check(source: string): Promise<Failure | null> {
  if (source.length > LIMITS.sourceChars) return { name: "TooLong", message: `a function is at most ${LIMITS.sourceChars} characters` };
  const until = Date.now() + 500;
  const rt = (await quickjs()).newRuntime({ memoryLimitBytes: LIMITS.memoryBytes, interruptHandler: () => Date.now() > until });
  const ctx = rt.newContext();
  try {
    const defined = ctx.evalCode(`${source}\n;typeof main`, "main.js");
    if (defined.error) return failure(ctx, defined.error);
    const kind = ctx.dump(defined.value);
    defined.value.dispose();
    return kind === "function" ? null : { name: "NoMain", message: "a function defines async function main(input, kit)" };
  } finally {
    ctx.dispose();
    rt.dispose();
  }
}

/** Runs a function to its answer, or to what stopped it. Never throws for what the script does. */
export async function run({ source, input, kit, prelude = {}, deadline, stop = new AbortController() }: Run): Promise<Outcome> {
  /** When the script last went on (from the start, or from a promise the host settled), and whether
   *  it was interrupted for computing too long since. */
  let since = Date.now();
  let busy = false;
  const rt = (await quickjs()).newRuntime({
    memoryLimitBytes: LIMITS.memoryBytes,
    maxStackSizeBytes: LIMITS.stackBytes,
    interruptHandler: () => {
      if (Date.now() > deadline || stop.signal.aborted) return true;
      if (Date.now() - since <= LIMITS.busyMs) return false;
      busy = true;
      return true;
    },
  });
  const ctx = rt.newContext();
  const json = ctx.getProp(ctx.global, "JSON");
  const parse = ctx.getProp(json, "parse");
  const pending = new Set<QuickJSDeferredPromise>();
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    /** A JSON value made the script's own, through its JSON.parse: plain data, no host objects. */
    const fromJson = (value: unknown): QuickJSHandle => {
      if (value === undefined) return ctx.undefined;
      const text = ctx.newString(JSON.stringify(value));
      const parsed = ctx.callFunction(parse, json, text);
      text.dispose();
      return ctx.unwrapResult(parsed);
    };
    /** The kit as the script's own object: each function calls the host's, each group is an object. */
    const install = (target: QuickJSHandle, fns: Kit, prefix: string): void => {
      for (const [name, fn] of Object.entries(fns)) {
        const handle = typeof fn === "function" ? ctx.newFunction(name, (...args) => callHost(`${prefix}${name}`, fn, args.map((a) => ctx.dump(a)))) : ctx.newObject();
        if (typeof fn !== "function") install(handle, fn, `${prefix}${name}.`);
        ctx.setProp(target, name, handle);
        handle.dispose();
      }
    };
    const kitHandle = ctx.newObject();
    install(kitHandle, kit, "");
    ctx.setProp(ctx.global, "kit", kitHandle);
    kitHandle.dispose();

    /** A host function's answer as the script sees it: a value, or a promise the host settles. */
    function callHost(name: string, fn: (...args: unknown[]) => unknown, args: unknown[]): QuickJSHandle | { error: QuickJSHandle } {
      let answer: unknown;
      try {
        answer = fn(...args);
      } catch (e) {
        return { error: ctx.newError(hostMessage(name, e)) }; // thrown in the script
      }
      if (!isPromise(answer)) return fromJson(answer);
      const deferred = ctx.newPromise();
      pending.add(deferred);
      answer.then(
        (value) => settle(deferred, () => fromJson(value), "resolve"),
        (e) => settle(deferred, () => ctx.newError(hostMessage(name, e)), "reject"),
      );
      return deferred.handle;
    }

    function settle(deferred: QuickJSDeferredPromise, make: () => QuickJSHandle, how: "resolve" | "reject") {
      if (finished) return; // the run's outcome is decided: its script runs no further
      since = Date.now();
      pending.delete(deferred);
      const handle = make();
      deferred[how](handle);
      handle.dispose();
      deferred.dispose();
      pump();
    }

    /** Runs the script on from what the host settled. */
    function pump() {
      const done = rt.executePendingJobs();
      if (done.error) done.error.dispose(); // the script's own rejection reaches `settled`
    }

    for (const [name, text] of Object.entries(prelude)) {
      const done = ctx.evalCode(text, name);
      if (done.error) {
        const error = failure(ctx, done.error);
        return { ok: false, error: { ...error, message: `${name}: ${error.message}`, line: undefined } };
      }
      done.value.dispose();
    }

    const inputHandle = fromJson(input);
    ctx.setProp(ctx.global, "__input", inputHandle);
    inputHandle.dispose();
    since = Date.now();
    const started = ctx.evalCode(`${source}\n;main(globalThis.__input, kit)`, "main.js");
    if (started.error) return { ok: false, error: interrupted(failure(ctx, started.error)) };
    const settled = ctx.resolvePromise(started.value);
    started.value.dispose();
    pump();

    const outcome = await Promise.race([
      settled.then((result): Outcome => {
        if (result.error) return { ok: false, error: interrupted(failure(ctx, result.error)) };
        const value = ctx.dump(result.value);
        result.value.dispose();
        return answered(value);
      }),
      new Promise<Outcome>((resolve) => {
        const ended = () => ((finished = true), resolve({ ok: false, error: timedOut() }));
        timer = setTimeout(ended, Math.max(0, deadline - Date.now()));
        stop.signal.addEventListener("abort", ended, { once: true });
      }),
    ]);
    return outcome;
  } finally {
    finished = true;
    clearTimeout(timer);
    stop.abort();
    for (const deferred of pending) deferred.dispose();
    parse.dispose();
    json.dispose();
    ctx.dispose();
    rt.dispose();
  }

  function timedOut(): Failure {
    return stop.signal.aborted && Date.now() <= deadline ? { name: "Stopped", message: "the run was stopped" } : { name: "Timeout", message: "the function ran past its time and was stopped" };
  }

  /** An interrupt is QuickJS's way of saying the deadline passed, the run was stopped, or the
   *  script computed too long without awaiting. */
  function interrupted(error: Failure): Failure {
    if (error.name !== "InternalError" || error.message !== "interrupted") return error;
    const why = busy ? { name: "Busy", message: `the function computed for over ${LIMITS.busyMs / 1000} s without awaiting, which holds up AnythingLLM: do less at once (a page at a time), or await between batches` } : timedOut();
    return { ...why, line: error.line };
  }
}

function hostMessage(name: string, e: unknown): { name: string; message: string } {
  return e instanceof Told ? { name: e.name === "Error" ? "KitError" : e.name, message: e.message } : { name: "KitError", message: `kit.${name} failed` };
}

/** The answer as JSON the host keeps, within LIMITS.resultChars. */
function answered(value: unknown): Outcome {
  const text = JSON.stringify(value) ?? "null";
  if (text.length > LIMITS.resultChars) return { ok: false, error: { name: "TooLarge", message: `the answer is ${text.length} characters as JSON; at most ${LIMITS.resultChars}: return less (keep what the user needs, or count instead of listing)` } };
  return { ok: true, value: JSON.parse(text) };
}
