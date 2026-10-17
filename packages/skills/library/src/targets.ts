// The machines the library's functions run commands on over SSH, which the user registers on the
// Library page: each a vault entry of kind "ssh" (#shared/vault) holding its host, port and login,
// the private key it signs in with, and the SHA-256 fingerprint of the host key the machine must
// show. A function names a target and nothing else of it (runs.ts), so the key goes to its own
// machine and nowhere else, and never into a script. What a target is (a cloud VM, a Pi, a port
// this machine forwards) is the user's: the library sees a host and a port.
//
// The connection goes through the fence (#shared/net connect). A private address is reached only as
// a target the user ticked "on my network", at its own host and port; FENCE_ALLOW plays no part.
// The client is ssh2 (docs/notes/README.md): public-key sign-in only, no agent, no forwarding, no
// X11, and a channel the machine opens toward us is refused (ssh2 refuses any it didn't ask for).

import crypto from "node:crypto";
import net from "node:net";
import { Client, utils, type ClientChannel } from "ssh2";
import { perProcess, used } from "#shared/anythingllm";
import { NetError, hostRefused } from "#shared/fence";
import { connect } from "#shared/net";
import * as vault from "#shared/vault";
import { LibraryError } from "./errors";

const LIMITS = {
  connectMs: 10 * 1000,
  /** A command's time, in seconds as kit.ssh.exec's timeout_s: by default and at most. */
  execS: 30,
  execMaxS: 300,
  outBytes: 256 * 1024,
  outMaxBytes: 1024 * 1024,
  stdinBytes: 1024 * 1024,
  commandChars: 32 * 1024,
  /** Commands going at once on one target, from one process; more wait their turn. */
  perTarget: 4,
  perMinute: 60,
  /** How long a stopped command has between TERM and its channel being closed. */
  killMs: 2000,
};

const NAME = /^[a-z][a-z0-9-]{1,30}$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const LOGIN = /^[a-z_][a-z0-9_.-]{0,31}$/i;
const FINGERPRINT = /SHA256:[A-Za-z0-9+/]{43}/;

/** A target as the agent and the page see it: never its key. */
export interface Target {
  label: string;
  host: string;
  port: number;
  login: string;
  fingerprint: string;
  /** Whether the user ticked "on my network": the host may be a private address. */
  private: boolean;
  /** Whether scheduled jobs may use it. */
  unattended: boolean;
  /** The public half of a key made on the page, for the machine's authorized_keys; null for a pasted one. */
  public: string | null;
  /** How the last try went: "signed in", or why not; "not tried yet". */
  status: string;
}

interface Entry extends vault.Entry {
  kind: "ssh";
  port: number;
  login: string;
  key: string;
  fingerprint: string;
  private: boolean;
  unattended: boolean;
  public: string | null;
  status: string | null;
}

const named = (label: string) => (e: Readonly<vault.Entry>): e is Entry => e.kind === "ssh" && e.user === label;
const found = (label: string) => vault.entries().find(named(label)) as Entry | undefined;
const shown = (e: Readonly<Entry>): Target => ({
  label: e.user,
  host: e.site,
  port: e.port,
  login: e.login,
  fingerprint: e.fingerprint,
  private: e.private,
  unattended: e.unattended,
  public: e.public,
  status: e.status ?? "not tried yet",
});

/** A target's name, checked. */
export function nameOf(raw: unknown): string {
  const name = String(raw ?? "").trim().toLowerCase();
  if (!NAME.test(name)) throw new LibraryError('a target is named in lower-case letters, digits and -, 2 to 31 of them, starting with a letter, like "pi" or "build-vm"');
  return name;
}

/** The saved targets, without their keys. */
export const targets = (): Target[] => vault.entries().filter((e): e is Entry => e.kind === "ssh").map(shown);

