A toolkit is one service's API, as you found it. Save it with save, service (its short name, like "github" or "google-calendar") and toolkit:

```json
{
  "title": "GitHub REST API",
  "base_urls": ["https://api.github.com"],
  "hosts": ["uploads.github.com"],
  "secrets": [{ "label": "github", "as": "bearer" }],
  "docs": ["https://docs.github.com/en/rest"],
  "notes": "Pages with a Link header (rel=next), 100 a page at most. Issues include pull requests: skip those with pull_request. 5000 requests an hour."
}
```

- base_urls: where the API is; a function's path is relative to the first. Leave it out for a toolkit with no API, whose functions only compute or sign (kit.crypto, kit.secret).
- hosts: any other host its functions must reach (the base addresses' hosts are in already). A function reaches nothing else.
- secrets: the keys its functions send (topic secrets); the first goes with a request unless it names another.
- targets: the machines its functions run commands on (topic targets), by name. A toolkit with targets needs no base_urls.
- notes: what a function needs to know and the docs don't make easy to find: endpoints, paging, limits, quirks. Keep them short; you'll read them again before writing the next function.

A toolkit the user locked (library marks it "locked by the user") can't be saved, changed or removed, nor its functions, and its functions run only functions of locked toolkits. Its keys are for locked toolkits only: call, or a toolkit the user hasn't locked, can't send with them (library says "not usable here"); run the locked toolkit's function instead, and don't ask the user for the same key under another name. The user locks one on the Library page once they've read its functions, so that nothing changes what they read. If it needs a change, say what and why, and ask them to unlock it there. Never save a copy under another name to get around it.

Saving again replaces only what you give. save with remove "github" removes the toolkit and its functions (its keys stay); remove "github.list_issues" removes one function.
