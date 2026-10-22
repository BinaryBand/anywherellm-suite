# The page links, for the bridge

Where the Library page, the Vault and the apps manager are, for whoever shows them to the user: AnywhereLLM's bridge (`GET /pages`) and `anywherellm-suite pages`. The skills write the file (`packages/shared/page-links.mts`, `noteLink`) and the bridge only reads it; it is the one file the two repositories share. A change to anything here is made in the suite and the bridge together.

## `<storage>/anywherellm-suite/page-links.json`

```json
{ "library": "/library-lean/<token>.html", "vault": "/vault-lean/<token>.html", "apps": "/apps-lean/manager-<token>.html", "rotated": { "vault": "2026-10-21T08:02:00.000Z" } }
```

| Field | Type | Meaning |
| --- | --- | --- |
| `library` | string, optional | the Library page's path, root-relative on AnythingLLM's address; absent until the library first shows it |
| `vault` | string, optional | the Vault's path, the same way; absent until a skill first shows it |
| `apps` | string, optional | the apps manager's path (every workspace's apps, and the trash), the same way; absent until the apps skill's first chat call |
| `rotated` | object, optional | for each page, when its token was last replaced by a rotation, ISO-8601 in UTC |

A valid path matches `^/library-lean/[A-Za-z0-9_-]{24}\.html$`, `^/vault-lean/[A-Za-z0-9_-]{24}\.html$` or `^/apps-lean/manager-[A-Za-z0-9_-]{24}\.html$`: the token is 18 random bytes in base64url (`newSecret()`). The manager shares `apps-lean/` with the apps' own pages (`<token>.html`, opened differently), and its `manager-` name is a shape no app page has. A reader takes anything else, a missing file, a link in its place or a file that isn't JSON as no link for that page, never as an error.

The file is mode `0600`, written to a temporary file and renamed over the old one under its lock (`page-links.json.lock`), and kept whether or not the links are kept from the agent (`page-links-hidden`). It holds no event secret and no page key, but a path is a bearer capability (whoever fetches the page gets the secret its HTML embeds): never log it or show it beyond the user.
