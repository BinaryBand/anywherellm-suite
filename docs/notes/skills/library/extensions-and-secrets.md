# Extensions and computing on secrets

Pre-written host functions in `kit` (extensions), and functions that use a secret without seeing it (signing, for one). Decided in the session of 2026-10-18; **built 2026-10-20** as `kit.crypto` and `kit.secret`, with signing keys on the Vault (see "As built").

## Why it was built

SSH targets were planned, built, hardened and tested on a Pi, then archived a day later because they were used much less than expected (branch `archive/ssh-targets`). The one real use of signing then was the Muse email channel: its functions signed through `kit.ssh.exec` on the Pi, with the seed on the Pi, kept from the model only by an instruction in the toolkit's notes. It stopped with the archive. Muse signing was then wanted back, and was served for a while by a temporary skill outside the suite (`sshsig`, in `anythingllm-temp-skills`), which kept its key in this vault as an entry of kind `signing`. That is the "When to build" row for both, below.

## Extensions: host functions that only compute

An extension is a group in `kit` written in this repo, in `src/extensions/<name>.ts`, and joined to every function's kit by one line in `kitFor()` (`runs.ts`), with its lines in `static/guide/functions.md`. The sandbox already installs nested groups (`kit.state.get`).

The rule: **an extension only computes.** JSON in, JSON out; no network, no files, no vault, nothing kept between calls. A function could compute the same in plain JavaScript, so an extension adds no reach, and it needs no policy check.

| Put it in | When |
| --- | --- |
| `static/prelude/*.js` | It's plain JavaScript (`kit.retry`, `kit.b64`). It runs in the sandbox, and an instance can tune it. |
| `src/extensions/` | The sandbox can't do it well: secure randomness (there's no `crypto.getRandomValues`, and `Math.random` isn't one), speed (Ed25519 in interpreted QuickJS), compression, time zones (QuickJS has no `Intl`). |

An extension runs on the host, outside the sandbox's limits: not under its 32 MB or its deadline interrupt, and synchronous work blocks AnythingLLM's whole process. So each one caps its input (1 MB a call, say) and stays fast. Its refusals are `LibraryError`s, which the script sees as they are.

The first one is `kit.crypto` (`src/extensions/crypto.ts`): `sha256`/`sha512`, `hmac` (the key given by the function), `random`, `uuid`, Ed25519 `keypair`/`sign`/`verify` with the keys passed in, and `sshsig.verify`, which checks an SSH signature against the public keys given. Bytes go in as text or `{ base64 }`, at most 1 MB a call. It doesn't solve key custody: a key it makes is the function's, and the only place to keep it is `kit.state`, plain JSON that any later function of the toolkit can return.

## Computing on secrets

The rule: **the code that touches a secret is this repo's, never the model's.** A function the model wrote can't be given a secret under any rule about what it may compute, because any output carries information about it: `return key.charCodeAt(0) > 109` leaks a bit a run, and 200 runs read the key. Masking doesn't help, since the output isn't the key.

So a function names a secret and the host computes, the key never entering the sandbox. That's what the library does already: `credentialed()` (`secrets.ts`) puts a key into a request, and `accessToken()` (`oauth.ts`) renews a token. A secret operation is the same, on a closed list of operations, each written so its output is safe:

| Its output | Like | The script gets |
| --- | --- | --- |
| Public: says nothing of the key | An Ed25519 signature, a MAC for a verifier, the public key, whether a signature checks | The value |
| A secret itself | A TOTP code, a signed JWT used as a bearer token, a SigV4 signature, decrypted secret data | Nothing: it stays on the host, goes only into a `kit.http` request to the key's own site, and is masked like a key |

There's no "run this with the key" and no operation that takes the key as data. A sketch:

```js
kit.secret.sign({ key: "muse", data })        // { signature }; the host adds the key's prefix first
kit.secret.publicKey({ key: "muse" })         // { public }
kit.http({ path, sign: { key: "aws", scheme: "sigv4" } })   // computed inside the request
```

`"muse"` and `"aws"` there are names the user gives keys, kept in the vault as `"github"` is today. No key, service or provider is named in the code.

### What's left: a signing oracle

A safe sign still signs whatever the script asks. The key doesn't leak, but a script could sign a message the user never meant. That's bounded, not removed:

