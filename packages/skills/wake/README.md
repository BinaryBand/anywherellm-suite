# Wake (`wake-lean`)

Runs an AnythingLLM scheduled job when a message arrives on an ntfy topic, in place of a job that
runs every hour to look. When a message arrives, the wake lets the burst finish (30 s), then runs
the topic's job the way the job's Run now button does. At most one run of a job goes at a time,
and the wake's runs are at least 2 minutes apart. Messages that arrive meanwhile make one more run
afterwards.

The wake never reads, keeps or passes on a message's text: it takes only the message's id. The
job reads the topic itself, with whatever tool its prompt names (for example a Library toolkit for
ntfy), so what a message means and how it is checked stay with the job, and any topic can wake any
job. The job may be switched off: then it doesn't run on its schedule, and the wake still runs it.

## When it listens

ntfy can't call a skill, so the skill listens on its own. AnythingLLM loads a skill's handler.js
for each agent run, never at startup, and loading it starts one listener in AnythingLLM's process.
Loading it again with the same code and settings keeps that listener; a new install or changed
settings replace it. So **after AnythingLLM starts, the wake listens from the first agent run**
(any chat with the agent). Nothing is lost before then: ntfy keeps messages for its cache time, and
the wake follows each topic from the last message a run was started for
(`<storage>/wake-lean/state.json`), so what came meanwhile makes one run. The process AnythingLLM
forks for a scheduled job never listens.

The `status` action says whether it's listening and shows its latest lines (topics, message ids and
jobs; never a message's text or a token). AnythingLLM's log has the same lines, marked
`[wake-lean]`.

## Settings (Settings > Agent Skills > Wake)

| Setting | What it is |
| --- | --- |
| `NTFY_URL` | the ntfy server |
| `NTFY_TOKEN` | an access token that may read the topics |
| `WAKE` | `topic=job` pairs, comma-separated (`inbox=12`); a job's number is in its address under Settings > Scheduled jobs |

## AnythingLLM's side

It calls AnythingLLM's internal API from inside its process (`http://127.0.0.1:$SERVER_PORT`),
logged in with AnythingLLM's password (`AUTH_TOKEN`), since the developer API has no scheduled
jobs: `GET /api/scheduled-jobs/<id>/runs` (a run `queued` or `running` hasn't ended) and `POST
/api/scheduled-jobs/<id>/trigger`. Single-user mode only, as AnythingLLM's job routes are; not with
`ENABLE_HTTPS` (its own certificate isn't one a fetch takes).
