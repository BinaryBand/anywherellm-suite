// What the library keeps, in AnythingLLM's storage (<storage>/library-lean/), outside the skill's
// own folder, so an uninstall keeps it. One folder per service, its toolkit:
//
//   toolkits/<service>/toolkit.json          what the agent learned of the API, and which keys it calls with
//   toolkits/<service>/functions/<fn>.json   a function: its description, inputs and source
//   toolkits/<service>/functions/<fn>.v<N>.json   its earlier versions, the last KEEP_VERSIONS
//   toolkits/<service>/state/<fn>.json       what it keeps between runs (kit.state)
//   runs/<id>.<service>.<fn>.json            each run, the last MAX_RUNS; an id sorts by time
//   unseen/<id>                              a run whose end no answer has shown yet
//
// Every file is written whole (writeAtomic), so a reader never sees half of one, and a run is a file
// of its own, so a chat and a scheduled job's process never write the same one.

import fs from "node:fs";
import path from "node:path";
import { objectOf } from "#shared/answer";
import { storageDir } from "#shared/anythingllm";
import { readJson as readJsonOr, writeAtomic } from "#shared/atomic";
import { checkUrl, hostOf } from "#shared/fence";
import { staticFiles, type StaticFiles } from "#shared/static";
import { LibraryError } from "./errors";
import { asOf, labelOf, publicSite } from "./secrets";

const SERVICE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FUNCTION = /^[a-z][a-z0-9_]{0,39}$/;
const INPUT_TYPES = ["string", "number", "boolean", "object", "array"];
const KEEP_VERSIONS = 5;
const MAX_RUNS = 300;
const MAX_NOTES = 16000;
const MAX_DOCS = 20;
/** What a function keeps between runs, as JSON. */
export const MAX_STATE = 64 * 1024;

/** A key a toolkit calls with, by name: not the key itself (secrets.ts has that). */
export interface KeyUse {
  /** The saved key's name (secrets.ts). */
  label: string;
  /** How it goes with a request (secrets.ts's asOf). */
  as: string;
}

export interface Toolkit {
  service: string;
  title: string;
  /** Where its API is; a function's path is relative to the first. */
  base_urls: string[];
  /** Hosts its functions may reach besides the base addresses' (hostsOf has them all). */
  hosts: string[];
  /** The keys its functions call with, the first unless a request names another. */
  secrets: KeyUse[];
  docs: string[];
  /** What the agent learned of the API: endpoints, paging, limits, quirks. */
  notes: string;
  updated: string;
}

export interface Input {
  type: string;
  required?: boolean;
  about?: string;
}

export interface Fn {
  name: string;
  description: string;
  inputs: Record<string, Input>;
  source: string;
  version: number;
  updated: string;
}

export interface RunRecord {
  id: string;
  fn: string;
  trigger: "chat" | "job";
  workspace: string | null;
  /** The process it runs in, and when it must have ended: while it's running. */
  pid?: number;
  until?: string;
  started: string;
  /** When it ended (while it's running, when it started). */
  ended: string;
  ms: number;
  /** "interrupted": its process ended before it did (a restart, a scheduled job's time running out). */
  status: "running" | "ok" | "error" | "timeout" | "stopped" | "interrupted";
  result?: unknown;
  error?: { name: string; message: string; line?: number };
  logs: string[];
  calls: { method: string; host: string; path: string; status?: number; error?: string; ms: number }[];
}

/** The library's folder in AnythingLLM's storage. */
export const libraryDir = (): string => path.join(storageDir(), "library-lean");
/** The skill's static files (guide, snippets, prelude, pages), as shipped or as tuned on this
 *  instance, under <storage>/library-lean/static/. */
export const statics = (): StaticFiles => staticFiles(STATIC_FILES, path.join(libraryDir(), "static"));
const kitDir = (service: string) => path.join(libraryDir(), "toolkits", service);
const fnFile = (service: string, name: string) => path.join(kitDir(service), "functions", `${name}.json`);
const runsDir = () => path.join(libraryDir(), "runs");
const unseenDir = () => path.join(libraryDir(), "unseen");

function readJson<T>(file: string): T | null {
  try {
    return readJsonOr<T | null>(file, () => null);
  } catch (e) {
    throw new LibraryError(`${path.relative(libraryDir(), file)} can't be read: ${(e as Error).message}`);
  }
}

const writeJson = (file: string, value: unknown) => writeAtomic(file, JSON.stringify(value, null, 2) + "\n", 0o600);

/** The names in a folder, or none when there's no folder. */
const namesIn = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
};

/** A service's name, checked. */
export function serviceOf(raw: unknown): string {
  const service = String(raw ?? "").trim().toLowerCase();
  if (!SERVICE.test(service)) throw new LibraryError('a service is named in lower-case letters, digits and -, like "github" or "google-calendar"');
  return service;
}

