# library-lean

The user's own library of API toolkits, as one AnythingLLM agent skill. For a service, the agent reads its API's docs, asks the user for its key, which they give on the Library page (the model never sees it), and saves a toolkit: where the API is, which keys it calls with, what the agent learned of it, and small JavaScript functions that call it. A function runs again on request, and runs other functions as a flow, even across services. Nothing knows any one service.

Functions run in QuickJS, compiled to WebAssembly, inside AnythingLLM's process: a function sees its input and `kit`, never a file, a key or AnythingLLM. `kit.http` reaches only its toolkit's hosts, through the fence (public addresses only), with its toolkit's keys added outside the script. `kit.ssh.exec` runs a command on one of its toolkit's targets, machines the user registers on the Library page (address, account, key and host key's fingerprint); a function names the target, never its address or key. Why QuickJS, and what was measured: [docs/notes/skills/library](../../../docs/notes/skills/library/README.md).

| Action | Does |
| --- | --- |
| `guide` | how the library works, by topic (`static/guide/`), and worked examples (`static/snippets/`) |
| `library` | the toolkits at a glance, or one (`service`) in full |
| `secret` | asks the user for a key (`site`, `label`), given on the Library page; sets up and starts an OAuth sign-in (`kind` oauth, `definition`); or asks for a target (`kind` ssh, `label`), registered there |
| `call` | one request to an API, with a key (`auth`), to read its docs, spec or answers |
| `save` | a toolkit, a function (compiled first) or both; `test` runs what was saved; `remove` |
| `run` | a function (`name`, `inputs`); a run again, or one going on in the background (`run_id`, `stop`) |

## Where it keeps things

| What | Where |
| --- | --- |
| Toolkits, functions (and their last 5 versions), what each keeps between runs, runs, the runs not shown yet (`unseen/`) | `library-lean/` in AnythingLLM's storage |
| Keys, sign-ins (OAuth clients and tokens) and targets (with their private keys) | `vault-lean/vault.json`, encrypted, shared with the browser skill |
| The Library page | `public/library-lean/` beside AnythingLLM's server: the page, its state (nothing secret), `oauth.html`; `library-lean/page.json` holds its token and secret |
| Your own versions of the guide, snippets and prelude | `library-lean/static/`, at the same paths as `static/`: they win over the shipped ones |

## Using it

`anythingllm-suite install` puts it in (see the [README](../../../README.md)); then switch on Library under Agent Skills, set its ANYTHINGLLM_URL to the address you open AnythingLLM at (https, for sign-ins to come straight back), and ask the agent to connect a service. `library` ends with the Library page's link: your own view of the keys, sign-ins, toolkits and runs, where you also give a key or an OAuth client when the agent asks. For an address on your own network (a NAS, a home server), add its host to `FENCE_ALLOW` in AnythingLLM's environment.

For an OAuth sign-in (Google, Microsoft, Slack...), the agent tells you what client to make at the provider and the redirect address to register; you give the client's ID and secret on the Library page, open the link it gives, and agree.

A run the chat waited 40 s for goes on in the background: its end is pushed to you (once you switch on AnythingLLM's notifications), shown on the Library page, and at the top of the agent's next `library` or `run` answer. To run a function on a schedule, ask the agent ("every morning at 7, …"): it adds an AnythingLLM scheduled job with the tool `@@library-lean` (guide topic `schedules`), which you see and change under Scheduled Jobs.

For a target, the agent asks with `secret` (`kind` ssh) and you register the machine on the Library page's Targets tab: its host, port and account, and the fingerprint of its host key, read on the machine (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`). The page makes a key and shows the line for the account's `~/.ssh/authorized_keys`, or takes yours. A private address, or a port this machine forwards to the target (reached from a container as `host.containers.internal:<port>`), needs "On my network" ticked; scheduled jobs use a target only with "May run unattended". Choosing and hardening the machine is yours: a dedicated account without sudo, nothing secret on it.
