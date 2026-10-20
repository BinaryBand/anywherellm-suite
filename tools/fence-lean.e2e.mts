// The fence's asks across the suite and the bridge (docs/fence-lean.md), against the real
// bridge. tools/e2e-fence runs this as anywherellm-bridge's tools/e2e command, which starts a
// throwaway AnythingLLM with the bridge served beside it and names them in the environment:
//
//   E2E_BRIDGE_URL, E2E_KEY     the bridge, and a developer key that isn't AnywhereLLM's
//   E2E_ALLM_URL, E2E_PASSWORD  AnythingLLM from here, and its password (AUTH_TOKEN)
//   E2E_WORKSPACE               the slug of the one workspace AnythingLLM holds
//   E2E_STORAGE                 AnythingLLM's storage folder, which the bridge reads and writes
//
// This checkout's shared code makes each ask and waits on it in that folder, as a skill does, and
// the bridge answers it as AnywhereLLM has it do: so the two sides' copies of the lock, the ask and
// allowed.json are checked against each other, which neither side's own tests can do.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { type Decision, askToReach, asksDir, grantsOf } from "../packages/shared/ask.mts";
import { locked } from "../packages/shared/atomic.mts";
import { allows, secureFor } from "../packages/shared/fence.mts";

const env = (name: string): string => process.env[name] ?? "";
const run = !env("E2E_BRIDGE_URL") ? { skip: "run it through tools/e2e-fence" } : {};
process.env.STORAGE_DIR = env("E2E_STORAGE");
delete process.env.FENCE_ALLOW;

const bridge = env("E2E_BRIDGE_URL");
const NONE: ReadonlySet<string> = new Set();
let anywhere: Promise<string> | undefined;

/** The developer key named AnywhereLLM, the only one the bridge takes an answer from, made once as
 *  the bridge's `pair` makes it. */
function anywhereKey(): Promise<string> {
  anywhere ??= (async () => {
    const login = await fetch(`${env("E2E_ALLM_URL")}/api/request-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: env("E2E_PASSWORD") }),
    });
    const { token } = (await login.json()) as { token: string };
    const made = await fetch(`${env("E2E_ALLM_URL")}/api/system/generate-api-key`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "AnywhereLLM" }),
    });
    return ((await made.json()) as { apiKey: { secret: string } }).apiKey.secret;
  })();
  return anywhere;
}

/** A call to the bridge's own routes, with `key` (AnywhereLLM's unless given). */
async function call(method: string, route: string, { key, body }: { key?: string; body?: object } = {}): Promise<{ status: number; json: any }> {
  const answer = await fetch(`${bridge}${route}`, {
    method,
    headers: { Authorization: `Bearer ${key ?? (await anywhereKey())}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: answer.status, json: await answer.json().catch(() => null) };
}

/** An ask for `origin`, as a skill in a chat on AnywhereLLM makes it: its wait, and the id its line
 *  in the chat names. */
async function asking(origin: string, waitMs = 30_000) {
  const lines: string[] = [];
  const self = { super: { handlerProps: { invocation: { workspace: { slug: env("E2E_WORKSPACE") } } } }, introspect: (line: string) => lines.push(line) };
  const host = new URL(origin).hostname;
  const outcome = askToReach(self, { skill: "E2E", host, origin, why: `Send a request to ${origin}` }, { waitMs, pollMs: 100 });
  for (let i = 0; i < 50 && !lines.length; i++) await sleep(20);
  const id = /\[ask:([0-9a-f]{32})\]$/.exec(lines[0] ?? "")?.[1];
  assert.ok(id, `the chat's line names the ask: ${lines[0]}`);
  assert.equal(lines[0], `Waiting for your approval in AnywhereLLM to reach ${host} [ask:${id}]`);
  return { self, id, outcome, file: path.join(asksDir(), `${id}.json`) };
}

/** Decides ask `id` through the bridge, as AnywhereLLM's Allow once, Always allow or Deny. */
async function decide(id: string, decision: Decision) {
  const answer = await call("POST", `/asks/${id}`, { body: { decision } });
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  assert.equal(answer.json.ask.decision, decision);
}

test("the bridge reads the ask the skill wrote, and only AnywhereLLM's key answers it", run, async () => {
  const origin = "http://127.0.0.1:9";
  const { id, outcome, file } = await asking(origin);
  const read = await call("GET", `/asks/${id}`);
  assert.equal(read.status, 200);
  assert.deepEqual(
    { ...read.json.ask, asked: undefined, expires: undefined },
    { id, host: "127.0.0.1", origin, skill: "E2E", workspace: env("E2E_WORKSPACE"), why: `Send a request to ${origin}`, asked: undefined, expires: undefined, decision: null, decided: null },
  );
  assert.equal((await call("GET", `/asks/${id}`, { key: env("E2E_KEY") })).status, 403);
  assert.equal((await call("POST", `/asks/${id}`, { key: env("E2E_KEY"), body: { decision: "always" } })).status, 403);
  await decide(id, "deny");
  assert.equal(await outcome, "deny");
  assert.equal(fs.existsSync(file), false, "the skill takes its ask away once its wait ends");
});

test("Allow once lets the origin through for the run, and writes nothing for good", run, async () => {
  const origin = "http://127.0.0.1:8461";
  const { self, id, outcome } = await asking(origin);
  await decide(id, "once");
  assert.equal(await outcome, "once");
  assert.equal(allows(origin, grantsOf(self)), true);
  assert.equal(allows("http://127.0.0.1:8462", grantsOf(self)), false);
  assert.equal(allows(origin, NONE), false);
  assert.deepEqual((await call("GET", "/allowed")).json.origins, []);
});

test("Always allow: the fence reads the origin the bridge wrote, and not its host's other ports, until it's forgotten", run, async () => {
  const origin = "http://127.0.0.1:8463";
  const { id, outcome } = await asking(origin);
  await decide(id, "always");
  assert.equal(await outcome, "always");
  const listed = (await call("GET", "/allowed")).json.origins as { origin: string }[];
  assert.deepEqual(listed.map((o) => o.origin), [origin]);
  assert.equal(allows(origin, NONE), true);
  assert.equal(secureFor(new URL(`${origin}/topic`)), true);
  assert.equal(allows("http://127.0.0.1:8464", NONE), false);
  assert.equal(allows("https://127.0.0.1:8463", NONE), false);

  const forgot = await call("DELETE", `/allowed?origin=${encodeURIComponent(origin)}`);
  assert.equal(forgot.status, 200);
  assert.deepEqual(forgot.json.origins, []);
  assert.equal(allows(origin, NONE), false);
  assert.equal(secureFor(new URL(`${origin}/topic`)), false);
});

test("the bridge waits for the lock the skill's side holds on an ask", run, async () => {
  const { id, outcome, file } = await asking("http://127.0.0.1:8465");
  let answered = false;
  let decided: Promise<void> | undefined;
  await locked(`${file}.lock`, "the ask", async () => {
    decided = decide(id, "deny").then(() => {
      answered = true;
    });
    await sleep(800);
    assert.equal(answered, false, "the bridge answered while the lock was held");
  });
  await decided;
  assert.equal(answered, true);
  assert.equal(await outcome, "deny");
});

test("an ask nobody answered in time is refused, and the bridge can't answer it after", run, async () => {
  const { id, outcome, file } = await asking("http://127.0.0.1:8466", 1500);
  assert.equal(await outcome, "expired");
  assert.equal(fs.existsSync(file), false);
  assert.equal((await call("POST", `/asks/${id}`, { body: { decision: "always" } })).status, 404);
  assert.deepEqual((await call("GET", "/allowed")).json.origins, []);
});
