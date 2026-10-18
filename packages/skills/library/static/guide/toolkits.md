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

- base_urls: where the API is; a function's path is relative to the first.
- hosts: any other host its functions must reach (the base addresses' hosts are in already). A function reaches nothing else.
- secrets: the keys its functions send (topic secrets); the first goes with a request unless it names another.
- notes: what a function needs to know and the docs don't make easy to find: endpoints, paging, limits, quirks. Keep them short; you'll read them again before writing the next function.

Saving again replaces only what you give. save with remove "github" removes the toolkit and its functions (its keys stay); remove "github.list_issues" removes one function.
