# anywherellm-wake

Runs an AnythingLLM scheduled job when a message arrives on an ntfy topic, in place of a job that
runs every hour to look. A small service on the host follows each topic as a stream; when a
message arrives it lets the burst finish (`BURST_MS`), then runs the topic's job the way the job's
Run now button does. At most one run of a job goes at a time, and the wake's runs are at least
`GAP_MS` apart; messages that arrive meanwhile make one more run afterwards.

The wake never reads, keeps or passes on a message's text: it takes only the message's id. The
job reads the topic itself, with whatever tools its prompt names (for example the Library's ntfy
toolkit), so what a message means and how it is checked stay with the job, and any topic can wake
any job.

## Why a service and not a skill

AnythingLLM runs a skill, or an MCP server's tool, only when an agent calls it, so neither can wait
for a message. Something has to stay connected to ntfy, and a job started by it still runs as a
job: the skills' unattended rules apply to it (a chat started through the developer API wouldn't
count as one).

## Install

```sh
cd packages && node build.mjs wake
node wake/dist/anywherellm-wake.cjs install --storage /srv/anythingllm/storage
# fill in ~/.config/anywherellm-wake/wake.env, then
node wake/dist/anywherellm-wake.cjs install
node wake/dist/anywherellm-wake.cjs health
```

`install` writes the settings file once (mode 600), copies itself to
`~/.local/share/anywherellm-wake/` (a rebuild changes nothing running until the next install) and
writes the systemd user unit `anywherellm-wake.service`, which it starts once the settings are filled
in. `uninstall` stops and removes the unit and keeps the settings. The log is `journalctl --user -u
anywherellm-wake`; it names topics, message ids and jobs, never a message's text or a token.

## Settings (`wake.env`)

| Setting | Default | What it is |
| --- | --- | --- |
| `NTFY_URL` | | the ntfy server |
| `NTFY_TOKEN` | | a token that may read the topics |
| `WAKE` | | `topic=job` pairs, comma-separated (`anythingllm=26`); the job's number is in its address under Settings > Scheduled jobs |
| `BURST_MS` | 30000 | how long a burst is let finish before the run |
| `GAP_MS` | 120000 | the least time between two runs of a job (a leaked write token can't run it more often) |
| `ANYTHINGLLM_STORAGE` | | AnythingLLM's storage: its `.env` holds the password (`AUTH_TOKEN`) |
| `ANYTHINGLLM_URL` | `http://127.0.0.1:3001` | AnythingLLM |
| `WAKE_STATE` | `~/.local/state/anywherellm-wake/state.json` | the last message each topic's run was started for |

The job may be switched off: a switched-off job doesn't run on its schedule, and the wake still
runs it. After a restart, or when ntfy comes back, the wake follows each topic from the last message
a run was started for, so what arrived meanwhile makes one run.

## AnythingLLM's side

The routes are AnythingLLM's internal API (single-user mode, a token from `POST
/api/request-token`), since the developer API has no scheduled jobs: `GET /scheduled-jobs/<id>`,
`GET /scheduled-jobs/<id>/runs` (a run `queued` or `running` hasn't ended) and `POST
/scheduled-jobs/<id>/trigger`. Multi-user mode isn't supported.
