// `pages`: where the user opens the Library page, the Vault and the apps manager when the agent isn't given their
// links, and the switch that keeps them from the agent (--hide) or gives them back (--show). The
// links are the root-relative paths the skills keep in <storage>/anywherellm-suite/page-links.json
// (shared/page-links.mts); with ANYTHINGLLM_URL set they print as full addresses.

import { hiddenFile, KINDS } from "#shared/page-links";
import { Told } from "#shared/errors";
import { storageFor, type Ctx } from "./install.mts";
import { hiddenSince, hide, readKept, show, waitingEvents, type Kept } from "./pagelinks.mts";

export interface PagesOptions {
  storage?: string;
  /** Keep the links from the agent. */
  hide?: boolean;
  /** Give them to the agent again. */
  show?: boolean;
}

/** AnythingLLM's address from ANYTHINGLLM_URL, or null when it isn't set to an http(s) address. */
function baseOf(ctx: Ctx): string | null {
  const raw = ctx.env.ANYTHINGLLM_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? `${url.origin}${url.pathname.replace(/\/+$/, "")}` : null;
  } catch {
    return null;
  }
}

const names = { library: "Library page", vault: "Vault", apps: "Apps manager" } as const;
/** What makes each page again, as the agent calls it. */
const NEXT_CALL = { library: "library call", vault: "library call or browser step", apps: "apps call" } as const;

/** Per page, whether its link was made before the switch (so the agent was given it, and it changes
 *  at the agent's next call): said for that page alone, from when the links file says it was last
 *  replaced. A file that records no rotations at all can't say. */
function staleLines(links: Kept, switchedAt: number): string[] {
  const lines: string[] = [];
  for (const kind of KINDS) {
    if (!links[kind]) continue;
    if (!links.rotated) lines.push(`${names[kind]}: unknown whether its link was made after the switch (the links file records no rotations yet).`);
    else if ((links.rotated[kind] ?? 0) < switchedAt) lines.push(`${names[kind]}: its link was made before the switch: it changes at the agent's next ${NEXT_CALL[kind]}.`);
  }
  return lines;
}

/** Prints the links and which way they go; 0, or 1 when there is nothing to show yet. */
export function pages(ctx: Ctx, opts: PagesOptions = {}): number {
  if (opts.hide && opts.show) throw new Told("--hide and --show together: choose one");
  const storage = storageFor(ctx, opts.storage);
  ctx.print(`AnythingLLM's storage: ${storage}`);
  if (opts.hide) {
    ctx.print(hide(storage) ? `kept the pages' links from the agent: ${hiddenFile(storage)}` : `unchanged: the pages' links are kept from the agent already (${hiddenFile(storage)})`);
    const waiting = waitingEvents(storage);
    const total = waiting.keys + waiting.logins + waiting.library + waiting.apps;
    if (total) {
      const where = [
        waiting.keys && `Vault keys: ${waiting.keys}`,
        waiting.logins && `Vault logins: ${waiting.logins}`,
        waiting.library && `Library page: ${waiting.library}`,
        waiting.apps && `Apps manager: ${waiting.apps}`,
      ].filter(Boolean);
      ctx.print(`${total} page event${total === 1 ? " waits" : "s wait"} to be applied (${where.join(", ")}): ask the agent to call library and apps and open a tab first, or they're dropped when the links change`);
    }
  } else if (opts.show) {
    ctx.print(show(storage) ? `gave the pages' links to the agent again: removed ${hiddenFile(storage)}` : `unchanged: the pages' links are not kept from the agent (no ${hiddenFile(storage)})`);
  }
  const links = readKept(storage);
  if (!links) {
    ctx.print("No page yet: the agent makes them at its first library call (or browser tab); run pages again then");
    return opts.hide || opts.show ? 0 : 1;
  }
  const base = baseOf(ctx);
  const at = (rel?: string) => (rel ? `${base ?? ""}${rel}` : null);
  ctx.print(`Library page: ${at(links.library) ?? "none (the library skill isn't installed, or hasn't shown it yet)"}`);
  ctx.print(`Vault:        ${at(links.vault) ?? "none (no skill has shown it yet)"}`);
  ctx.print(`Apps manager: ${at(links.apps) ?? "none (the apps skill isn't installed, or hasn't made it yet)"}`);
  if (!base) ctx.print("(root-relative: set ANYTHINGLLM_URL to AnythingLLM's address to print full ones)");
  const since = hiddenSince(storage);
  if (since) {
    ctx.print("The agent isn't given these links.");
    for (const line of staleLines(links, since.getTime())) ctx.print(line);
  } else {
    ctx.print("The agent is given these links too (pages --hide keeps them from it).");
  }
  return 0;
}
