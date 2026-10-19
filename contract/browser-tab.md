# The browser's tab, for clients

What the browser skill (`packages/skills/browser`, hubId `browser-lean`) publishes about a chat's tab, so a client such as AnywhereLLM Lite can show its own cards for it: a request for a login or a code, the answer sent, and the chat going on once it's typed. The stock AnythingLLM chat shows none of this; it renders the agent's Markdown, whose card opens the tab's page.

`tests/page.test.mts` checks the state's fields below against what the skill writes. A change to anything here is made in the skill and this file together.

## The card in the agent's reply

An answer about the tab ends with its card, as Markdown:

```text
[![<name>](<base>/browser-lean/<token>-card.jpg?v=<stamp>)](<base>/browser-lean/<token>.html)

**<name>** · <host>
```

- `<base>` is the skill's `ANYTHINGLLM_URL` setting, or empty (links from AnythingLLM's own root).
- `<token>` names the chat's tab: it stays the same for the tab's life, and a new tab gets a new one. It's a capability: whoever has it can read the tab's state and post to its page.
- `<name>` and `<host>` hold no brackets or line breaks. A reply without a picture has the last line alone.

A client finds the card by the link `…/browser-lean/<token>.html` and reads the files beside it, all served by AnythingLLM's public folder with no sign-in.

| File | What it is |
| --- | --- |
| `<token>.html` | the tab's page (the skill's `static/pages/tab.html`) |
| `<token>.json` | the tab's state (below), written after each step and each change from the page |
| `<token>.jpg` | the tab's picture |
| `<token>-card.jpg` | the card's crop of it |

Read `<token>.json` with a query that changes (`?t=<now>`) or no cache: it's rewritten in place.

## The state, `<token>.json`

| Field | Type | Meaning |
| --- | --- | --- |
| `title` | string | the page's title, at most 200 characters |
| `url` | string | the tab's address, at most 2000 characters |
| `host` | string | its host |
| `shot` | number | when the state and picture were written, ms since 1970 |
| `size` | `{w, h}` | the tab's screen, in CSS pixels |
| `who` | `"agent"` or `"user"` | who holds the tab (`user`: taken over on its page) |
| `fields` | array | the fields in view, only while the user holds the tab |
| `need` | object or null | what the agent asked the user to enter (below) |
| `offer` | object or null | a login or passkey the page offers to save: `{kind, site, user}` |
| `msg` | `{text, id}` or null | a line for the page to show once ("Saved for example.com"; a login the site seems to have refused). It stays in the state for up to a minute, so show each `id` once |
| `vault` | string or null | the path of the Vault on this host (`/vault-lean/<token>.html`), where the saved logins and passkeys are listed and deleted; null where it couldn't be written |

A closed tab's state is `{"closed": true}`, and its other files are gone.

### `need`

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | `"login"` or `"code"` | a login (username and password) or a one-time code |
| `host` | string | the site it's for; it's typed only while the tab is still on it |
| `text` | string | the request, in the skill's own words, never the model's, said to the person under the form's title: `No login is saved for <host>.`, `For a new account on <host>.` or, for a code, `For <host>.` (a request asked again says why) |
| `label` | string or null | for a code: "The verification code", "The code from your authenticator app", "The code sent to your phone" or "The code sent to your email" |
| `hasUser` | boolean | for a login: whether a username is asked for too |
| `confirm` | boolean | for a login: a new account's password, which the user chooses; it's typed into the "Confirm password" field too |
| `until` | number | when the request lapses, ms since 1970 (10 minutes after it was made) |

`need` goes back to null once the answer is typed, the user cancels, or it lapses. When the form can't be sent yet because it needs something else first (a CAPTCHA, say), the answer is typed but not submitted, and `msg` says what's still needed. When the site still shows the same field after an answer was submitted (a login or code it likely refused), the request is made again with a `text` that says so.

## Answering, as the page does

The page's settings are in `<token>.html`, on the line `const cfg = {…};`: `token`, `secret`, `title` (`"browser-lean-event"`), `workspace`, `tab`, `key` (the page's upload key) and `pub` (the vault's public key, SPKI, base64). A client that answers reads them there.

An event is posted to AnythingLLM's browser-extension upload, as a document whose text is the event's JSON:

```http
POST <base>/api/browser-extension/upload-content
Authorization: Bearer <cfg.key>
Content-Type: application/json

{"textContent": "<the event, as JSON text>", "metadata": {"title": "browser-lean-event", "docSource": "browser-lean page"}}
```

Every event carries `{"browser_lean_event": 1, "workspace": cfg.workspace, "tab": cfg.tab, "secret": cfg.secret, "ev": "<kind>", "t": "<ISO time>"}` and its own fields. One without the tab's `secret` is dropped.

| `ev` | Fields | What it does |
| --- | --- | --- |
| `need-answer` | login: `user` (when `hasUser`), `sealed` (the password, sealed), `save` (true: save the login once signed in); code: `text` | types it into the tab, and clicks the request's submit button if the agent named one |
| `need-cancel` | `reason`: `"later"` or `"takeover"` | drops the request; the agent is told the user chose not to, or is taking the tab over |

**Sealing a password:** RSA-OAEP with SHA-256 under `cfg.pub`, base64. A value longer than 190 bytes is sealed as `h1.<key>.<iv>.<value>`: the value with a new AES-256-GCM key (its 16-byte tag last), and that key with RSA-OAEP, each part base64. The skill opens it with the vault's private key; AnythingLLM's documents hold only the sealed text. A code is sent as it is.

The page's other events (`take`, `give`, `tap`, `scroll`, `type`, `nav`, `size`, `offer`) are its takeover and its offer to save a login, not part of this contract yet.

## When an answer lands

The skill applies a page's events within a second or two while it watches (for 30 minutes after it last drew the tab's card), and otherwise at the agent's next call. Once an answer is typed, the state is written again with `need` null. The agent isn't woken: it learns what happened at its next call, as a note in its read of the tab. So a client that wants the chat to go on sends a message of its own once `need` is null and `shot` is later than its answer (for example "Done: I entered it on the tab's page").
