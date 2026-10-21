# The fence's files, `fence-lean/`

What the fence (`packages/shared/fence.mts`) keeps in AnythingLLM's storage folder, under `fence-lean/`. Both files are the suite's alone: nothing outside it reads or writes them. Each is written to a temporary file and renamed over the old one, mode `0600`.

An origin is an http or https address's scheme, host and port as `URL.origin` writes it: `http://muse-vm:8463`, `https://example.com` (no default port, the host in lower case, no path, no trailing slash).

## Let through, `allowed.json`

```json
{ "origins": [{ "origin": "http://muse-vm:8463", "added": "2026-10-20T09:11:00.000Z" }] }
```

Written from the Vault page's Allowed addresses (`packages/shared/addresses.mts`), under its lock (`allowed.json.lock`, `updateJson`); read by every skill for each request to an address the fence refuses by itself, cached by inode, modification time and size. An entry lets that origin through, never its host's other ports or scheme. An entry that isn't an origin is skipped; a file that can't be read lets nothing through and is never written over. `FENCE_ALLOW`, the hosts in AnythingLLM's environment, stays separate: it lets a host through on every port.

The Vault adds no public origin (plain http to it would carry a key), and none of the suite's own services: AnythingLLM's own address, and this machine's addresses (its interfaces', and `anywherellm-suite/this-host.json`'s) on 3001, 443, 8467 and AnythingLLM's port. What it can't tell (a name that doesn't resolve, or neither that record nor AnythingLLM's address) it refuses.

## Refused lately, `refused.json`

```json
{ "refused": [{ "origin": "http://muse-vm:8463", "at": "2026-10-21T08:02:00.000Z" }] }
```

Written where the fence refuses a request (`net.mts`, the browser's `through` and its main frame's navigations): the newest first, each origin once, at most 10, none older than 24 h. Not under a lock: two refusals at once may keep one. Read by the Vault page, which offers each one not let through since with an Allow button.