/** The SHA-256 fingerprint of a host key, as ssh-keygen -l writes it. */
const fingerprintOf = (key: Buffer): string => `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;

/** A target as the user gives it on the page; `key` is a pasted private key, opened from its seal,
 *  or empty to keep the one saved (or, for a new target, make one). */
export interface Given {
  label: unknown;
  host: unknown;
  port: unknown;
  login: unknown;
  fingerprint: unknown;
  private: unknown;
  unattended: unknown;
  key: string;
}

/** Saves a target; its name. A key made here keeps its public half for the page to show. */
export async function save(given: Given): Promise<string> {
  const label = nameOf(given.label);
  const host = String(given.host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!(HOST.test(host) || net.isIP(host))) throw new LibraryError("a target's host is a name or an address, like build.example.com or 192.168.1.20");
  const port = Number(String(given.port ?? "").trim() || 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new LibraryError("a target's port is a number from 1 to 65535");
  const login = String(given.login ?? "").trim();
  if (!LOGIN.test(login)) throw new LibraryError("a target needs the account to sign in as, like sandbox");
  const fingerprint = String(given.fingerprint ?? "").match(FINGERPRINT)?.[0];
  if (!fingerprint) throw new LibraryError("a target needs its host key's fingerprint, SHA256:… as ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub prints it on the machine");
  const onNetwork = given.private === true;
  const why = hostRefused(host, new Set());
  if (why && why !== "lookup" && !onNetwork) throw new LibraryError(`${why}: tick "On my network" to reach it as this target`);
  const was = found(label);
  let key = given.key.trim();
  let pub: string | null = null;
  if (key) {
    // No passphrase: the vault keeps the key encrypted already, and opening one on every connect
    // costs about 0.4 s of pure-JavaScript bcrypt.
    const parsed = utils.parseKey(key);
    if (parsed instanceof Error || Array.isArray(parsed) || !parsed.isPrivateKey()) throw new LibraryError(`that isn't a private key ssh can sign in with, without a passphrase (ssh-keygen -p -N "" -f <file> removes one)${parsed instanceof Error ? `: ${parsed.message}` : ""}`);
    key = `${key}\n`;
  } else if (was) [key, pub] = [was.key, was.public];
  else {
    const made = utils.generateKeyPairSync("ed25519", { comment: `library-lean ${label}` });
    [key, pub] = [made.private, made.public.trim()];
  }
  const entry = { kind: "ssh" as const, site: host, user: label, port, login, key, fingerprint, private: onNetwork, unattended: given.unattended === true, public: pub, status: null };
  await vault.update((v) => {
    const at = v.entries.findIndex(named(label));
    if (at >= 0) v.entries[at] = { id: v.entries[at].id, ...entry };
    else v.entries.push({ id: vault.newId(), ...entry });
  });
  return label;
}

/** Deletes a target and its key; whether there was one. */
export const remove = (label: string): Promise<boolean> =>
  vault.update((v) => {
    const before = v.entries.length;
    v.entries = v.entries.filter((e) => !named(label)(e));
    return v.entries.length < before;
  });

/** Signs in to a target once, without running anything, and keeps how it went for the page and the
 *  agent to see. */
export async function check(label: string): Promise<void> {
  const e = found(label);
  if (!e) return;
  let said = "signed in";
  try {
    (await open(e, Date.now() + LIMITS.connectMs)).end();
  } catch (err) {
    if (!(err instanceof NetError || err instanceof LibraryError)) throw err;
    said = err.message;
  }
  await vault.update((v) => {
    const now = v.entries.find(named(label)) as Entry | undefined;
    if (now) now.status = said;
  });
}

/** A turn at one of a target's command slots: waits for one to free up, at most until `until`. */
async function turn(label: string, until: number, signal?: AbortSignal): Promise<() => void> {
  const going = perProcess("library-lean.ssh-going", () => new Map<string, number>());
  while ((going.get(label) ?? 0) >= LIMITS.perTarget) {
    if (Date.now() >= until || signal?.aborted) throw new LibraryError(`the target "${label}" has ${LIMITS.perTarget} commands going already: try again when one ends`);
    await new Promise((r) => setTimeout(r, 50));
  }
  going.set(label, (going.get(label) ?? 0) + 1);
  return () => going.set(label, going.get(label)! - 1);
}

