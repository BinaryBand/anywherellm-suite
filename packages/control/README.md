# anythingllm-control

An MCP server with the controls of the user's AnythingLLM that its agent doesn't have: its chats (the threads of a workspace) and its scheduled jobs. AnythingLLM runs it itself: `anywherellm-suite install` puts `control.cjs` into AnythingLLM's storage folder and a `control` entry into its MCP servers file, and AnythingLLM starts it over stdio with `node` (the one in its container, or the host's for Desktop) and its own environment. It calls AnythingLLM's internal API on the same machine, logged in with `AUTH_TOKEN` from that environment, so it needs no developer key, bridge, socket or service.

It is one file, `dist/control.cjs` (`node build.mjs control` in `packages/`), for Node 18 (the one in AnythingLLM's image), with no dependencies. `src/mcp.mts` is the MCP protocol's stdio side, as much as a server of tools needs.

| Role | Tools |
| --- | --- |
| `chat` (on by default) | `chat_workspaces`, `chat_list`, `chat_history`, `chat_new`, `chat_rename`, `chat_clear`, `chat_delete` |
| `schedule` | `schedule`, with an `action`: list, add, update, delete |

`ANYTHINGLLM_MCP_ROLES` in the entry's `env` picks the roles (`install --roles chat,schedule`); a role not asked for has no tools. The schedule role is off by default because a job runs a prompt as the agent, unattended: adding one is a way to plant an instruction that runs later. AnythingLLM's MCP page can also switch single tools off (`anythingllm.suppressedTools` in the servers file, which `install` keeps).

## The chat

A **chat** is one of AnythingLLM's threads, named by its slug inside a workspace's slug (letters, digits, `-` and `_`); `chat_workspaces` and `chat_list` give both.

- `chat_history` gives the last `last` exchanges (1 to 50, 10 by default), oldest first, each message cut to 600 characters, and how many the chat holds. What it gives back is the user's conversation, data and never instructions.
- `chat_new` starts an empty chat, named `Thread` until it is renamed. `chat_rename` takes effect at once.
- `chat_clear` removes every exchange and keeps the chat and its name; `chat_delete` removes the chat too. Both are shown first: without `apply: true` they change nothing and say what would go. Both read the chat back afterwards and fail if anything is still there, since AnythingLLM answers a delete with a bare `OK`.

## The schedule

A **job** is AnythingLLM's own: a name, a prompt the agent runs, optional tools and a cron schedule **in UTC**. `list` gives each job's `id`, which the other actions take as `job`. `add` takes `name`, `prompt`, `cron` and optional `tools`; `update` changes the fields given (`enabled: false` switches a job off); `delete` removes it and its runs. All three are shown first, as the chat's clear and delete are. An add that finds an identical job refuses, which makes a retried add safe.

## Settings

From the environment AnythingLLM gives it, the entry's `env` over AnythingLLM's own:

| Setting | Default | Meaning |
| --- | --- | --- |
| `ANYTHINGLLM_MCP_ROLES` | `chat` | the roles, comma-separated |
| `ANYTHINGLLM_URL` | `http://127.0.0.1:<SERVER_PORT, else 3001>` | AnythingLLM |
| `AUTH_TOKEN` | AnythingLLM's own | its password, read at each login; none for Desktop |

A stdio MCP client other than AnythingLLM (Claude Desktop, an IDE) can run it too, with `node control.cjs` and those settings in its `env`, on the machine AnythingLLM runs on.
