# anythingllm-suite

Everything that extends a stock AnythingLLM, in one repository: an MCP server and agent skills that AnythingLLM runs itself, a bridge to its internal API, and the phone app that talks to the bridge.

| Part | Folder | Runs | Toolchain |
| --- | --- | --- | --- |
| Control server (MCP: chat and schedule) | `packages/control` | started by AnythingLLM, from its storage folder, with `node` | Node 18+, no dependencies shipped |
| Agent skills (library, browser, notebook, apps) | `packages/skills/<name>` | inside AnythingLLM's own process | Node 18+; nothing installed beside them (library bundles QuickJS; browser bundles Puppeteer and runs the Chrome AnythingLLM's image ships, or the system's) |
| Bridge to AnythingLLM's internal API, and the installer | `packages/bridge` | the command you run; the bridge beside AnythingLLM, as a service | Node 20.3+, no dependencies shipped |
| Phone app (AnywhereLLM Lite) | `app` | on the phone | Flutter |

`packages/` holds what runs beside or inside AnythingLLM. `app/` is the client and has its own toolchain and release. `contract/` is what both sides agree on.

## Install

You need a stock AnythingLLM (Desktop, or the Docker image) and Node 20.3 or later on the machine it runs on. The command is one file, `anythingllm-suite.cjs`, which carries the control server and the skills; build it with `npm install` once in `packages/`, then `node build.mjs bridge` there (it lands in `packages/bridge/dist/`), or `make install` from a checkout.

```sh
node anythingllm-suite.cjs install                     # AnythingLLM Desktop, on Windows, macOS or Linux
node anythingllm-suite.cjs install --storage ~/anythingllm   # Docker: the folder mounted at /app/server/storage
node anythingllm-suite.cjs install --page-key brx-...  # once: the key the skills' pages post with
```

It writes the control server, its entry in AnythingLLM's MCP servers file and the skills into AnythingLLM's storage folder, and AnythingLLM runs them itself: nothing runs beside it, so there is no service or socket to set up. Then, in AnythingLLM, open Settings > Agent Skills, refresh the MCP servers (or restart AnythingLLM) and switch on what you want.

The skills' pages (the browser's tab, the Library page, the apps) send what the user does there through AnythingLLM's browser-extension upload, so they need a browser-extension key: make one in AnythingLLM's Settings > Browser Extension and give it to install once with `--page-key`. Install keeps it in the storage (`anythingllm-suite/page-key`, readable by its owner alone) until it's given another; `health` asks AnythingLLM whether it still takes it. The key sits in every page, which anyone with a page's address can read: it can add documents (and embed them in a workspace), list the workspaces and revoke itself, never read a chat or a document. Revoke it in the same settings and give install a new one.

