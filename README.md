# anywherellm-suite

Agent skills that a stock AnythingLLM runs itself, and the command that installs them. The bridge that AnywhereLLM Lite (the phone app) calls, and the control server that gives the agent its chat and scheduled-job tools, are a repository of their own, anywherellm-bridge.

| Part | Folder | Runs | Toolchain |
| --- | --- | --- | --- |
| Agent skills (library, browser, notebook, apps) | `packages/skills/<name>` | inside AnythingLLM's own process | Node 18+; nothing installed beside them (library bundles QuickJS; browser bundles Puppeteer and runs the Chrome AnythingLLM's image ships, or the system's) |
| The installer | `packages/install` | the command you run | Node 18+, no dependencies shipped |

`packages/` holds what runs inside AnythingLLM and what puts it there. `docs/browser-tab.md` and `docs/fence-lean.md` are what the parts agree on with the phone app and the bridge.

## Install

You need a stock AnythingLLM (Desktop, or the Docker image) and Node 18 or later on the machine it runs on. The command is one file, `anywherellm-suite.cjs`, which carries the skills; build it with `npm install` once in `packages/`, then `node build.mjs install` there (it lands in `packages/install/dist/`), or `make install` from a checkout.

```sh
node anywherellm-suite.cjs install                     # AnythingLLM Desktop
node anywherellm-suite.cjs install --storage ~/anythingllm   # Docker: the folder mounted at /app/server/storage
node anywherellm-suite.cjs install --page-key brx-...  # once: the key the skills' pages post with
```

It writes the skills into AnythingLLM's storage folder, and AnythingLLM runs them itself: nothing runs beside it, so there is no service or socket to set up. Then, in AnythingLLM, open Settings > Agent Skills and switch on what you want. The agent's chat and scheduled-job tools (the control server) are anywherellm-bridge's: `anywherellm-bridge install --control`.

The skills' pages (the browser's tab, the Vault, the Library page, the apps) send what the user does there through AnythingLLM's browser-extension upload, so they need a browser-extension key: make one in AnythingLLM's Settings > Browser Extension and give it to install once with `--page-key`. Install keeps it in the storage (`anywherellm-suite/page-key`, readable by its owner alone) until it's given another; `health` asks AnythingLLM whether it still takes it. The key sits in every page, which anyone with a page's address can read: it can add documents (and embed them in a workspace), list the workspaces and revoke itself, never read a chat or a document. A skill applies what it posts only with a page's own secret. Revoke it in the same settings and give install a new one.

