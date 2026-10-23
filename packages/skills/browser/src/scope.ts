// Where a call came from: its workspace and its thread, from AnythingLLM's invocation, never from
// what the model says, so each workspace's browser is its own. A call with no workspace (a
// scheduled job) gets "_jobs". The thread is AnythingLLM's own id for it, which the tab is kept by.
//
// A chat through AnythingLLM's developer API (AnywhereLLM Lite, say) comes with no thread. Such a
// run gets the workspace's tab "_" while no other run is using it, so a chat continues in it from
// one message to the next; a run that starts while another uses it gets a tab of its own,
// "api-<n>", for as long as it runs, and the next such run reuses it. Each agent run is one object
// (self.super), so a run is told apart by that; a tab is in use while its run lives and called it
// within LEASE_MS.

import { workspaceOf } from "#shared/anythingllm";
import type { HandlerContext } from "./host";
import { NO_THREAD, state } from "./state";

/** The workspace of a call with none: a scheduled job's. */
export const JOBS = "_jobs";
/** How long a tab stays with the run that last used it. */
const LEASE_MS = 2 * 60 * 1000;

export interface Scope {
  workspace: string;
  thread?: string | number;
}

/** The tab a run with no thread uses, decided at its first call: "_" or an "api-<n>". */
function apiTab(workspace: string, agent: object, now: number): string {
  const { runs, leases } = state();
  if (!leases.has(workspace)) leases.set(workspace, new Map());
  const held = leases.get(workspace)!;
  const inUse = (lease?: { run: WeakRef<object>; last: number }) => !!lease && now - lease.last <= LEASE_MS && lease.run.deref() !== undefined;
  let tab = runs.get(agent);
  if (tab === undefined) {
    const names = [NO_THREAD, ...[...held.keys()].filter((n) => n !== NO_THREAD)];
    tab = names.find((n) => !inUse(held.get(n))) ?? `api-${held.size}`;
    runs.set(agent, tab);
  }
  held.set(tab, { run: new WeakRef(agent), last: now });
  return tab;
}

export function scopeOf(self: HandlerContext | undefined, now = Date.now()): Scope {
  const invocation = self?.super?.handlerProps?.invocation ?? {};
  const scope: Scope = { workspace: workspaceOf(self) ?? JOBS };
  const thread = invocation.thread_id === null || invocation.thread_id === undefined ? NaN : Number(invocation.thread_id);
  if (Number.isInteger(thread)) scope.thread = thread;
  else if (self?.super && typeof self.super === "object") {
    const tab = apiTab(scope.workspace, self.super, now);
    if (tab !== NO_THREAD) scope.thread = tab;
  }
  return scope;
}
