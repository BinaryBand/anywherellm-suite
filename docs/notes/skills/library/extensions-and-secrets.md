# Extensions and computing on secrets

A design for two things the library doesn't have: pre-written host functions in `kit` (extensions), and functions that use a secret without seeing it (signing, for one). Decided in the session of 2026-10-18, and **not built**: build it when a function needs it (see "When to build").

## Why not now

Nothing calls for it yet. SSH targets were planned, built, hardened and tested on a Pi, then archived a day later because they were used much less than expected (branch `archive/ssh-targets`). The one real use of signing then was the Muse email channel: its functions signed through `kit.ssh.exec` on the Pi, with the seed on the Pi, kept from the model only by an instruction in the toolkit's notes. It stopped with the archive, by choice.

## Extensions: host functions that only compute

An extension is a group in `kit` written in this repo, in `src/extensions/<name>.ts`, and joined to every function's kit by one line in `kitFor()` (`runs.ts`), with its lines in `static/guide/functions.md`. The sandbox already installs nested groups (`kit.state.get`).

The rule: **an extension only computes.** JSON in, JSON out; no network, no files, no vault, nothing kept between calls. A function could compute the same in plain JavaScript, so an extension adds no reach, and it needs no policy check.

| Put it in | When |
| --- | --- |
| `static/prelude/*.js` | It's plain JavaScript (`kit.retry`, `kit.b64`). It runs in the sandbox, and an instance can tune it. |
| `src/extensions/` | The sandbox can't do it well: secure randomness (there's no `crypto.getRandomValues`, and `Math.random` isn't one), speed (Ed25519 in interpreted QuickJS), compression, time zones (QuickJS has no `Intl`). |

An extension runs on the host, outside the sandbox's limits: not under its 32 MB or its deadline interrupt, and synchronous work blocks AnythingLLM's whole process. So each one caps its input (1 MB a call, say) and stays fast. Its refusals are `LibraryError`s, which the script sees as they are.

The first one, when wanted: `kit.crypto` with `sha256`/`sha512`, `hmac` (the key given by the function), `random`, `uuid`, and Ed25519 `keypair`/`sign`/`verify` with the keys passed in. It doesn't solve key custody: a key it makes is the function's, and the only place to keep it is `kit.state`, plain JSON that any later function of the toolkit can return.

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

- **A key bound to its purpose.** A vault entry of a new kind, `signing`: its algorithm, the operations it allows, the toolkits that may use it, whether a scheduled job may ("May run unattended"), and a rate. Made in the vault (`crypto.randomBytes`) or pasted on the Library page, sealed as a key is.
- **Its own domain.** The host puts the key's fixed prefix (`muse-v1:`) before what it signs, so its signatures mean nothing anywhere else.
- **Every use recorded:** in the run's record, beside its requests, and on the Library page.
- **Approval in `policy.ts`**, as an `Op` of its own, when guardrails come.

Safe against: the model learning a key, and a script taking one out. Bounded: a script using a key for something unintended. Not covered, as for the vault as a whole: someone with the whole machine.

## When to build

| If | Build |
| --- | --- |
| A function needs a hash, an HMAC to check a webhook, a UUID or secure randomness | `kit.crypto` alone: a small phase |
| Muse signing is wanted back, or an API needs SigV4 or a signed JWT | `kit.crypto` and `kit.secret` together, as one phase: crypto alone doesn't sign with a kept key |
| Neither | Nothing |

Sizes guessed, not measured: `kit.crypto` about 100 to 150 lines with its tests; `kit.secret.sign` about 200 to 300 (the vault kind, a page tab, purpose binding, the record, the policy op). Measure Ed25519 in QuickJS before choosing where it runs.
