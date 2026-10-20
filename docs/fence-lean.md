# The fence's asks, for the bridge and clients

What the skills (`packages/shared/fence.mts`, `ask.mts`), AnywhereLLM's bridge (anywherellm-bridge, `src/asks.mts`) and AnywhereLLM Lite agree on when a skill asks the user to let an origin through the fence. The skills and the bridge share no code: they meet in files in AnythingLLM's storage folder, under `fence-lean/`. A change to anything here is made in the suite, the bridge and Lite together.

An origin is an http or https address's scheme, host and port as `URL.origin` writes it: `http://muse-vm:8463`, `https://example.com` (no default port, the host in lower case, no path, no trailing slash).

## Who writes what

| File | Written by | Read by |
| --- | --- | --- |
| `fence-lean/asks/<id>.json` | the skill makes it and deletes it once its wait ends; the bridge sets `decision` and `decided` | the skill (each second while it waits); the bridge (`GET /asks/<id>`) |
| `fence-lean/allowed.json` | the bridge, on `always` and `DELETE /allowed?origin=` | every skill (each request to an address the fence refuses by itself); the bridge (`GET /allowed`) |

## An ask, `asks/<id>.json`

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | 32 lower-case hex characters; the file's name |
| `host` | string | the origin's host, in lower case |
| `origin` | string | the origin the skill was refused |
| `skill` | string | the skill's name as the user sees it (`Library`, `Browser`) |
| `workspace` | string | the slug of the chat's workspace |
| `why` | string | what the skill would do there, written by the skill's code, never by the model; it names the origin, never a path or query |
| `asked` | string | when, ISO-8601 in UTC |
| `expires` | string | `asked` plus 120 s: no decision is taken after it |
| `decision` | string or null | null until the user answers; then `once`, `always` or `deny` |
| `decided` | string or null | when the decision was written |

`once` lets the origin through for the rest of the agent run; `always` also adds it to `allowed.json`; `deny`, and an ask nobody answered, refuse it as before. Neither yes lets the host's other ports or scheme through.

## The chat's status line

While it waits, the skill shows a line in the chat, through AnythingLLM's agent status (an `agentThought` chunk on the developer API's stream):

```text
Waiting for your approval in AnywhereLLM to reach <host> [ask:<id>]
```

A client reads the id from the trailing `[ask:<id>]`, shows the line without it, and reads the ask from the bridge: what it shows comes from the file, never from the line.

## Origins let through for good, `allowed.json`

```json
{ "origins": [{ "origin": "http://muse-vm:8463", "added": "2026-10-20T09:11:00.000Z" }] }
```

An entry that isn't an origin is skipped. A file of any other shape (an earlier `{ "hosts": [...] }`) lets nothing through. `FENCE_ALLOW`, the hosts in AnythingLLM's environment, stays separate: it lets a host through on every port.

## Writing

Both sides change a file under its lock: a folder `<file>.lock` made with `mkdir`, held for milliseconds, and broken when older than 10 s. The new content is written to a temporary file and renamed over the old one, mode `0600`. A reader takes the file as a whole; the skills cache `allowed.json` by its inode, modification time and size.

## Checked

`tools/e2e-fence` runs this suite's shared code against a real bridge in one storage folder: the ask the skill writes as the bridge reads it, each decision, `allowed.json` as the fence reads it, `DELETE /allowed?origin=`, the lock taken in turn, and an expired ask. Run it after changing anything here, on either side.
