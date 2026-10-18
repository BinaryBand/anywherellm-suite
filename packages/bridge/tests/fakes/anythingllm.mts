// A stand-in for AnythingLLM's APIs, on a port of its own: the internal API's login
// (`POST /api/request-token`: logins hand out tok-1, tok-2, ...) and its routes, the developer
// API's key check (`GET /api/v1/auth`) and the browser extension's (`GET /api/browser-extension/check`).

import http from "node:http";
import consumers from "node:stream/consumers";
import { close, listen } from "./net.mts";

interface Call {
  method: string;
  url: string;
  body: unknown;
  token: string;
}

export class FakeAnythingLLM {
  password = "pw";
  keys = new Set(["good-key"]);
  /** The browser-extension keys it takes. */
  extensionKeys = new Set(["brx-good"]);
  /** Tokens that get a 401. */
  expired = new Set<string>();
  /** Replies by `METHOD /path?query` (under /api); anything else is 200 {"ok": true}. */
  replies = new Map<string, { status?: number; json: unknown }>();
  /** `METHOD /path` routes that are never answered; `dropped` lists the ones whose caller gave up. */
  hold = new Set<string>();
  dropped: string[] = [];
  calls: Call[] = [];
  logins = 0;
  keyChecks = 0;
  readonly server: http.Server;
  url = "";

  constructor() {
    this.server = http.createServer(async (req, res) => {
      const text = await consumers.text(req);
      const body = text ? JSON.parse(text) : null;
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(json === undefined ? "" : JSON.stringify(json));
      };
      const url = req.url ?? "";
      if (url === "/api/request-token") {
        if (body?.password !== this.password) return reply(200, { valid: false, token: null, message: "[003] Invalid password" });
        this.logins++;
        return reply(200, { valid: true, token: `tok-${this.logins}` });
      }
      if (url === "/api/v1/auth") {
        this.keyChecks++;
        return this.keys.has(token) ? reply(200, { authenticated: true }) : reply(403, { error: "No valid api key found." });
      }
      if (url === "/api/browser-extension/check") return this.extensionKeys.has(token) ? reply(200, { connected: true }) : reply(403, { error: "No valid API key found." });
      if (this.expired.has(token)) return reply(401, undefined);
      const route = url.replace(/^\/api/, "");
      this.calls.push({ method: req.method ?? "", url: route, body, token });
      if (this.hold.has(`${req.method} ${route}`)) {
        res.on("close", () => this.dropped.push(`${req.method} ${route}`));
        return;
      }
      const found = this.replies.get(`${req.method} ${route}`);
      reply(found?.status ?? 200, found ? found.json : { ok: true });
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
