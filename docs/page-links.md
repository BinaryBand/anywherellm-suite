# The page links, for the bridge

Where the Library page, the Vault and the apps manager are, for whoever shows them to the user: AnywhereLLM's bridge (`GET /pages`) and `anywherellm-suite pages`; and, for AnywhereLLM Lite's shelf, the browser's open tabs and the Library's and the apps' status. The skills write the file (`packages/shared/page-links.mts`: `noteLink`, `noteTabs`, `noteStatus`) and the bridge only reads it; it is the one file the two repositories share. A change to anything here is made in the suite and the bridge together.

## `<storage>/anywherellm-suite/page-links.json`

```json
{
  "library": "/library-lean/<token>.html", "vault": "/vault-lean/<token>.html", "apps": "/apps-lean/manager-<token>.html",
  "rotated": { "vault": "2026-10-21T08:02:00.000Z" },
  "browser": [{ "path": "/browser-lean/<token>.html", "workspace": "household", "until": 1792742400000, "drawn": 1792741200000 }],
  "status": { "library": { "failed": ["2026-10-23T08:14:03.512Z"] }, "apps": { "changed": ["2026-10-23T09:00:00Z"] } }
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `library` | string, optional | the Library page's path, root-relative on AnythingLLM's address; absent until the library first shows it |
| `vault` | string, optional | the Vault's path, the same way; absent until a skill first shows it |
| `apps` | string, optional | the apps manager's path (every workspace's apps, and the trash), the same way; absent until the apps skill's first chat call |
| `rotated` | object, optional | for each page, when its token was last replaced by a rotation, ISO-8601 in UTC |
| `browser` | array, optional | the browser's open tabs, of every chat's workspace (not a scheduled job's), newest drawn first, at most 20; absent until the browser first draws a tab |
| `status` | object, optional | `library.failed`: when the recent runs that failed ended (error, timeout or interrupted; a run the user stopped isn't one), newest first, of the last 20 runs; `apps.changed`: when each app last changed, newest first, at most 50, of every workspace. Times are ISO-8601 in UTC, with or without milliseconds. Each is absent until its skill first writes it |

Each `browser` entry:

| Field | Type | Meaning |
| --- | --- | --- |
| `path` | string | the tab's page, as `/browser-lean/<token>.html` ([browser-tab.md](browser-tab.md)); its state is `<token>.json` beside it |
| `workspace` | string | the workspace's slug |
| `until` | number | when the workspace's browser closes, ms since 1970: written again when a tab comes or goes, or when it moved a minute or more, so it's a minute out at most; the tab's own state has it exactly. A tab past it is closed: a restart of AnythingLLM ends the browsers without writing the list, which drops them at its next write |
| `drawn` | number | when the tab was drawn as it was listed, ms since 1970, which orders the list; the bridge doesn't pass it on |

What the bridge passes on is paths, numbers and times only, never text a skill wrote: a client writes the words ("2 runs failed", "3 changed today").

A valid path matches `^/library-lean/[A-Za-z0-9_-]{24}\.html$`, `^/vault-lean/[A-Za-z0-9_-]{24}\.html$`, `^/apps-lean/manager-[A-Za-z0-9_-]{24}\.html$` or, for a tab, `^/browser-lean/[A-Za-z0-9_-]{24}\.html$`: the token is 18 random bytes in base64url (`newSecret()`). The manager shares `apps-lean/` with the apps' own pages (`<token>.html`, opened differently), and its `manager-` name is a shape no app page has. A reader takes anything else, a missing file, a link in its place or a file that isn't JSON as no link for that page, never as an error.

The file is mode `0600`, written to a temporary file and renamed over the old one under its lock (`page-links.json.lock`), and kept whether or not the links are kept from the agent (`page-links-hidden`). It holds no event secret and no page key, but a path is a bearer capability (whoever fetches the page gets the secret its HTML embeds): never log it or show it beyond the user.
