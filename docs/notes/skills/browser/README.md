# browser-lean: notes

The lean browser (`anythingllm-lean/skills/browser`, 4,800 lines of JavaScript) rebuilt on `packages/shared`, from the session of 2026-10-16. Its core first, by the user's choice: research, the tab, logins and codes on the tab's page; then, the same day, the takeover (tapping and typing on the tab's picture) and passkeys.

## What moved where

- Already shared, from the library's phases: the fence, the request client, the answer's checks and masking, the vault, the pages' key and events.
- Ported, nearly as they were: Chrome per workspace (`browser.ts`), the act verbs (`act.ts`), the page as text (`snapshot.ts`, `view.ts`), search and look (`research.ts`), a tab per thread (`scope.ts`).
- New: logins in the instance's vault (`logins.ts`), and a tab page that only shows the tab and takes what the agent asks for (`page.ts`, `static/pages/tab.html`).
- Dropped: saved actions (the library's functions do that now), OAuth (the library's), the key-asking (the library's page), the question card (it shows its answers in the chat; the library left it in phase 3 for the same reason).

## Decisions

- **Puppeteer is bundled, Chrome is found** *(changed 2026-10-18; it was the collector's, required from `/app/collector/node_modules/puppeteer`)*: see the repo notes of that day. `BROWSER_LEAN_PUPPETEER` still names a stand-in, which the tests use.
- **Only the password or the code is hidden** from what the agent reads, not the username: a username hidden everywhere also hid it inside other words. The lean browser hid both.
- **A login the user asks to save is saved at the tab's next read where the page no longer asks for a password** (and is still on its site), not when the address changes: a sign-in form that posts back to its own address left nothing saved (found by the e2e, against a real Chrome), and a check right after submitting missed a login the agent submits later.
- **The page's state lists every saved login** (site and username), as the library's page lists every key by name: the vault is the instance's, not a workspace's.
- **The user's hold on a tab lapses after 10 minutes without a step** (the lean one never did), so a page left open on a phone can't keep the agent waiting for good.
- **A field behind an open dialog isn't clicked or typed into** (a cookie dialog that makes the page inert, say): act and login refuse, naming the dialog and its buttons, and login asks the user nothing until it's closed. "Behind" is one rule in the read and in act: under an inert ancestor, or under a dialog (`DIALOG`) at the element's middle. A read lists the open dialogs' elements first and marks those behind. The guide says to close a cookie dialog with the choice that shares least.
- **A date or time field is set whole** (its value in ISO form, through the input's own setter, then input and change), not typed: Chrome types those by segments in the locale's order, which a model can't see.
- **A submit the page keeps disabled isn't clicked**: typeIn waits 1.5 s for it (some pages check on a timer), then reports the form unsent, as for a required field.
- **"Still asks" compares the field, not only its ref**: a new page numbers its refs again, so a code taken on a page whose e4 is now a link isn't asked for again. The same field under another ref (an error page that added a link above it) counts as still asked, but the agent is told to `login` again rather than the request going out with refs that now name other elements.
- **A check that a person is at the browser is never clicked or ticked by act** (by the element's own name: "Verify you are human", "I'm not a robot", captcha), and the guides send it to a takeover after `login`. A real reCAPTCHA or Turnstile is in a cross-origin frame a read doesn't see, so the guide is what covers those.
- **The read steers to `login`:** a page with a password field says to use it; one with a code field says to use it with `what`, since telling the user isn't enough. While the user is asked for something, the card comes before the read. `login what:"code"` takes the SMS or email wording from the page's text.
- **The agent isn't told each tap**, only that the tab was taken and handed back; what the user typed is hidden like a login.
- **Passkeys load into every tab, not by site:** Chrome keeps each to its rpId. Their sign count goes to every workspace's open tabs, the vault being the instance's.
- **A redraw when a passkey is made:** a CDP event isn't a step, so the tab is drawn again for the offer to show (the lean page waited for the next step).

## Check

`tests/handler.test.mts` and `tests/page.test.mts` run against the built bundle with a stand-in Puppeteer (`tests/fixtures/puppeteer`). `tests/e2e/inside.js` runs in the 1.16 image with its real Chrome, against a site it serves:

```sh
make e2e-skill SKILL=browser
```

`tools/e2e-skill` starts a throwaway 1.16 on fresh storage, waits for "Primary server", installs the built skill with `install --skills browser`, runs `inside.js` in the container and removes both.

On 2026-10-16 it printed ok: open, read and act; act refusing a password field; a login asked for on the tab's page, sealed, typed into the real Chrome, signed in and saved; search and look; the fence refusing a private address. With the takeover and passkeys, the same day: a tab taken over, a field tapped, a login typed (the password sealed) and sent with Enter, offered and saved, handed back; a passkey the agent's click made taken out again, one the user's tap made offered and saved, then signing in from another tab twice (the site checking the signature and the count going up), and refused once deleted. Twice on fresh storage. After the browser lab's run (`docs/.scratch/lab-run-2026-10-16.md`), also: a saved login typed into fields in a shadow root and sent; a password field still read as one after "Show password", and act refusing it; a login left unsent while the form needs another required field, naming it; a new account's password typed into Password and Confirm. After the eval's DeepSeek run, also: a saved login refused behind an inert cookie dialog (the dialog's buttons named, and listed first in the read), then typed once it was closed; a date set whole and a wrong format refused, the page's Next enabling; a code typed into a new page asked for again only while the same field is there. It needs fresh storage, which `make e2e-skill` gives it: a folder left from an earlier run has tabs whose pages are gone.
