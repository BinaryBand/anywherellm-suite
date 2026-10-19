# anythingllm-bridge

A bridge to the parts of AnythingLLM that only its own settings pages reach: its **internal API** (`/api`), which the developer API (`/api/v1`) leaves out. A client such as AnywhereLLM Lite calls the bridge with only a developer key; the bridge logs in to the internal API with AnythingLLM's password and passes on the routes you list.

It needs nothing from AnythingLLM beyond a stock instance, adds no skill and keeps no state. What each route does is AnythingLLM's own, so the caller knows the routes; [contract/endpoints.md](../../contract/endpoints.md) records the ones worth opening, with their shapes as AnythingLLM 1.16.2 gives them.

It is part of one file, `dist/anythingllm-suite.cjs`, the suite's command (its `install` also puts the control server and the skills into AnythingLLM; see the [README](../../README.md)), that runs on Node 20.3 or later and needs nothing installed beside it. Only the phone app needs the bridge.

```mermaid
flowchart LR
    phone["client (AnywhereLLM Lite)"] -- "PUBLIC_URL, developer key" --> bridge
    subgraph bridge["the bridge (a service of this machine), 127.0.0.1:8467"]
        allow["BRIDGE_ALLOW"]
    end
    bridge -- "internal API /api, logged in with AnythingLLM's password" --> api["AnythingLLM :3001"]
    bridge -- "GET /api/v1/auth: the client's key" --> api
```

## The bridge

It listens on `BRIDGE_PORT` (8467), on 127.0.0.1.

- `GET /health` needs no key: `{"ok": true, "service": "anythingllm-bridge", "allow": [...]}`.
- Any other request needs `Authorization: Bearer <developer key>`, which AnythingLLM must accept. Any origin may call it, and a preflight needs no key.
- `<METHOD> /<path>` (GET, POST, PUT or DELETE) is AnythingLLM's `/api/<path>`, with the query string and the JSON body sent on. AnythingLLM's status and JSON come back as they are: a 400 with `{"job": null, "error": ...}` stays that.
- A route is passed only when `BRIDGE_ALLOW` lists it. Any other is `403`. With the setting empty, nothing passes.
- The bridge's own failures are `{"error": "..."}`: 400 a bad request (a path with `.`, `..` or an empty segment, a body that isn't JSON), 401 no accepted key, 403 a route not allowed, 405 another method, 413 a body over 8 MiB, 502 AnythingLLM can't be reached or refused the bridge's login.
- A client that disconnects before the answer ends the call to AnythingLLM too (Node 20.3 or later for `AbortSignal.any`); a POST may already have taken effect there.
- Replies are JSON. A route that sends a file or a stream isn't for the bridge.

**Why a list.** The bridge holds AnythingLLM's password, so anyone with a developer key could do what the settings pages do, down to reading the key list or rewriting `.env` through `system/update-env`, unless the bridge says no. List what a client needs and no more.

`BRIDGE_ALLOW` is comma-separated entries of `[METHOD ]/path/prefix`. A prefix matches whole path segments, a `*` segment matches any one segment, and an entry with no method allows all four:

```sh
BRIDGE_ALLOW=GET /scheduled-jobs, GET /setup-complete, /workspaces, POST /system/custom-models
```

`/workspaces` passes `/workspaces/home/memories` but not `/workspaces-old`. `POST /workspace/*/thread/*/update` passes `/workspace/home/thread/abc/update` for any workspace and thread, and not `/workspace/home/update`: a route with the workspace in its middle can be allowed without allowing the whole `/workspace` tree, which also deletes a workspace and resets its vectors.

`install --bridge` sets `BRIDGE_ALLOW` to the list in [contract/default-allow.txt](../../contract/default-allow.txt) (one entry per line there, joined with commas into the setting; `make routes` checks that AnythingLLM still has each route), unless the settings file sets it already, empty included. A list of your own stays. The bridge logs in as AnythingLLM's pages do: `POST /api/request-token` with the password, which is `AUTH_TOKEN` in AnythingLLM's `.env`. It keeps the token, logs in again after a 401, reads the password afresh at each login, and sends none when none is set. Multi-user mode isn't supported.

## Settings

The settings file is `bridge.env` in the user's settings folder (`~/.config/anythingllm-bridge/` on Linux, or `$XDG_CONFIG_HOME/anythingllm-bridge/`; `~/Library/Application Support/anythingllm-bridge/` on macOS; `%APPDATA%\anythingllm-bridge\` on Windows), or the file `BRIDGE_ENV_FILE` names (to run a second bridge). The service reads it as its environment; the commands read it too, and a variable already set in the environment wins over the file.

| Setting | Default | Meaning |
| --- | --- | --- |
| `BRIDGE_ALLOW` | set by `install` to the default list | the internal routes the bridge passes, as above |
| `BRIDGE_PORT` | `8467` | the port it listens on |
| `PUBLIC_HOST` | unset | this machine's HTTPS name, as `tailscale serve` gives it; the two addresses below follow it |
| `PUBLIC_URL` | `https://PUBLIC_HOST:BRIDGE_PORT` | the bridge's address for devices, for the route check and `pair` |
| `ANYTHINGLLM_PUBLIC_URL` | `https://PUBLIC_HOST:<ANYTHINGLLM_URL's port>` | AnythingLLM's address for devices, for `pair` |
| `APPS_URL` | unset | anythingllm-apps-v2's address for devices, for `pair` |
| `ANYTHINGLLM_URL` | `http://127.0.0.1:3001` | AnythingLLM, from this machine |
| `ANYTHINGLLM_STORAGE` | set by `install` | AnythingLLM's storage folder on this machine |
| `ANYTHINGLLM_ENV` | `<storage>/.env` | AnythingLLM's `.env`, whose `AUTH_TOKEN` is the login |
| `BRIDGE_SERVICE` | auto: the OS's own manager | what runs the bridge: `systemd`, `launchd`, `windows` or `foreground` (`install --service`) |

