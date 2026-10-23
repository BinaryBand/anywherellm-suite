// The suite against the real thing, which tools/e2e starts and names in the environment:
//
//   E2E_ALLM_URL, E2E_PASSWORD  AnythingLLM from here, and its password (AUTH_TOKEN)
//   E2E_CLI                     the built anywherellm-suite.cjs, with ANYTHINGLLM_URL in the environment
//   E2E_STORAGE                 the throwaway's storage folder, as this machine sees it
//
// Also E2E_ENGINE, E2E_CONTAINER, E2E_ALLM_PORT and E2E_WORKSPACE (the slug of the one workspace
// AnythingLLM holds), for a command run in the tests' place (tools/e2e-skill). The agent's control
// server is anywherellm-bridge's, with its own e2e.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { request } from "../packages/shared/upstream.mts";

const env = (name: string): string => process.env[name] ?? "";
const run = !env("E2E_CONTAINER") ? { skip: "run it through tools/e2e" } : {};

/** AnythingLLM's internal API, logged in as its pages are: its JSON for `path`. */
async function allm(path: string): Promise<any> {
  const login = await request(`${env("E2E_ALLM_URL")}/api/request-token`, { method: "POST", body: { password: env("E2E_PASSWORD") } });
  const token = String((login.json as { token?: unknown } | null)?.token);
  return (await request(`${env("E2E_ALLM_URL")}/api${path}`, { token, timeout: 120_000 })).json;
}

test("AnythingLLM lists the skills install put in", run, async () => {
  const { settings } = await allm("/admin/system-preferences-for?labels=imported_agent_skills");
  assert.ok(settings.imported_agent_skills.some((s: { hubId: string }) => s.hubId === "library-lean"), JSON.stringify(settings));
});

test("health passes for what install set up", run, () => {
  const done = spawnSync(process.execPath, [env("E2E_CLI"), "health", "--storage", env("E2E_STORAGE")], { encoding: "utf8" });
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.match(done.stdout, /ok +the library skill/);
  assert.match(done.stdout, /ok +the pages' key/);
});

test("wake: a job runs when the wake asks, also when it's switched off", run, async () => {
  // The wake skill's own client, logged in with AnythingLLM's password as the skill is. The
  // throwaway has no model set up, so each run fails at once; that a run is made is what counts.
  const { Anything } = await import("../packages/skills/wake/src/anything.ts");
  const base = env("E2E_ALLM_URL");
  const api = new Anything(base, () => env("E2E_PASSWORD"));
  const login = await request(`${base}/api/request-token`, { method: "POST", body: { password: env("E2E_PASSWORD") } });
  const token = String((login.json as { token?: unknown }).token);
  const made = await request(`${base}/api/scheduled-jobs/new`, { method: "POST", token, body: { name: "wake e2e", prompt: "Say hi.", tools: null, schedule: "0 0 1 1 *" } });
  const id = Number((made.json as { job: { id: number } }).job.id);
  assert.equal(await api.jobName(id), "wake e2e");
  const runs = async () => ((await api.call("GET", `/scheduled-jobs/${id}/runs`)) as { runs: unknown[] }).runs.length;
  const settled = async (n: number) => {
    for (let i = 0; i < 300 && ((await runs()) < n || (await api.busy(id))); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(await runs(), n);
  };
  await api.trigger(id);
  await settled(1);
  const off = await request(`${base}/api/scheduled-jobs/${id}`, { method: "PUT", token, body: { enabled: false } });
  assert.equal((off.json as { job: { enabled: boolean } }).job.enabled, false);
  await api.trigger(id);
  await settled(2);
});
