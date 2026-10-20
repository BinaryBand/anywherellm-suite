# library-lean

The user's own library of API toolkits, as one AnythingLLM agent skill. For a service, the agent reads its API's docs, asks the user for its key, which they give on the Vault (the model never sees it), and saves a toolkit: where the API is, which keys it calls with, what the agent learned of it, and small JavaScript functions that call it. A function runs again on request, and runs other functions as a flow, even across services. Nothing knows any one service.

Functions run in QuickJS, compiled to WebAssembly, inside AnythingLLM's process: a function sees its input and `kit`, never a file, a key or AnythingLLM. `kit.http` reaches only its toolkit's hosts, through the fence (public addresses only), with its toolkit's keys added outside the script. `kit.crypto` hashes, makes random values and checks signatures, outside the sandbox; `kit.secret.sign` signs with a signing key kept in the vault, which the function names and never sees ([extensions and secrets](../../../docs/notes/skills/library/extensions-and-secrets.md)). Why QuickJS, and what was measured: [docs/notes/skills/library](../../../docs/notes/skills/library/README.md).

| Action | Does |
| --- | --- |
| `guide` | how the library works, by topic (`static/guide/`), and worked examples (`static/snippets/`) |
| `library` | the toolkits at a glance, or one (`service`) in full |
| `secret` | asks the user for a key (`site`, `label`), given on the Vault, or starts GitHub's sign-in (`preset` github) |
| `call` | one request to an API, with a key (`auth`), to read its docs, spec or answers |
| `save` | a toolkit, a function (compiled first) or both; `test` runs what was saved; `remove` |
| `run` | a function (`name`, `inputs`); a run again, or one going on in the background (`run_id`, `stop`) |

## Where it keeps things

| What | Where |
| --- | --- |
| Toolkits, functions (and their last 5 versions), what each keeps between runs, runs, the runs not shown yet (`unseen/`) | `library-lean/` in AnythingLLM's storage |
| Keys, and the GitHub sign-in's tokens | `vault-lean/vault.json`, encrypted, shared with the browser skill |
| The Library page | `public/library-lean/` beside AnythingLLM's server: the page, its state (nothing secret); `library-lean/page.json` holds its token and secret, and the agent's requests for a key |
| The Vault | `public/vault-lean/`: the page every skill that keeps secrets serves, and its keys section (`<token>-keys.json`, nothing secret); `vault-lean/vault-page.json` holds its token and secret |
| Your own versions of the guide, snippets and prelude | `library-lean/static/`, at the same paths as `static/`: they win over the shipped ones |

## Using it

`anywherellm-suite install` puts it in (see the [README](../../../README.md)); then switch on Library under Agent Skills and ask the agent to connect a service. Its ANYTHINGLLM_URL, the address you open AnythingLLM at, is optional: with it, the links work from anywhere. `library` ends with two links. The Vault is your own view of every secret by name: the keys, the sign-ins, the signing keys (which you make or import there), and the browser skill's logins and passkeys, which you delete there; you also give a key there when the agent asks. The Library page is your view of the toolkits and runs. For an address on your own network (a NAS, a home server), add its host to `FENCE_ALLOW` in AnythingLLM's environment, or let it through from AnywhereLLM: during a chat there, `call` asks for an address the fence refuses and waits for the answer, which lets that origin (scheme, host and port) through: once, for the rest of that agent run, its functions' runs included; or always. A key goes over plain http only to a host in `FENCE_ALLOW` or an origin let through always. A function never asks, and a scheduled job is refused.

For GitHub, the agent signs in with the suite's own client (`preset` github, the device flow): it shows a code, you enter it at github.com/login/device and agree, and tell it you're done. Any other service takes a key or a token, which you give on the Vault. Sign-ins with an OAuth client of your own (Google, Microsoft, Slack...) were taken out to keep the skill small; the code is on the branch `archive/generic-oauth`.

A run the chat waited 40 s for goes on in the background: its end is pushed to you (once you switch on AnythingLLM's notifications), shown on the Library page, and at the top of the agent's next `library` or `run` answer. To run a function on a schedule, ask the agent ("every morning at 7, ..."): it adds an AnythingLLM scheduled job with the tool `@@library-lean` (guide topic `schedules`), which you see and change under Scheduled Jobs.
