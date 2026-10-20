// What install records of the machine it runs on, for the library to refuse a target that is this
// machine: <storage>/anywherellm-suite/this-host.json holds the SHA-256 fingerprints of its SSH host
// keys (/etc/ssh/ssh_host_*_key.pub) and every address of every interface it has, as the host sees
// them (the container AnythingLLM runs in sees fewer: a tailnet address the host has isn't there).
// A machine that shows one of these keys, or answers from one of these addresses, is the host, and
// signing in there reads the vault's key and the pages' secrets (shared/thishost.mts). The library
// only reads the file, and refuses every target when it is missing or holds no key, so install
// writes it again each time it runs, and health says when it is missing or the host has changed.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SUITE_DIR } from "#shared/anythingllm";
import { writeAtomicIfChanged } from "#shared/atomic";
import { Told } from "#shared/errors";
import type { ThisHost } from "#shared/thishost";
import type { Check } from "./addons.mts";

/** The machine as install sees it: where its SSH host keys are, its interfaces and its name (a test
 *  says another). */
export interface HostView {
  sshDir: string;
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  hostname: string;
}

export const realHost = (): HostView => ({ sshDir: "/etc/ssh", interfaces: os.networkInterfaces(), hostname: os.hostname() });

/** `SHA256:…` of a public key line ("ssh-ed25519 AAAA… comment"), as ssh-keygen -lf prints it; null
 *  for a line that isn't one. */
export function fingerprintOf(line: string): string | null {
  const blob = line.trim().split(/\s+/)[1];
  if (!blob || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) return null;
  const key = Buffer.from(blob, "base64");
  return key.length ? `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}` : null;
}

/** What this host is: its host keys' fingerprints (none when /etc/ssh has none or can't be read) and
 *  its addresses, each sorted and once. */
export function recordOf(host: HostView): ThisHost {
  let names: string[] = [];
  try {
    names = fs.readdirSync(host.sshDir).filter((n) => /^ssh_host_.*_key\.pub$/.test(n));
  } catch {} // no sshd here: no keys, and health says so
  const fingerprints = names.flatMap((n) => {
    try {
      return fingerprintOf(fs.readFileSync(path.join(host.sshDir, n), "utf8")) ?? [];
    } catch {
      return [];
    }
  });
  const addresses = Object.values(host.interfaces).flatMap((list) => (list ?? []).map((a) => a.address.split("%", 1)[0]));
  return { fingerprints: [...new Set(fingerprints)].sort(), addresses: [...new Set(addresses)].sort(), hostname: host.hostname };
}

/** Refuses a path a link leads somewhere else from: the record is the host's own file, and a
 *  symbolic or hard link there would send what is written, or read, to another. */
function noLinks(file: string): void {
  const folder = path.dirname(file);
  try {
    if (fs.lstatSync(folder).isSymbolicLink()) throw new Told(`${folder} is a link; the record of this machine isn't written through it`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    const s = fs.lstatSync(file);
    if (s.isSymbolicLink() || s.nlink > 1 || !s.isFile()) throw new Told(`${file} is a link or not a plain file; the record of this machine isn't written there: remove it and run install again`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** The file that records the host in `storage`. */
export const thisHostPath = (storage: string): string => path.join(storage, SUITE_DIR, "this-host.json");

/** Records this machine in the storage; what it did. It never fails an install: a refusal or an
 *  error is said, and health then reports the file missing. */
export function putThisHost(storage: string, host: HostView = realHost()): string {
  const file = thisHostPath(storage);
  try {
    noLinks(file);
    const record = recordOf(host);
    const wrote = writeAtomicIfChanged(file, `${JSON.stringify(record, null, 2)}\n`, 0o644);
    const note = record.fingerprints.length ? "" : ` (no SSH host key in ${host.sshDir}: the library will refuse every SSH target until this machine has one)`;
    return `${wrote ? "recorded" : "unchanged:"} this machine (${record.fingerprints.length} SSH host key${record.fingerprints.length === 1 ? "" : "s"}, ${record.addresses.length} addresses): ${file}${note}`;
  } catch (e) {
    return `didn't record this machine in ${file}: ${(e as Error).message}`;
  }
}

/** Whether the record of this machine is there and says what the machine is now. */
export function thisHostCheck(storage: string, host: HostView = realHost()): Check {
  const name = "the record of this machine (for SSH targets)";
  const file = thisHostPath(storage);
  let held: Partial<ThisHost>;
  try {
    held = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return [name, false, `${(e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "can't be read"} (${file}): the library refuses every SSH target without it. Run install on this machine: it writes it again`];
  }
  const now = recordOf(host);
  const same = (a: unknown, b: string[]) => Array.isArray(a) && a.length === b.length && [...a].sort().every((x, i) => x === b[i]);
  const drift = [...(same(held.fingerprints, now.fingerprints) ? [] : ["its SSH host keys"]), ...(same(held.addresses, now.addresses) ? [] : ["its addresses"])];
  if (drift.length) return [name, false, `differs from what this machine has now: ${drift.join(" and ")}. Run install on this machine: it writes the record again`];
  if (!now.fingerprints.length) return [name, false, `this machine has no SSH host key in ${host.sshDir}, so the library refuses every SSH target: install sshd's keys, then run install`];
  return [name, true, ""];
}