/** A signed-in connection to the target `e`, by `until`: its host key checked against the pinned
 *  fingerprint before anything else is said. */
async function open(e: Readonly<Entry>, until: number, signal?: AbortSignal): Promise<Client> {
  const label = e.user;
  const timeout = Math.max(1000, Math.min(LIMITS.connectMs, until - Date.now()));
  const sock = await connect({ host: e.site, port: e.port, allow: e.private ? [e.site] : [], timeout, signal });
  const client = new Client();
  let seen = "";
  return new Promise((resolve, reject) => {
    // Until it's signed in, a stop ends the connection; after, the command's own stop does (run).
    const onAbort = () => failed(new Error("the run stopped"));
    const failed = (err: Error & { level?: string }) => {
      signal?.removeEventListener("abort", onAbort);
      client.end();
      sock.destroy();
      if (seen && seen !== e.fingerprint) return reject(new LibraryError(`the target "${label}" showed a host key that isn't the one saved for it (saved ${e.fingerprint}, shown ${seen}): nothing was sent. If the machine was set up again, the user saves its new fingerprint on the Library page`));
      if (err.level === "client-authentication") return reject(new LibraryError(`the target "${label}" refused its key: the public line goes in ~${e.login}/.ssh/authorized_keys on the machine (the Library page shows it)`));
      if (err.level === "client-timeout") return reject(new LibraryError(`the target "${label}" (${e.site}:${e.port}) didn't finish signing in within ${Math.round(timeout / 1000)} s`));
      reject(new LibraryError(`the target "${label}" (${e.site}:${e.port}) couldn't be reached: ${err.message}`));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    client.once("ready", () => (signal?.removeEventListener("abort", onAbort), resolve(client)));
    client.once("error", failed);
    client.connect({ sock, username: e.login, privateKey: e.key, readyTimeout: timeout, hostVerifier: (key: Buffer) => (seen = fingerprintOf(key)) === e.fingerprint, tryKeyboard: false, agentForward: false });
  });
}

/** What kit.ssh.exec takes, besides `target`. */
export interface Exec {
  command?: unknown;
  stdin?: unknown;
  timeout_s?: unknown;
  max_bytes?: unknown;
}

export interface Ran {
  exit: number | null;
  /** The signal it ended by, as ssh2 names it ("SIGTERM"); null when it exited. */
  signal: string | null;
  stdout: string;
  stderr: string;
  /** Whether either stream was longer than max_bytes, and cut there. */
  truncated: boolean;
  /** Why the command was stopped: "timeout" or "stopped" (the run was); null when it ended. */
  killed: "timeout" | "stopped" | null;
  /** Whether a stopped command may still be going on the machine: it sent no exit status. */
  remote_may_run: boolean;
  ms: number;
}

const bounded = (v: unknown, fallback: number, max: number, what: string): number => {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new LibraryError(`${what} is a positive number`);
  return Math.min(n, max);
};

/** Runs `command` on the target `label`, by `deadline` at the latest; a stopped `signal` stops it.
 *  `job`: the run is a scheduled job's, which uses only a target the user said it may. */
export async function exec(label: string, req: Exec, { deadline, job, signal }: { deadline: number; job: boolean; signal?: AbortSignal }): Promise<Ran> {
  const e = found(label);
  if (!e) throw new LibraryError(`no target "${label}" is saved: ask the user for it with secret, kind "ssh"`);
  if (job && !e.unattended) throw new LibraryError(`scheduled jobs don't use the target "${label}": the user ticks "May run unattended" for it on the Library page`);
  const command = typeof req.command === "string" ? req.command : "";
  if (!command.trim() || command.length > LIMITS.commandChars || command.includes("\0")) throw new LibraryError(`kit.ssh.exec needs command, one line or a script of at most ${LIMITS.commandChars} characters`);
  if (req.stdin !== undefined && typeof req.stdin !== "string") throw new LibraryError("stdin is text");
  const stdin = (req.stdin as string | undefined) ?? "";
  if (Buffer.byteLength(stdin) > LIMITS.stdinBytes) throw new LibraryError(`stdin is at most ${LIMITS.stdinBytes / 1024 / 1024} MB`);
  const until = Math.min(Date.now() + bounded(req.timeout_s, LIMITS.execS, LIMITS.execMaxS, "timeout_s") * 1000, deadline);
  const max = Math.floor(bounded(req.max_bytes, LIMITS.outBytes, LIMITS.outMaxBytes, "max_bytes"));
  if (!used("library-lean.ssh-uses", label, LIMITS.perMinute)) throw new LibraryError(`the target "${label}" was used ${LIMITS.perMinute} times in the last minute: wait a minute, and do more in each command`);
  const t0 = Date.now();
  const done = await turn(label, until, signal);
  try {
    const client = await open(e, until, signal);
    try {
      return { ...(await run(client, command, stdin, max, until, signal)), ms: Date.now() - t0 };
    } finally {
      client.end();
    }
  } finally {
    done();
  }
}

/** Sends the command TERM. ssh2's own stream.signal sends nothing once our side is ended, and it is
 *  as soon as stdin is sent, so the request goes through its protocol (ssh2 is pinned exactly; a
 *  test checks these internals are there, and the e2e that OpenSSH acts on it). */
export function term(stream: ClientChannel): void {
  const channel = stream as unknown as { outgoing?: { id: number; state: string }; _client?: { _protocol?: { signal(id: number, name: string): void } } };
  if (channel.outgoing && ["open", "eof"].includes(channel.outgoing.state)) channel._client?._protocol?.signal(channel.outgoing.id, "TERM");
}

/** The command on a signed-in connection, to its end or until it's stopped. */
function run(client: Client, command: string, stdin: string, max: number, until: number, signal: AbortSignal | undefined): Promise<Omit<Ran, "ms">> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err: Error | undefined, stream: ClientChannel) => {
      if (err) return reject(new LibraryError(`the target didn't run it: ${err.message}`));
      let truncated = false;
      /** Keeps the first `max` bytes of a stream in `into`, and notes when there were more. */
      const keep = (into: Buffer[]) => {
        let n = 0;
        return (chunk: Buffer) => {
          if (n < max) into.push(chunk.subarray(0, max - n));
          n += chunk.length;
          if (n > max) truncated = true;
        };
      };
      const out: Buffer[] = [];
      const errs: Buffer[] = [];
      stream.on("data", keep(out));
      stream.stderr.on("data", keep(errs));
      let exit: number | null = null;
      let sig: string | null = null;
      let exited = false;
      let killed: Ran["killed"] = null;
      let settled = false;
      let hard: NodeJS.Timeout | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(hard);
        signal?.removeEventListener("abort", onAbort);
        resolve({ exit, signal: sig, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(errs).toString("utf8"), truncated, killed, remote_may_run: killed !== null && !exited });
      };
      const stop = (why: "timeout" | "stopped") => {
        if (killed || settled) return;
        killed = why;
        term(stream);
        hard = setTimeout(() => (stream.close(), finish()), LIMITS.killMs);
      };
      const timer = setTimeout(() => stop("timeout"), Math.max(0, until - Date.now()));
      const onAbort = () => stop("stopped");
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort(); // stopped while the machine was starting it
      stream.on("exit", (code: number | null, name?: string) => ((exited = true), (exit = typeof code === "number" ? code : null), (sig = name ?? null)));
      stream.on("close", finish);
      stream.end(stdin || undefined);
    });
  });
}
