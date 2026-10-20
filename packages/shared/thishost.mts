// Which addresses are this machine itself: loopback, link-local, unspecified, and every address of
// every interface (the LAN's, a tailnet's, a container bridge's). A target that is this machine, or
// answers from an address of it, signs the agent in as an account here, which reads what AnythingLLM
// keeps beside it (the vault's key, the pages' secrets). So the library refuses these however the
// user ticked the target, and checks the address the connection is made to, not only the name.
// A test that stands a machine up on 127.0.0.1 names it in THISHOST_EXCEPT (a Set on globalThis);
// nothing shipped sets it.

import net from "node:net";
import os from "node:os";

/** The test seam: addresses to treat as not this machine. Nothing shipped sets it. */
export const THISHOST_EXCEPT = Symbol.for("anywherellm-suite.thishost.except");

const ALWAYS = new net.BlockList();
for (const [address, bits] of [
  ["0.0.0.0", 8], // unspecified, and "this network": connects to this machine
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local
] as const) {
  ALWAYS.addSubnet(address, bits, "ipv4");
}
for (const [address, bits] of [["::", 128], ["::1", 128], ["fe80::", 10]] as const) ALWAYS.addSubnet(address, bits, "ipv6");

/** An address without its IPv6 zone ("fe80::1%eth0"). */
const bare = (ip: string): string => ip.split("%", 1)[0];

/** Why `ip` is this machine's own, or null. An IPv4 address mapped into IPv6 is checked as IPv4. */
export function thisHostRefusal(ip: string): string | null {
  const address = bare(ip);
  const kind = net.isIP(address);
  if (!kind) return null;
  const except = (globalThis as unknown as Record<symbol, Set<string> | undefined>)[THISHOST_EXCEPT];
  if (except?.has(address)) return null;
  const family = kind === 6 ? "ipv6" : "ipv4";
  let own = ALWAYS.check(address, family);
  if (!own) {
    const mine = new net.BlockList();
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list ?? []) {
        const k = net.isIP(bare(a.address));
        if (k) mine.addAddress(bare(a.address), k === 6 ? "ipv6" : "ipv4");
      }
    }
    own = mine.check(address, family);
  }
  return own ? `${ip} is an address of this machine itself, which a target can't be: signing in here would read what AnythingLLM keeps beside it, the vault's key and the pages' secrets` : null;
}
