// A stand-in for AnythingLLM on a port of its own: the browser extension's key check
// (`GET /api/browser-extension/check`), the one call the installer makes. Any other request is
// counted and gets a 404.

import http from "node:http";
import { close, listen } from "#shared/test-helpers";

export class FakeAnythingLLM {
  /** The browser-extension keys it takes. */
  extensionKeys = new Set(["brx-good"]);
  /** Requests other than the key check. */
  requests = 0;
  readonly server: http.Server;
  url = "";

  constructor() {
    this.server = http.createServer((req, res) => {
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      };
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (req.url === "/api/browser-extension/check") return this.extensionKeys.has(token) ? reply(200, { connected: true }) : reply(403, { error: "No valid API key found." });
      this.requests++;
      reply(404, { error: "not a route the fake knows" });
    });
  }

  async start(): Promise<this> {
    this.url = `http://127.0.0.1:${await listen(this.server)}`;
    return this;
  }

  async stop(): Promise<void> {
    await close(this.server);
  }
}