/** "service.function", checked, as its two names. */
export function qualified(raw: unknown): { service: string; name: string } {
  const [service, name, ...more] = String(raw ?? "").trim().toLowerCase().split(".");
  if (more.length || !name || !SERVICE.test(service) || !FUNCTION.test(name)) throw new LibraryError('a function is named service.function, like "github.list_issues" (the function in lower-case letters, digits and _)');
  return { service, name };
}

/** The services the library has a toolkit for, sorted. */
export const services = (): string[] => namesIn(path.join(libraryDir(), "toolkits")).filter((s) => SERVICE.test(s) && fs.existsSync(path.join(kitDir(s), "toolkit.json")));

export const toolkit = (service: string): Toolkit | null => readJson<Toolkit>(path.join(kitDir(service), "toolkit.json"));

/** Every host a toolkit's functions may reach: its base addresses' and the others it names. */
export const hostsOf = (kit: Toolkit): string[] => [...new Set([...kit.base_urls.map(hostOf), ...kit.hosts])];

const strings = (value: unknown, what: string): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new LibraryError(`${what} is a list`);
  return value.map((v) => String(v).trim()).filter(Boolean);
};

/** An address a toolkit names, checked: http(s), without a trailing slash. */
const urlChecked = (url: string): string => checkUrl(url).replace(/\/$/, "");

/** Saves a toolkit: what's given replaces what was there, and the rest stays. */
export function saveToolkit(service: string, given: Record<string, unknown>): Toolkit {
  const was = toolkit(service);
  const pick = <T,>(key: keyof Toolkit, make: (v: unknown) => T, fallback: T): T => (given[key] !== undefined ? make(given[key]) : was ? (was[key] as T) : fallback);
  const base_urls = pick("base_urls", (v) => strings(v, "base_urls").map(urlChecked), [] as string[]);
  if (!base_urls.length) throw new LibraryError('a toolkit needs base_urls, where its API is, like ["https://api.github.com"]');
  const hosts = pick(
    "hosts",
    (v) =>
      strings(v, "hosts").map((h) => {
        const host = publicSite(h);
        if (!host) throw new LibraryError(`"${h}" isn't a public host, like "uploads.github.com"`);
        return host;
      }),
    [] as string[],
  );
  const secrets = pick(
    "secrets",
    (v) => {
      if (!Array.isArray(v)) throw new LibraryError('secrets is a list, like [{ "label": "github", "as": "bearer" }]');
      return v.map((s) => ({ label: labelOf((s as KeyUse)?.label), as: asOf((s as KeyUse)?.as) }));
    },
    [] as KeyUse[],
  );
  const notes = pick("notes", (v) => String(v ?? ""), "");
  if (notes.length > MAX_NOTES) throw new LibraryError(`a toolkit's notes are at most ${MAX_NOTES} characters: keep what a function needs`);
  const kit: Toolkit = {
    service,
    title: pick("title", (v) => String(v ?? "").trim().slice(0, 100), service) || service,
    base_urls,
    hosts,
    secrets,
    docs: pick("docs", (v) => strings(v, "docs").map(urlChecked).slice(0, MAX_DOCS), [] as string[]),
    notes,
    updated: new Date().toISOString(),
  };
  writeJson(path.join(kitDir(service), "toolkit.json"), kit);
  return kit;
}

/** Removes a toolkit and its functions; its keys stay in the vault. */
export function removeToolkit(service: string): boolean {
  if (!toolkit(service)) return false;
  fs.rmSync(kitDir(service), { recursive: true, force: true });
  return true;
}

export const fn = (service: string, name: string): Fn | null => readJson<Fn>(fnFile(service, name));

/** The names of a toolkit's functions, without reading them. */
export const functionNames = (service: string): string[] =>
  namesIn(path.join(kitDir(service), "functions"))
    .filter((f) => /^[a-z][a-z0-9_]*\.json$/.test(f))
    .map((f) => f.slice(0, -5));

/** A toolkit's functions, by name. */
export const functions = (service: string): Fn[] => functionNames(service).map((name) => fn(service, name)).filter((f): f is Fn => f !== null);

/** The inputs a function takes, checked. */
function inputsOf(value: unknown): Record<string, Input> {
  const inputs: Record<string, Input> = {};
  for (const [name, spec] of Object.entries(objectOf(value, "inputs") as Record<string, Input>)) {
    if (!/^[a-z][a-z0-9_]{0,30}$/.test(name)) throw new LibraryError(`the input "${name}" is named in lower-case letters, digits and _`);
    const type = String(spec?.type ?? "string");
    if (!INPUT_TYPES.includes(type)) throw new LibraryError(`the input ${name}'s type is one of ${INPUT_TYPES.join(", ")}`);
    inputs[name] = { type, ...(spec?.required ? { required: true } : {}), ...(spec?.about ? { about: String(spec.about).slice(0, 200) } : {}) };
  }
  return inputs;
}

