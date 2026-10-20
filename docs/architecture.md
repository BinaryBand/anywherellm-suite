# Architecture

```mermaid
flowchart LR
    cli["anywherellm-suite install"] -. "writes into the storage" .-> storage
    subgraph host["the machine that hosts AnythingLLM"]
        subgraph allm["AnythingLLM :3001 (a container, or Desktop)"]
            storage["storage: plugins/agent-skills/, anywherellm-suite/page-key"]
            skills["packages/skills (library, browser, notebook, apps)"]
        end
    end
```

- **Nothing of the suite runs beside AnythingLLM.** `install` writes the skills into AnythingLLM's storage folder, and AnythingLLM loads them into its own process. The same files work for a container and for Desktop.
- **Who holds which secret:** AnythingLLM's password (`AUTH_TOKEN`) stays with AnythingLLM, and no skill reads it. The skills' pages post with a browser-extension key (`install --page-key`), kept in the storage.
- **The phone app's bridge** (AnywhereLLM Lite) and **the control server** (the agent's chat and scheduled-job tools) are a separate repository, anywherellm-bridge, with its own install.