## Deploy it

1. Build the suite's command: `npm install` once in `packages/`, then `node build.mjs bridge` there. Copy `packages/bridge/dist/anythingllm-suite.cjs` where you want it to live; the service points at that path.
1. Run `node anythingllm-suite.cjs install --bridge` (with `--storage <AnythingLLM's storage folder>` unless it is AnythingLLM Desktop's). Besides the control server and the skills, it points the bridge at the storage, where the password is, sets `BRIDGE_ALLOW` when it isn't set, and starts the bridge under the user's service manager, where one answers:

   | OS | Service | Its log |
   | --- | --- | --- |
   | Linux | the systemd user unit `anythingllm-bridge.service` in `~/.config/systemd/user` | `journalctl --user -u anythingllm-bridge` |
   | macOS | the launchd agent `local.anythingllm-bridge` in `~/Library/LaunchAgents`, in the GUI session | `~/Library/Logs/anythingllm-bridge.log` |
   | Windows | the Task Scheduler task `anythingllm-bridge`, at logon, running `%LOCALAPPDATA%\anythingllm-bridge\serve.cmd` with no window | `bridge.log` beside it |

   `--service systemd|launchd|windows|foreground|auto` picks one (saved as `BRIDGE_SERVICE`); `--no-start` stops before starting it. launchd and the Task Scheduler have only run against scripted commands so far, not on a real Mac or PC.
1. With no service manager (no user systemd, an ssh session without a GUI login, `--service foreground`), run `node anythingllm-suite.cjs serve` under your own supervisor: a terminal, tmux, a container or a process manager. It reads the same settings file.
1. If AnythingLLM's `.env` isn't at `<storage>/.env`, set `ANYTHINGLLM_ENV` in the settings file. AnythingLLM Desktop has no password, so it needs none.
1. To pass other routes, change `BRIDGE_ALLOW` in the settings file and run `install --bridge` again (it restarts the service).
1. Run `node anythingllm-suite.cjs health`. Besides what install put into the storage, it checks the service, the bridge, AnythingLLM, the bridge's login, that `BRIDGE_ALLOW` isn't empty, and the public route.
1. To connect a phone, give AnythingLLM and the bridge addresses your devices reach (next section), then run `node anythingllm-suite.cjs pair`. It prints a link, `anywherellm://connect?...`, that AnywhereLLM Lite opens. The link holds `url` (AnythingLLM's address), `key` (the developer key named `AnywhereLLM`, made the first time), and `toolkit` and `apps` (the bridge's and anythingllm-apps-v2's addresses, when known; the app still reads the first as `toolkit`). There is no QR code; any QR generator can draw the link. Each address must be https, or plain http to a private host.

`uninstall` stops the service, takes the control server and the skills out, and forgets the storage. `settings` prints the settings in use.

## Reach it from your devices

A phone needs two addresses: AnythingLLM's (`127.0.0.1:3001`) and the bridge's (`127.0.0.1:8467`). Any tool that gives each an address works. Set the addresses it gives, then run `pair` again.

**Tailscale.** `tailscale serve` gives each port an https address on this machine's tailnet name; set `PUBLIC_HOST` to it and both addresses follow:

```sh
tailscale serve --bg --https=3001 http://127.0.0.1:3001
tailscale serve --bg --https=8467 http://127.0.0.1:8467
```

On Linux these need sudo unless you ran `tailscale set --operator=$USER` once.

**A tunnel or a reverse proxy.** Give each service a hostname of its own, then set `ANYTHINGLLM_PUBLIC_URL=https://ai.example.com` and `PUBLIC_URL=https://bridge.example.com`. With Cloudflare Tunnel, Access must not front these hostnames (the phone sends a developer key, not a browser login), a stream that sends nothing for about 100 s is closed, and a quick tunnel's hostname changes on each start, so pair again. With Caddy, `reverse_proxy 127.0.0.1:3001` and `reverse_proxy 127.0.0.1:8467` in a site block each.

**A home network without TLS.** Plain http works when the host is private: `localhost`, a name with no dot such as `nas`, a name ending in `.local`, `.lan`, `.home.arpa` or `.ts.net`, or a loopback, private, link-local or Tailscale address. The key then travels unencrypted on that network. The settings and `pair` refuse plain http to any other host.

## Develop

- `tools/check bridge` is the gate: the type-check, the tests of what both parts share (`packages/shared` and the build check: `npm run shared:test`), then `node --test` on `tests/`, after building. From `packages/`: `npm run typecheck` (covers the skills too) and `npm run bridge:test`.
- Both parts share `packages/shared/` (today `writeAtomic`), bundled in. `src/` is flat: `allow.mts` (the rules) and `settings.mts` do no I/O; `upstream.mts` is AnythingLLM's client; `server.mts` the HTTP side; `install.mts`, `service.mts`, `pair.mts` and `envfile.mts` the deployment; `main.mts` the commands.
- Tests import `src/` directly (Node strips the types), except `bundle.test.mts`, which runs the built file. `tests/fakes/anythingllm.mts` stands in for AnythingLLM's two APIs on a port of its own, so `server.test.mts` runs the real bridge against it, with and without AnythingLLM's password.
- `service.test.mts` runs `install`, `uninstall` and `health` against a scripted `systemctl` and a real bridge on a free port. A client that leaves ends the upstream call (`server.test.mts`, with a route the fake AnythingLLM never answers).
- Not tested: a real `systemctl`, the commands other than `serve` and `settings` through argv, and AnythingLLM itself; the bridge has not yet been run against a real instance.
