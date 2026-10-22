// What install records of the machine it runs on, for the library to refuse a target that is this
// machine: <storage>/anywherellm-suite/this-host.json holds the SHA-256 fingerprints of its SSH host
// keys (/etc/ssh/ssh_host_*_key.pub) and every address of every interface it has, as the host sees
// them (the container AnythingLLM runs in sees fewer: a tailnet address the host has isn't there).
// A machine that shows one of these keys, or answers from one of these addresses, is the host, and
// signing in there reads the vault's key and the pages' secrets (shared/thishost.mts). The library
// only reads the file, and refuses every target when it is missing or holds no key, so install
// writes it again each time it runs, and health says when it is missing or the host has changed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeAtomicIfChanged } from "#shared/atomic";
import { type ThisHost, bare, recorded, sshFingerprint, thisHostFile } from "#shared/thishost";
import { type Check, refuseLinks } from "./addons.mts";

/** The machine as install sees it: where its SSH host keys are, and its interfaces (a test says
 *  another). */
export interface HostView {
  sshDir: string;
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}

const realHost = (): HostView => ({ sshDir: "/etc/ssh", interfaces: os.networkInterfaces() });

/** `SHA256:…` of a public key line ("ssh-ed25519 AAAA… comment"), as ssh-keygen -lf prints it; null
 *  for a line that isn't one. */
export function fingerprintOf(line: string): string | null {
  const blob = line.trim().split(/\s+/)[1];
  if (!blob || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) return null;
  const key = Buffer.from(blob, "base64");
  return key.length ? sshFingerprint(key) : null;
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
  const addresses = Object.values(host.interfaces).flatMap((list) => (list ?? []).map((a) => bare(a.address)));
  return { fingerprints: [...new Set(fingerprints)].sort(), addresses: [...new Set(addresses)].sort() };
}

/** Records this machine in the storage; what it did. It never fails an install: a refusal or an
 *  error is said, and health then reports the file missing. */
export function putThisHost(storage: string, host: HostView = realHost()): string {
  const file = thisHostFile(storage);
  try {
    refuseLinks(file, "the record of this machine");
    const record = recordOf(host);
    const wrote = writeAtomicIfChanged(file, `${JSON.stringify(record, null, 2)}\n`, 0o644);
    const note = record.fingerprints.length ? "" : ` (no SSH host key in ${host.sshDir}: the library will refuse every SSH target until this machine has one)`;
    return `${wrote ? "recorded" : "unchanged:"} this machine (${record.fingerprints.length} SSH host key${record.fingerprints.length === 1 ? "" : "s"}, ${record.addresses.length} addresses): ${file}${note}`;
  } catch (e) {
    return `didn't record this machine in ${file}: ${(e as Error).message}`;
  }
}

/** Whether the record of this machine is there, is one as the library reads it (#shared/thishost
 *  recorded), and says what the machine is now. */
export function thisHostCheck(storage: string, host: HostView = realHost()): Check {
  const name = "the record of this machine (for SSH targets)";
  const held = recorded(storage);
  if ("why" in held) return [name, false, `${held.why}: the library refuses every SSH target without it. Run install on this machine: it writes it again`];
  const now = recordOf(host);
  const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === b[i]);
  const drift = [...(same(held.host.fingerprints, now.fingerprints) ? [] : ["its SSH host keys"]), ...(same(held.host.addresses, now.addresses) ? [] : ["its addresses"])];
  if (drift.length) return [name, false, `differs from what this machine has now: ${drift.join(" and ")}. Run install on this machine: it writes the record again`];
  if (!now.fingerprints.length) return [name, false, `this machine has no SSH host key in ${host.sshDir}, so the library refuses every SSH target: install sshd's keys, then run install`];
  return [name, true, ""];
}
