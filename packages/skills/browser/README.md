# browser-lean

Tasks on the web, as one AnythingLLM agent skill: research (search the web, look at a page) and a real Chrome with a tab per chat, which the agent opens, reads as text with a ref on each element, and acts on by those refs. It runs inside AnythingLLM's process, with the Puppeteer bundled in the skill and the Chrome AnythingLLM's image ships, so nothing is installed beside it. A task worth running again, and any API with a key, are the library skill's; the browser is for what only a person's clicks can do.

| Action | Does |
| --- | --- |
| `guide` | how to pick the way to do a task, by topic (`static/guide/`) |
| `search` | the web, through `SEARCH_URL` (DuckDuckGo's plain HTML search by default) |
| `look` | reads a page in a page of its own, without moving the tab |
| `open` | an address in this chat's tab |
| `read` | the tab as text, with refs (`find`, `from` for long pages) |
| `act` | click, fill, type, press, select... by ref; or several `steps` |
| `login` | types the saved login; with none, the user enters it on the tab's page; `confirm_ref` asks them to choose a new account's password; `what` asks them for a code the same way |
| `call` | one request from the tab, with its signed-in session (`auth` "session") |

Each answer about the tab ends with its card, a picture of the tab that opens its page. There the user sees the tab, enters what the agent asks for (sealed on their device; the model never sees it) and saves the login they typed. The saved logins and passkeys are listed and deleted on the Vault, which the tab's page links to: a page this skill serves, with its logins section, and the library skill too, with its keys and sign-ins, so either works alone. A saved password is put into the page only in one call that first checks the field is in the page's own document on the login's site, never in a frame and never as keystrokes; a code is typed after the same check. Every request Chrome makes goes through the fence: the public web only, the hosts in `FENCE_ALLOW`, and the origins (scheme, host and port) the user lets through on the Vault, under Allowed addresses (`#shared/addresses`). An address the fence refuses is refused at once, and the agent is told the user can let it through there; the Vault lists the ones refused lately, to allow with a tap.

## Where it keeps things

| What | Where |
| --- | --- |
| Logins and passkeys | `vault-lean/vault.json` in AnythingLLM's storage, encrypted, shared with the library |
| Each workspace's cookies (so its sign-ins last) | `vault-lean/sealed/session-<workspace>.json`, encrypted with the vault's key |
| Chrome's profile while it runs | a temporary folder, removed when it closes |
| Each workspace's tabs' page names | `browser-lean/<workspace>/` |
| The tabs' pictures, state and pages | `public/browser-lean/` beside AnythingLLM's server |
| Your own versions of the guide and the page | `browser-lean/static/`, at the same paths as `static/` |

## Using it

`anywherellm-suite install` puts it in. Switch on Browser under Agent Skills, and set its ANYTHINGLLM_URL to the address you open AnythingLLM at, so the card opens anywhere. It needs a Chrome: the newest one Puppeteer downloaded (`PUPPETEER_CACHE_DIR`, else `~/.cache/puppeteer`, where AnythingLLM's Docker image keeps its collector's), else a system Chrome or Chromium in `/usr/bin`; set `BROWSER_LEAN_CHROME` in AnythingLLM's environment to choose one. The tab's page needs the pages' key (`install --page-key`, see the [README](../../../README.md#install)).

On the tab's page the user can also take the tab over: tap, swipe to scroll, type into a field with their own keyboard (a password sealed on their device), go back or reload, then hand it back. The agent reads but doesn't act meanwhile, and a hold with no step for 10 minutes lapses. After the user signs in that way, the page offers to save the login.

Pages: fields inside open shadow roots work like any other. A password field stays one after "Show password" turns it into a text field, so `act` still won't type into it. A login isn't sent while its form still needs something else (a CAPTCHA, say): the agent and the user are told what. Fields inside iframes aren't read yet; there the user takes the tab over, and can't type into them either.

Passkeys: every tab has Chrome's virtual authenticator holding the saved passkeys, so a site's passkey sign-in works by itself. A passkey a site makes while the user holds the tab is offered for saving; one made while the agent has it is taken out again. The lean browser's passkeys are imported.
