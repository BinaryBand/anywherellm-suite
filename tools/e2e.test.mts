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
