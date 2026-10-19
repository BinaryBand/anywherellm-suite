// The control server's settings, from its environment. AnythingLLM starts it with its own
// environment (the hypervisor passes `process.env`, the entry's `env` over it), so AnythingLLM's
// port and password are already there:
//
//   ANYTHINGLLM_URL        AnythingLLM (default http://127.0.0.1:<SERVER_PORT, else 3001>)
//   AUTH_TOKEN             its password; none for a Desktop or an open instance
//   ANYTHINGLLM_MCP_ROLES  comma-separated, from `chat` and `schedule` (default `chat`)

import { DEFAULT_ROLES, ROLES, ROLES_ENV } from "#shared/roles";
import { anythingllmUrl } from "#shared/upstream";

export interface Settings {
  url: string;
  roles: string[];
}

/** The settings; a role that does not exist throws, saying which do. */
export function fromEnv(env: Record<string, string | undefined>): Settings {
  const asked = (env[ROLES_ENV] ?? DEFAULT_ROLES.join(",")).split(",").map((r) => r.trim());
  const roles = [...new Set(asked.filter(Boolean))];
  if (!roles.length || !roles.every((r) => ROLES.includes(r))) {
    throw new Error(`${ROLES_ENV} is one or more of ${ROLES.join(", ")}; got ${JSON.stringify(asked)}`);
  }
  return { url: anythingllmUrl(env), roles };
}
