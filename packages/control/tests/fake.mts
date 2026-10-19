// AnythingLLM's internal API in memory: its status and JSON (null for the plain text some routes
// send), shaped by reading AnythingLLM 1.16.2 (anywherellm-bridge's contract/endpoints.md). The
// unit tests call it through the real Anything client; `serve` puts it behind HTTP, with the
// login, for the stdio test.

import http from "node:http";
import type { AddressInfo } from "node:net";
import consumers from "node:stream/consumers";
import { Anything, items, obj, text, type Obj } from "../src/anything.mts";

type Reply = { status: number; json: unknown };
const NOT_FOUND: Reply = { status: 404, json: null };
const refused: Reply = { status: 403, json: { error: "not a route the fake knows" } };

/** Five fields, and a minute past 59 is wrong: enough for a refusal in AnythingLLM's words. */
const validCron = (schedule: string): boolean => {
  const fields = schedule.split(/\s+/).filter(Boolean);
  return fields.length === 5 && fields.every((f) => /^[0-9*/,?#A-Za-z-]+$/.test(f)) && !(/^\d+$/.test(fields[0]) && Number(fields[0]) > 59);
};

/** AnythingLLM's catalog of what a scheduled job can use (models/scheduledJob.js availableTools). */
const TOOL_CATALOG = [
  { name: "Default Skills", items: [{ id: "web-scraping" }, { id: "web-browsing" }, { id: "sql-agent", requiresSetup: true }] },
  { name: "Imported Skills", items: [{ id: "@@library-lean", name: "Library" }] },
  { name: "Gmail", requiresSetup: true, items: [{ id: "gmail-send" }] },
];

export class FakeAnythingLLM {
  workspaces: Record<string, string> = { home: "Home", work: "Work" };
  /** A workspace's chats, oldest first: slug -> name. */
  threads: Record<string, Record<string, string>> = { home: { "aaa-1": "Trip planning", "bbb-2": "Thread" }, work: {} };
  /** A thread's exchanges: slug -> [chatId, question, answer][]. */
  chats: Record<string, [number, string, string][]> = {
    "aaa-1": [
      [10, "Where to?", "Lisbon."],
      [11, "When?", "In May."],
    ],
    "bbb-2": [],
  };
  jobs = new Map<number, Obj>();
  calls: [method: string, path: string, body: unknown][] = [];
  /** A delete that answers OK and does nothing. */
  ignoresDeletes = false;
  #nextJob = 1;

  constructor() {
    this.addJob("Morning news", "Summarise the news.", "30 4 * * *", ["web-browsing"]);
  }

  addJob(name: string, prompt: string, schedule: string, tools: string[] | null): number {
    const id = this.#nextJob++;
    this.jobs.set(id, { id, name, prompt, tools: tools?.length ? JSON.stringify(tools) : null, schedule, enabled: true, lastRunAt: null, nextRunAt: "2026-10-16T04:30:00.000Z", latestRun: null });
    return id;
  }

  /** The calls so far that were not reads. */
  changes(): [string, string][] {
    return this.calls.filter(([m]) => m !== "GET").map(([m, p]) => [m, p]);
  }

  /** The real client, over this fake. */
  client(): Anything {
    return new Anything(async (method, path, body) => this.answer(method, path, body));
  }

  answer(method: string, path: string, body?: unknown): Reply {
    this.calls.push([method, path, body]);
    const parts = path.replace(/^\/+|\/+$/g, "").split("/");
    if (parts[0] === "workspaces" && method === "GET") return { status: 200, json: { workspaces: Object.entries(this.workspaces).map(([slug, name]) => ({ slug, name })) } };
    if (parts[0] === "workspace" && parts.length >= 3) return this.#threadRoute(method, parts[1], parts.slice(2), obj(body));
    if (parts[0] === "scheduled-jobs") return this.#jobRoute(method, parts.slice(1), obj(body));
    return refused;
  }

  #threadRoute(method: string, workspace: string, rest: string[], body: Obj): Reply {
    if (!(workspace in this.workspaces)) return NOT_FOUND;
    const threads = this.threads[workspace];
    const at = rest.join("/");
    if (at === "threads" && method === "GET") {
      const listed = Object.entries(threads).map(([slug, name], i) => ({ id: i + 1, name, slug, lastUpdatedAt: "2026-10-15T08:00:00.000Z" }));
      return { status: 200, json: { threads: listed, defaultThreadChatCount: 0 } };
    }
    if (at === "thread/new" && method === "POST") {
      const slug = `new-${Object.keys(threads).length + 1}`;
      threads[slug] = "Thread";
      this.chats[slug] = [];
      return { status: 200, json: { thread: { slug, name: "Thread" }, message: null } };
    }
    if (rest.length < 2 || rest[0] !== "thread" || !(rest[1] in threads)) return NOT_FOUND;
    const [, slug, ...action] = rest;
    const does = action.join("/");
    if (does === "update" && method === "POST") {
      if (!("name" in body)) return { status: 200, json: { thread: { slug }, message: "No valid fields to update!" } };
      threads[slug] = text(body.name);
      return { status: 200, json: { thread: { slug, name: threads[slug] }, message: null } };
    }
    if (does === "chats" && method === "GET") {
      const history = this.chats[slug].flatMap(([chatId, q, a]) => [
        { role: "user", content: q, chatId },
        { role: "assistant", content: a, chatId },
      ]);
      return { status: 200, json: { history } };
    }
    if (does === "delete-edited-chats" && method === "DELETE") {
      const start = body.startingId;
      if (!this.ignoresDeletes && Number.isInteger(start)) this.chats[slug] = this.chats[slug].filter(([id]) => id < (start as number));
      return { status: 200, json: null }; // AnythingLLM sends the text OK
    }
    if (!does && method === "DELETE") {
      if (!this.ignoresDeletes) {
        delete threads[slug];
        delete this.chats[slug];
      }
      return { status: 200, json: null };
    }
    return refused;
  }

  #jobRoute(method: string, rest: string[], body: Obj): Reply {
    if (!rest.length && method === "GET") return { status: 200, json: { jobs: [...this.jobs.values()] } };
    if (rest.join("/") === "available-tools" && method === "GET") return { status: 200, json: { tools: TOOL_CATALOG } };
    if (rest.join("/") === "new" && method === "POST") {
      if (!validCron(text(body.schedule))) return { status: 400, json: { job: null, error: "Invalid cron expression" } };
      const tools = items(body.tools).map(text);
      const id = this.addJob(text(body.name), text(body.prompt), text(body.schedule), tools);
      return { status: 201, json: { job: this.jobs.get(id), error: null } };
    }
    if (rest.length !== 1 || !/^\d+$/.test(rest[0])) return refused;
    const id = Number(rest[0]);
    if (method === "DELETE") return { status: 200, json: { success: this.jobs.delete(id) } };
    const job = this.jobs.get(id);
    if (!job) return { status: 404, json: { job: null, error: "Job not found" } };
    if (method === "GET") return { status: 200, json: { job } };
    if (method === "PUT") {
      if ("schedule" in body && !validCron(text(body.schedule))) return { status: 400, json: { job: null, error: "Invalid cron expression" } };
      for (const k of ["name", "prompt", "schedule", "enabled"]) if (k in body) job[k] = body[k];
      if ("tools" in body) job.tools = JSON.stringify(body.tools);
      return { status: 200, json: { job, error: null } };
    }
    return refused;
  }
}

/** `fake` behind HTTP on a free port, under /api, with AnythingLLM's login: `password` gets the
 *  token `tok`, which every other call must carry. Each call's Authorization header is kept in `seen`. */
export async function serve(fake: FakeAnythingLLM, password: string, seen: string[]): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    const raw = await consumers.text(req);
    const body = raw ? JSON.parse(raw) : undefined;
    const send = ({ status, json }: Reply) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(json === null ? "OK" : JSON.stringify(json));
    };
    if (req.url === "/api/request-token") return send({ status: 200, json: body?.password === password ? { valid: true, token: "tok" } : { valid: false, token: null, message: "[003] Invalid password" } });
    seen.push(req.headers.authorization ?? "");
    if (req.headers.authorization !== "Bearer tok") return send({ status: 401, json: { error: "Invalid auth token" } });
    send(fake.answer(req.method ?? "", (req.url ?? "").replace(/^\/api/, ""), body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
