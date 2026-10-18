# The apps skill: notes

What changed from the lean edition and why is in the decisions log (`docs/notes/README.md`, "The apps skill moved in"); this is how it was checked.

## Check

`tests/*.test.mts` run against the source (the store, patch, schema, card, parts and page, with the parts read from `static/` as `build.mjs` inlines them) and the built bundle (the handler), on Node 22. `tests/e2e/inside.js` runs in a started 1.16 image, against the real server, collector and browser-extension upload:

```sh
make e2e-skill SKILL=apps
```

On 2026-10-16 it printed ok on the image's Node 18.20.8, on fresh storage: a starter's page published as it was made and served by AnythingLLM, with its state file (line, data, seen, refused, version, nothing else) and the app's secret in it but no address; a tap posted twice to the real upload, written by the real collector, applied once by the skill's folder watch with no call and in the state file, and told to the next `list`; an untick carrying another secret refused; a page edit refused by the page check running in its worker thread; a delete refused, then made, leaving `{gone: true}` for a page still open.

Later the same day, with highlights: Change this in the collector's real Chrome, on a tracker starter's page: a tap on the counter's + while picking picked it and didn't step the count, the description sent from the tray (a Shadow DOM) reached the app as an ask apart from its data, `read` gave the button's opening tag as edit's find, and once sent the + stepped again. It printed ok.

On 2026-10-18, with Change this renamed Comment (one text for all picks, the button beside the page's first heading, `dismiss` for an ask that needs no change), it printed ok again. Headless Chromium on four starters' pages checked the rest: the button sits in the heading's row (in the corner on the explainer, which has no `h1`), the tray goes on the body while open and back beside the heading after, Send stays off until there's text, keys typed in the tray don't reach the deck, and a page that redraws its heading's container gets the button back on the next sync.

A container's public folder (`/app/server/public`, which also holds AnythingLLM's web app, so only `public/apps-lean` could be bind-mounted) is its own, so a podman quadlet that makes the container again on each restart empties it: the pages go, and the first chat call after the restart writes them again (`upgrade` writes any page that isn't there, as well as any of an older version).

Not tried: a real agent driving it, AnythingLLM Desktop, Docker Desktop's bind mounts (where the 30 s poll stands in for the folder watch), and the upgrade on the live instance's 47 apps.
