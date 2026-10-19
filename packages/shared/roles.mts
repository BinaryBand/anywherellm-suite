// The control server's roles, which `anywherellm-suite install --roles` writes into its entry and
// the server reads from its environment (packages/control, packages/bridge).

export const ROLES = ["chat", "schedule"];
export const DEFAULT_ROLES = ["chat"];
/** The environment variable that names them, comma-separated. */
export const ROLES_ENV = "ANYTHINGLLM_MCP_ROLES";
