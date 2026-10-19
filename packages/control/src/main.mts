// anythingllm-control: an MCP server over stdio with the controls of the user's AnythingLLM (its
// chats, its scheduled jobs). AnythingLLM starts it itself, from its storage folder, with `node`:
// the one in its container, or the host's for Desktop. It calls AnythingLLM's internal API on the
// same machine, logged in with AnythingLLM's own password, so it needs no key, bridge or socket.

import { Anything } from "./anything.mts";
import { serveStdio } from "./mcp.mts";
import { fromEnv } from "./settings.mts";
import { buildServer } from "./tools.mts";
import { Upstream } from "./upstream.mts";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const settings = fromEnv(process.env);
  const upstream = new Upstream(settings.url, process.env.AUTH_TOKEN || "", "AUTH_TOKEN, AnythingLLM's password");
  const api = new Anything((method, path, body) => upstream.exchange(method, path, body));
  await serveStdio(buildServer(api, settings.roles, VERSION));
}

main().catch((e: unknown) => {
  console.error(`anythingllm-control: ${(e as Error).message}`);
  process.exit(1);
});