- **Which AnythingLLM:** `--storage DIR` on every command (`install`, `health`, `uninstall`; nothing is remembered between them), else AnythingLLM Desktop's (`%APPDATA%\anythingllm-desktop\storage`, `~/Library/Application Support/anythingllm-desktop/storage`, `~/.config/anythingllm-desktop/storage`). For Docker it is the host folder you bind-mounted, as AnythingLLM's own instructions do; a named volume isn't reachable from the host. With rootless podman, start the container with `--userns=keep-id` or run install inside `podman unshare`, so the storage is yours to write. The skills' pages go into AnythingLLM's public folder (`/app/server/public`), which is the container's own: a container made again (as a podman quadlet is on each restart) starts without them, until each skill writes them again. To keep them, bind-mount each skill's folder in it (`/app/server/public/apps-lean`, `library-lean`, `browser-lean`), never the folder itself, which also holds AnythingLLM's own web app.
- **What it puts in:** `--skills all|none|library,...` (default all), `--page-key brx-...` (kept until another is given).
- `health --storage DIR` checks it all (with `ANYTHINGLLM_URL` when AnythingLLM isn't at `http://127.0.0.1:3001`, for the pages' key), `uninstall --storage DIR` takes it out again (a skill's data stays).

| Where AnythingLLM runs | Install | Verified on real hardware |
| --- | --- | --- |
| Docker or podman on Linux | `install --storage DIR` | yes, with podman (AnythingLLM 1.16.2); docker not yet (CI's e2e will) |
| Desktop on Linux | `install` | not yet |
| Windows or macOS, Desktop or Docker Desktop | `install`, or `install --storage DIR` | not tested, not supported; nothing is meant to stop it working (see the notes' house rules) |

## Secrets

The library's keys and sign-ins and the browser's logins and passkeys are in one encrypted file, `vault-lean/vault.json` in AnythingLLM's storage, and each workspace's browser cookies in a file of their own beside it (`vault-lean/sealed/`), encrypted with the same key. The key is 32 random bytes the suite makes the first time it needs one and keeps beside the vault (`vault-lean/vault.key`, readable only by the user AnythingLLM runs as), so a copy of the storage could open it. To keep the key apart, move that file out of the storage and set `VAULT_KEY_FILE` to its new path in AnythingLLM's environment: for Docker, mount the file into the container (a Docker or podman secret, or a read-only volume) and pass `-e VAULT_KEY_FILE=/run/secrets/...`. Not in AnythingLLM's `.env`: AnythingLLM writes that file again with only the settings it knows. Keep a copy of the key file somewhere safe: without it the vault can't be opened, and the only way on is to remove `vault.json` and `sealed/` beside it and enter the secrets again.

## Layout

```text
packages/install/   the installer (TypeScript; ships as one file, anywherellm-suite.cjs)
packages/skills/    one folder per skill; each ships as its own zip, and inside the installer
packages/shared/    helpers the JavaScript parts bundle in (writeAtomic, the vault, the fence, AnythingLLM's login)
packages/package.json, tsconfig.json   the toolchain: one install, one type-check
tools/              check, package, install, e2e, e2e-skill; versions.env, the AnythingLLM image every check uses (the test lab reads it too)
docs/               architecture.md; browser-tab.md and fence-lean.md, the file formats the phone app and the bridge read; notes/ for decisions, repo-wide and per part
.github/workflows/  the tests and the e2e, on Linux
dist/               build output, ignored
```

## Rules

- **No part imports another.** A JavaScript part's build fails if its bundle takes in a file from outside its own `src/` (the helpers in `packages/shared/` aside; `build.test.mts` tests this). Imports that are erased or not bundled (types, tests) are not checked. Parts share the contract and the tooling, never modules. The installer carries the skills as built text, not as imports.
- **One version of AnythingLLM under test.** `tools/versions.env` pins the image every check uses.
- **Parts version and release on their own.** Tags are prefixed: `skills/library-lean-v0.3.0`.

## Checks

`lefthook.yml` is the gate before a push, and `.github/workflows/test.yml` runs the same tests, and the e2e, on Linux. `make` lists the commands; they only call `lefthook` or a script in `tools/`. After cloning, run `make hooks`. `tools/check <part>` runs on push, only when files of that part changed. `tools/check` knows the installer and the skills. `make test` runs those hooks on every file; `make check` tests everything. `make e2e` (`tools/e2e`) is not a hook: it starts a throwaway AnythingLLM in a container with its storage bind-mounted, runs `install` into it, and checks that the real AnythingLLM lists the skills and that `health` passes. `tools/e2e command...` runs that command in place of the tests, with the throwaway's address, password and workspace in `E2E_*` (listed in `tools/e2e.test.mts`). The slow tests (the fake sign-in sites the browser skill is tried against, and the agent eval that runs cases on a model) are in the sibling repository `test-lab`, not here: this repository keeps the fast tests that need no model. The check of the fence's asks against anywherellm-bridge (`npm run contract:fence`) is there too, since it needs a second repository.

## Status

Moved in: the `library` and `browser` skills (see their READMEs), the `notebook` skill, which took the place of the `memory` skill (archived on the branch `archive/memory-skill`), and the `apps` skill (on the branch `apps-port`, from the lean edition's 0.17). Moved out: the bridge, to anywherellm-bridge (2026-10-19), and the control server, to the same repository (2026-10-20). Not yet: a run on real macOS and Windows machines.

## License

None is granted: all rights reserved. The code is public to read.