/** Saves a function, keeping the version it replaces; answers it as saved. */
export function saveFn(service: string, name: string, given: { description?: unknown; inputs?: unknown; source: string }): Fn {
  const was = fn(service, name);
  const saved: Fn = {
    name,
    description: String(given.description ?? was?.description ?? "").trim().slice(0, 500),
    inputs: given.inputs === undefined && was ? was.inputs : inputsOf(given.inputs),
    source: given.source,
    version: (was?.version ?? 0) + 1,
    updated: new Date().toISOString(),
  };
  if (!saved.description) throw new LibraryError("a function needs a description: what it does, in one line");
  if (was) {
    writeJson(path.join(kitDir(service), "functions", `${name}.v${was.version}.json`), was);
    fs.rmSync(path.join(kitDir(service), "functions", `${name}.v${was.version - KEEP_VERSIONS}.json`), { force: true });
  }
  writeJson(fnFile(service, name), saved);
  return saved;
}

/** Removes a function, its earlier versions and its state. */
export function removeFn(service: string, name: string): boolean {
  if (!fn(service, name)) return false;
  const dir = path.join(kitDir(service), "functions");
  for (const file of namesIn(dir)) if (file === `${name}.json` || file.startsWith(`${name}.v`)) fs.rmSync(path.join(dir, file), { force: true });
  fs.rmSync(path.join(kitDir(service), "state", `${name}.json`), { force: true });
  return true;
}

/** `input` as the function takes it: every required input, each of its type, and no other. */
export function inputChecked(f: Fn, input: unknown): Record<string, unknown> {
  const values = objectOf(input, "inputs");
  for (const [name, spec] of Object.entries(f.inputs)) {
    const v = values[name];
    if (v === undefined || v === null) {
      if (spec.required) throw new LibraryError(`${f.name} needs the input ${name}${spec.about ? ` (${spec.about})` : ""}`);
      continue;
    }
    const kind = Array.isArray(v) ? "array" : typeof v;
    if (kind !== spec.type) throw new LibraryError(`${f.name}'s input ${name} is a ${spec.type}, not a ${kind}`);
  }
  const unknown = Object.keys(values).filter((k) => !(k in f.inputs));
  if (unknown.length) throw new LibraryError(`${f.name} takes no input ${unknown.join(", ")}; it takes ${Object.keys(f.inputs).join(", ") || "none"}`);
  return values;
}

export const stateOf = (service: string, name: string): unknown => readJson<{ value: unknown }>(path.join(kitDir(service), "state", `${name}.json`))?.value ?? null;

/** Keeps what a function keeps between runs (within MAX_STATE, which kit.state.set checks). */
export const saveState = (service: string, name: string, value: unknown): void => writeAtomic(path.join(kitDir(service), "state", `${name}.json`), JSON.stringify({ value }), 0o600);

/** A new run's id: r-<time>-<random>, which sorts by time. */
export const runId = (at: Date): string => `r-${at.getTime().toString(36).padStart(9, "0")}-${Math.random().toString(36).slice(2, 8)}`;

const runFile = (run: RunRecord) => path.join(runsDir(), `${run.id}.${run.fn}.json`);

/** Keeps a new run, and drops the oldest past MAX_RUNS. */
export function record(run: RunRecord): void {
  rewrite(run);
  const files = namesIn(runsDir()).filter((f) => f.startsWith("r-"));
  for (const old of files.slice(0, Math.max(0, files.length - MAX_RUNS))) fs.rmSync(path.join(runsDir(), old), { force: true });
}

/** Keeps a run again, as it is now (ended, or interrupted). */
export const rewrite = (run: RunRecord): void => writeJson(runFile(run), run);

const readRun = (file: string) => readJson<RunRecord>(path.join(runsDir(), file));

/** The last `n` runs, newest first, of a service's functions (`service`) or of all, as recorded. */
export function recentRuns(n: number, service: string): RunRecord[] {
  const files = namesIn(runsDir()).filter((f) => f.startsWith("r-") && (!service || f.split(".")[1] === service));
  return files
    .slice(-n)
    .reverse()
    .map(readRun)
    .filter((r): r is RunRecord => r !== null);
}

/** A run by its id, as recorded; null when it isn't kept. */
export function runOf(id: string): RunRecord | null {
  if (!/^r-[\w-]+$/.test(id)) return null;
  const file = namesIn(runsDir()).find((f) => f.startsWith(`${id}.`));
  return file ? readRun(file) : null;
}

/** Marks a run as not shown yet: every run, as it starts, until an answer shows how it ended. One
 *  file each, so no process writes another's. */
export const markUnseen = (id: string): void => writeAtomic(path.join(unseenDir(), id), "", 0o600);

export const markSeen = (id: string): void => fs.rmSync(path.join(unseenDir(), id), { force: true });

/** The runs not shown yet, oldest first, as recorded; a mark whose run is no longer kept goes. */
export function unseen(): RunRecord[] {
  const files = new Map(namesIn(runsDir()).map((f) => [f.slice(0, f.indexOf(".")), f]));
  return namesIn(unseenDir()).flatMap((id) => {
    const file = files.get(id);
    if (!file) markSeen(id);
    const run = file ? readRun(file) : null;
    return run ? [run] : [];
  });
}