- **Which AnythingLLM:** `--storage DIR`, else the one install was last given, else AnythingLLM Desktop's (`%APPDATA%\anythingllm-desktop\storage`, `~/Library/Application Support/anythingllm-desktop/storage`, `~/.config/anythingllm-desktop/storage`). For Docker it is the host folder you bind-mounted, as AnythingLLM's own instructions do; a named volume isn't reachable from the host. With rootless podman, start the container with `--userns=keep-id` or run install inside `podman unshare`, so the storage is yours to write. The skills' pages go into AnythingLLM's public folder (`/app/server/public`), which is the container's own: a container made again (as a podman quadlet is on each restart) starts without them, until each skill writes them again. To keep them, bind-mount each skill's folder in it (`/app/server/public/apps-lean`, `library-lean`, `browser-lean`), never the folder itself, which also holds AnythingLLM's own web app.
- **What it puts in:** `--roles chat,schedule` (default `chat`: the schedule role lets the agent plant prompts that run later, unattended), `--skills all|none|library,...` (default all), `--page-key brx-...` (kept until another is given), `--runtime container|native` (default: native for Desktop's storage, container for any other).
- **The bridge,** which only AnywhereLLM Lite needs: add `--bridge`. It runs under the user's own service manager: systemd on Linux, launchd on macOS, the Task Scheduler on Windows, or your own supervisor (`--service foreground`). See [packages/bridge](packages/bridge/README.md).
- `health` checks it all, `uninstall` takes it out again (a skill's data stays), `pair` prints the link the phone app opens.

| Where AnythingLLM runs | Install | Verified on real hardware |
| --- | --- | --- |
| Docker or podman on Linux | `install --storage DIR` | yes, with podman (AnythingLLM 1.16.2); docker not yet (CI's e2e will) |
| Desktop on Windows, macOS, Linux | `install` | not yet |
| Docker Desktop on macOS or Windows | `install --storage DIR` | not yet; best effort |
| The bridge's service: systemd, launchd, Task Scheduler | `install --bridge` | systemd's commands as before; launchd and Task Scheduler only against scripted commands |

## Secrets

The library's keys and sign-ins and the browser's logins and passkeys are in one encrypted file, `vault-lean/vault.json` in AnythingLLM's storage, and each workspace's browser cookies in a file of their own beside it (`vault-lean/sealed/`), encrypted with the same key. The key is derived from AnythingLLM's `SIG_KEY` and `SIG_SALT`, which are in AnythingLLM's `.env`, in the same storage, so a copy of the storage could open it. To keep the key apart, put 32 random bytes in a file outside the storage (`openssl rand -base64 32 > vault.key`, readable only by the user AnythingLLM runs as) and set `VAULT_KEY_FILE` to that file's path in AnythingLLM's environment: for Docker, mount the file into the container (a Docker or podman secret, or a read-only volume) and pass `-e VAULT_KEY_FILE=/run/secrets/...`. Not in AnythingLLM's `.env`: AnythingLLM writes that file again with only the settings it knows. The next time a skill opens the vault, or a sealed file, it's sealed again under the new key. Keep a copy of the key file somewhere safe: without it the vault can't be opened.

## Layout

```text
packages/control/   the control MCP server (TypeScript; ships as control.cjs, inside the installer)
packages/bridge/    the installer and the bridge (TypeScript; ships as one file, anythingllm-suite.cjs)
packages/skills/    one folder per skill; each ships as its own zip, and inside the installer
packages/shared/    helpers the JavaScript parts bundle in (writeAtomic, the per-OS paths, AnythingLLM's login)
packages/package.json, tsconfig.json   the toolchain: one install, one type-check
app/                the Flutter app
contract/           endpoints.md, default-allow.txt, versions.env: read by every part
tools/              check, package, install, e2e, e2e-skill, routes, boundaries
docs/               architecture.md; notes/ for decisions, repo-wide and per part
.github/workflows/  the tests on Linux, macOS and Windows, and the e2e on Linux
dist/               build output, ignored
```

## Rules

- **No part imports another.** A JavaScript part's build fails if its bundle takes in a file from outside its own `src/` (the helpers in `packages/shared/` aside; `build.test.mts` tests this), and `tools/boundaries` fails if the app imports a path into another part. Imports that are erased or not bundled (types, tests) are not checked. Parts share the contract and the tooling, never modules. The installer carries the control server and the skills as built text, not as imports.
- **One version of AnythingLLM under test.** `contract/versions.env` pins the image every check uses.
- **Parts version and release on their own.** Tags are prefixed: `skills/library-lean-v0.3.0`, `app-v1.4.0`.

## Checks

`lefthook.yml` is the gate before a push, and `.github/workflows/test.yml` runs the same tests on Linux, macOS and Windows. `make` lists the commands; they only call `lefthook` or a script in `tools/`. After cloning, run `make hooks`. `flutter analyze` runs on commit, and `tools/boundaries` and `tools/check <part>` on push, each only when files of that part changed. `tools/check` knows the bridge, the control server and the skills. `make lint` and `make test` run those hooks on every file; `make check` tests everything. `make e2e` (`tools/e2e`) is not a hook: it starts a throwaway AnythingLLM in a container with its storage bind-mounted, runs `install --bridge` into it and the bridge beside it, and has the real AnythingLLM start the control server and the tests drive it. `tools/e2e command...` runs that command in place of the tests, with the throwaway's addresses, key and workspace in `E2E_*` (listed in `tools/e2e.test.mts`, plus `E2E_ALLM_PORT`, `E2E_BRIDGE_PORT` and `E2E_STORAGE`), so a client such as AnywhereLLM Lite runs its own e2e against the suite. The slow tests (the fake sign-in sites the browser skill is tried against, and the agent eval that runs cases on a model) are in the sibling repository `test-lab`, not here: this repository keeps the fast tests that need no model.

## Status

Moved in: the bridge, the control server (chat and schedule, ported from Python to TypeScript; AnythingLLM 1.16.2 starts it from its storage and `make e2e` drives it there), the `library` and `browser` skills (see their READMEs), the `notebook` skill, which took the place of the `memory` skill (archived on the branch `archive/memory-skill`), and the `apps` skill (on the branch `apps-port`, from the lean edition's 0.17). Not yet: `app/` (holds a `.gitkeep`), a run on real macOS and Windows machines.

## License

None is granted: all rights reserved. The code is public to read.
