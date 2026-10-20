# contract

What the parts agree on. No build, no version of its own.

| File | Holds | Read by |
| --- | --- | --- |
| `versions.env` | the AnythingLLM image under test, its inner port and storage folder | `tools/lib.sh`; the test lab |
| `browser-tab.md` | what the browser skill publishes about a chat's tab: the card in the agent's reply, the tab's state file and the events that answer its requests | AnywhereLLM Lite; the browser skill's tests check the state's fields |
| `fence-lean.md` | the asks a skill makes when the fence refuses an origin in a chat, the status line that names them, and the origins let through for good | anywherellm-bridge; AnywhereLLM Lite |

The bridge's default allowlist and the notes on AnythingLLM's internal routes (`endpoints.md`) moved with the bridge to anywherellm-bridge.
