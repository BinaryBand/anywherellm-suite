# apps-lean

Small apps a user keeps in a workspace, such as a shopping list, daily habits or a focus timer, as one AnythingLLM agent skill with no server of its own. Each app is a JSON file of its data and its page; the page is built from the shipped parts (templates, components, figures), published into AnythingLLM's public folder, and saves taps back as event documents the skill applies at its next call. Ported from the lean edition (`anythingllm-lean/skills/apps`, 0.17); the in-chat form, the file-card fallback and the bundled font were left behind.

| Action | Does |
| --- | --- |
| `list` | this workspace's apps, each with its card's first line, then how to make a new one |
| `create` | an app from a starter, or from a template with `parts` (components composed in, their schemas merged) and `text` (app.json); without a starter it needs a `plan` |
| `do` | a JSON Patch (RFC 6902) on the data, with `ev` naming what happened |
| `read` | with `file`, `app.json` or `page.html`; without, app.json, the data and the newest changes |
| `edit` | `app.json` or `page.html`: replaces text found exactly once (`find`), or with no `find` the whole file |
| `undo` | takes back the newest change, to the data or a file; with `file`, that file's newest change |
| `page` | publishes the app's page; the card's title is its link |
| `delete` | moves the app to the trash, after AnythingLLM's approval prompt where it has one; never in a scheduled job |
| `dismiss` | clears one of the page's asks (`ask`) without changing the app, such as a question answered in the chat; never in a scheduled job |
| `guide` | this edition's notes, the starters, the parts and design rules; with `query`, each topic or part it names |

## Where it keeps things

| What | Where |
| --- | --- |
| Each app: app.json's keys, page.html, data, its newest 20 changes and 10 earlier files, its page's token and secret | `apps-lean/<workspace>/<name>.json` in AnythingLLM's storage, changed under its lock |
| The key every page posts with (a browser-extension key: it can store documents, never read them) | `apps-lean/.page-key.json` |
| Each app's page, at a random address | `public/apps-lean/<token>.html` beside AnythingLLM's server (`ANYTHINGLLM_PUBLIC_DIR` to move it) |
| What a page posts, until the skill applies it | `documents/custom-documents/raw-apps-lean-event-*.json`, as AnythingLLM's collector writes it |
| What pages did since a workspace's last chat call (20 lines) | `apps-lean/<workspace>/.news.json` |
| Your own versions of the parts, topics and runtime | `apps-lean/.static/`, at the same paths as `static/`: they win over the shipped ones |

## Using it

`anythingllm-suite install` puts it in (see the [README](../../../README.md)); then switch on Apps under Agent Skills. Each app's page is published as it's made; set Apps' ANYTHINGLLM_URL to the address your browser and phone reach AnythingLLM at, so the card's link opens from anywhere rather than only from AnythingLLM's own chat. Where the public folder can't be written (AnythingLLM Desktop), apps work from the chat and have no page.

Taps reach the app as they land: the skill watches where AnythingLLM's collector writes what pages post, from its first call after AnythingLLM starts until AnythingLLM stops (not in a scheduled job, whose process ends within minutes), and each workspace's next chat call is told what its pages did. Until that first call, taps show on the device that made them and reach the app at the call. Where the folder watch doesn't see changes (Docker Desktop's bind mounts on macOS and Windows), a 30 s poll does.

Each page has Comment, beside its first heading (in the top right corner of a page with none): tap it, tap up to five things on the page (taps pick then, they don't press), say one thing about them, a question or a change, and send. It reaches the chat as an ask; the agent sees it in `read`, with where each pick is in page.html. A question it answers in the chat; a change it makes only when you ask it to there. An ask that needs no change is cleared with `dismiss`. At most 10 asks wait on an app.

To ask you something a chat can't show well (pick a worktop from three, with a note), the agent makes a question app from the `question` starter and its turn ends with the card; you answer on the page, and the agent reads your answer at its next call, as data. The app is kept.

To keep an app up on a schedule, ask the agent ("every morning at 6, put a new puzzle in it"): it lets the app take a job's changes (app.json's `"jobs": true`) and adds an AnythingLLM scheduled job with the tool `@@apps-lean` (guide topic `schedules`). A job has no workspace of its own, so it names the app's; in a workspace it names it can only list, read and change the data of an app that takes it, never make, rewrite, take back or delete one. A deleted app is kept under `apps-lean/.trash/` (the newest 20) in case it was a mistake.

A page posts each change with its app's secret, and the skill applies it to that app alone, so one app's link changes no other. An app from before apps had a secret takes its page's events until it gets one; once per process the skill writes again every page an older skill or older parts made, which also gives those apps their secret.

## What it needs of AnythingLLM

The storage folder; the public folder, which AnythingLLM serves without a sign-in; `models/browserExtensionApiKey` to make the pages' key, and the browser-extension upload its pages post to (`#shared/pages`); the invocation's workspace and thread; and `requestToolApproval` for `delete`. Each is listed in `docs/.scratch/TODO.md`.

## Check

`tests/*.test.mts` (`npm run skills:test` in `packages/`): the store, patch, schema and card from `src`, the parts read from `static/` as the build inlines them, and the handler through the built bundle.
