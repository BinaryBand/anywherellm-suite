// What the agent may do with the library, decided in one place: saving a function, running one, and
// each request, a function's or the agent's own (request.ts; fn null), and each command a function
// runs on a target (runs.ts). For now everything is
// allowed (the user is testing it); approval of new or changed code (this.super.requestToolApproval),
// and keys that only read until the user says otherwise, go here, and a refusal is a LibraryError
// with what to tell the user.

export type Op =
  | { op: "save"; fn: string; source: string }
  | { op: "run"; fn: string; trigger: "chat" | "job" }
  | { op: "http"; fn: string | null; method: string; url: string; key: string | null }
  | { op: "ssh"; fn: string; target: string; command: string };

export function check(_op: Op): void {}
