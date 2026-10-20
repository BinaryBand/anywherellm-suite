# Notes on packages/skills/library

Why `library-lean` runs the functions the agent writes in QuickJS, and what was measured. From the session of 2026-10-15. A design, not built yet, for host extensions in `kit` and for using a secret without seeing it: [extensions-and-secrets.md](extensions-and-secrets.md).

## What it is for

The agent researches a service's API from its docs, asks the user for the key it needs (the model never reads it: it goes into the vault, and the host adds it to the requests), and saves small JavaScript functions, grouped in a toolkit per service, to run again on request or on a schedule. No service is built in. One library for the whole AnythingLLM: every workspace shares it, and so do scheduled jobs, which run with no workspace.

## Why QuickJS

A function is code the agent wrote, often right after reading a web page, and it runs with the user's keys, sometimes unattended. Where it runs decides what a mistake or an injected instruction can reach.

| Alternative | Why not |
| --- | --- |
| `node:vm` | Not a boundary: `this.constructor.constructor("return process")()` reaches `process`, and with it the vault's key and AnythingLLM's files. |
| The sandbox MCP server (`anythingllm-mcp`, podman) | Its egress proxy can't add a key to an HTTPS request without breaking TLS, so the key would have to be inside the container, where the script can read it. It runs beside AnythingLLM on the host (systemd sockets, podman), which this suite moved away from, so not on Desktop. It stays the place for heavy jobs: builds, audio, files. |
| An MCP server of our own | A skill runs in AnythingLLM's process, so it reads AnythingLLM's own keys (the page's `brx-` key, the vault's from `SIG_KEY`) and its public folder; an MCP server would need its own way in and its own place to serve the Library page. |
| Steps only (the lean browser's actions) | Safe, but every loop, condition or transform is a new step kind: not "small scripts". |

QuickJS runs in WebAssembly inside AnythingLLM's process with no container. A script sees its input and the `kit` the host gives it, and nothing else: no `require`, `process`, `fetch` or files (`tests/sandbox.test.mts` checks the `constructor` escape too). A key never enters it: `kit.http` (phase 1) adds the key outside, on the host, and masks it out of the answer.

## Which build

- **The sync build, not asyncify.** A kit function the host answers later is a promise in the script: the host settles it and runs the script on (`executePendingJobs`). The script reads the same as with asyncify, one compiled module serves every run, and asyncify's limit of one suspended call per module doesn't arise. The asyncify single-file build is the fallback, swapped inside `sandbox.ts` alone.
- **The single-file CommonJS build** carries its wasm as base64 inside the JavaScript, so esbuild bundles it as text: no loader, no second file. The umbrella `quickjs-emscripten` package isn't used, since its lazy imports would bundle every build.
- **The compiled module is kept on `globalThis`**, since AnythingLLM loads `handler.js` afresh for each agent run.

## Limits

Each run has its own runtime: 32 MB of memory, 1 MB of stack, a deadline (10 minutes, or a scheduled job's time left; a loop is interrupted; a script waiting on the host is stopped by a timer, which also aborts the host's request through the run's `AbortController`), an answer of at most 64 KB as JSON, and a source of at most 32 KB. An error the host means to be seen (`Told`, `#shared/errors`, which every part's refusals extend) reaches the script with its name and message, so `kit.retry` tells a server that didn't answer (`Unreachable`) from a refusal; any other says only `kit.<name> failed`, so a host detail doesn't leak into the script or the answer.

A memory bomb dies of "out of memory" after about 9.5 s near the limit (QuickJS collects hard there); the deadline stops it sooner, so the deadline is the bound.

## Redefining a sign-in, 2026-10-20

A definition given again for a sign-in kept the user's client and, when nothing else changed, its tokens, but took the new `site` and addresses: an injected agent could move a signed-in sign-in to its own site and have `call` send it the token, or move `token_url` and get the client secret at the next sign-in. Now a sign-in holding the user's client keeps its site, `authorize_url`, `token_url` and `device_url`; a definition may change its scopes and params (a change drops the tokens, as before), and for anything else the user deletes it on the Vault, where the next client is given beside the site and the token address's host. Refused rather than dropping the client, so an agent can't wipe a working sign-in either. Before the user gives a client, a definition may still change freely; presets set their own.

## Check

On 2026-10-15: the spike, bundled, on the 1.16 image's Node 18.20.8 (the async kit, the loop interrupt, the memory limit, the line of an error, no escape), and `tests/sandbox.test.mts` (12 tests, including 50 runs at once and 10 that time out mid-wait without harming the run after them) and `tests/handler.test.mts` (6) against the source and the built bundle on Node 22. Not run then: the skill inside AnythingLLM.

On 2026-10-15, phase 1: `tests/handler.test.mts` (18 tests against the built bundle and a stand-in API) and `tests/e2e/inside.js` inside the 1.16 image, by hand:

```sh
make e2e-skill SKILL=library
```

It printed ok. The bundle is 982 KB.