- **A key bound to its purpose.** A vault entry of a new kind, `signing`: `{ user: its name, site: its namespace, algorithm: "ed25519", seed, unattended }`, the shape `sshsig` saved, so its keys are read as they are. Made on the Vault (`crypto.randomBytes`) or its seed imported there, sealed as a key is. It signs in a scheduled job only when the user lets it ("Let it sign in scheduled jobs"), and at most 60 times a minute from one process.
- **Its own domain.** A key signs only in its own namespace, set by the user. SSHSIG signs the namespace with the data, so a signature made in one doesn't check in another. *Changed from the design:* a fixed byte prefix (`muse-v1:`) before the data would have broken SSHSIG, which peers check with `ssh-keygen -Y verify` or `sig.py`, and the namespace already separates domains. A raw Ed25519 scheme with a prefix can come when something needs one.
- **No list of toolkits that may use it.** *Dropped from the design:* the model names and saves toolkits, so a key limited to toolkit "muse" is used by any function the model saves into "muse". What bounds a key is what the model can't change: its namespace, the unattended switch, the rate and the record.
- **Every use recorded:** in the run's record (`signed`, beside its requests), and in what `run` answers.
- **Approval in `policy.ts`**, as an `Op` of its own (`sign`), called on every signature; it allows everything until guardrails come, as the others do.

Safe against: the model learning a key, and a script taking one out. Bounded: a script using a key for something unintended. Not covered, as for the vault as a whole: someone with the whole machine.

## As built

| Part | Where |
| --- | --- |
| The SSHSIG format: sign, check, key lines, fingerprints | `src/sshsig.ts` |
| `kit.crypto` | `src/extensions/crypto.ts` |
| The vault kind `signing`; the host signs | `src/signing.ts`; joined in `kitFor()` (`runs.ts`) |
| The Vault's Signing tab (make, import, let into jobs, copy the public key, delete) | `shared/vault.html` (page version 4), its events in `page.ts` |
| A channel's own rules (stamps, peers, how a body is normalized) | the `sshsig-channel` snippet: a function the agent saves, not host code |

A toolkit no longer needs `base_urls`: one whose functions only compute or sign has none.

**The gap checking left, and how it's closed.** Signing is all host code: the namespace, the switch, the rate and the record. Checking wasn't quite: the cryptographic check is `kit.crypto.sshsig.verify`, but the function that says `result=VALID` is one the model saved, and a prompt injection that got the model to save it again could make it say a forged message is valid from then on. Closed 2026-10-20, in two parts:

- **The user locks a toolkit** on the Library page once they've read its functions (`store.ts` `assertUnlocked`, beneath every save and remove, the page's deletes included). Nothing changes it until they unlock it there, and its functions run only locked toolkits' functions (`kit.run`), so what they read doesn't lean on what they didn't. The snippet and the guide ask for the lock. Chosen over approving every save, which is broader: a scheduled job has no one to ask, approvals get waved through, and an injection can talk the user into one.
- **The agent never reaches the skills' pages** (`shared/fence.mts` `pathRefused`): the pages' folders (`PAGE_FOLDERS`: the Vault's, the Library page's, the browser's and the apps', the only folders `shared/pages.mts` writes a page to) and AnythingLLM's `/api/browser-extension/` upload, on every host, whatever the user lets through, in `call`, `kit.http` and the browser. A page acts for whoever holds its link, and the agent is given its links: without this, it could read the page's secret and post the unlock itself whenever AnythingLLM is at an address the fence lets through. It guards the Vault's buttons the same way.

What's still open, as it is for `sshsig`: the model can be told to call an unlocked look-alike, or to skip the check, and nothing in the library tells which function it should have called. And AnythingLLM's own agent tools (its web scraper) aren't the suite's and aren't fenced: with one switched on and AnythingLLM at a public address, a page can still be read. With the channel's toolkit locked, `sshsig` can be retired.

## When to build

| If | Build |
| --- | --- |
| A function needs a hash, an HMAC to check a webhook, a UUID or secure randomness | `kit.crypto` alone: a small phase |
| Muse signing is wanted back, or an API needs SigV4 or a signed JWT | `kit.crypto` and `kit.secret` together, as one phase: crypto alone doesn't sign with a kept key |
| Neither | Nothing |

Sizes guessed beforehand: `kit.crypto` about 100 to 150 lines with its tests; `kit.secret.sign` about 200 to 300. Measured as built: about 345 lines of new source (the format 112, `kit.crypto` 92, the vault kind with `kit.secret` 141), 67 of snippet, about 140 changed across the handler, the run, the pages and the guide, and 237 of tests: more than guessed, because of the Vault's tab, importing a seed and the snippet. Ed25519 runs on the host (Node's crypto), so it wasn't measured in QuickJS.
