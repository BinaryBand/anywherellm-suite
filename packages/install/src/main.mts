#!/usr/bin/env node
// anywherellm-suite: `install`, `uninstall` and `health` put the control server and the skills into
// AnythingLLM's storage, take them out and check them (install.mts).

import os from "node:os";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { INNER_STORAGE, type Payload, type Runtime } from "./addons.mts";
import { health, install, uninstall, type Ctx } from "./install.mts";

/** The control server and the skills, put in by packages/build.mjs. */
declare const PAYLOAD: Payload;

const USAGE = `usage: anywherellm-suite <command>

  install [--storage DIR]        put the control server and the skills into AnythingLLM's storage
          [--runtime container|native] [--roles chat,schedule] [--skills all|none|NAME,...]
          [--page-key brx-...]   the key the skills' pages post with (Settings > Browser Extension)
  uninstall [--storage DIR]      take them out again
  health                         check it all; exit 1 when a check fails

The storage is AnythingLLM Desktop's when there is one; for Docker, the folder mounted at
${INNER_STORAGE}.
`;

const ctx: Ctx = {
  home: os.homedir(),
  env: process.env,
  platform: process.platform,
  print: console.log,
  node: process.execPath,
  payload: PAYLOAD,
};

const OPTIONS: Record<string, ParseArgsConfig["options"]> = {
  install: {
    storage: { type: "string" },
    runtime: { type: "string" },
    roles: { type: "string" },
    skills: { type: "string" },
    "page-key": { type: "string" },
  },
  uninstall: { storage: { type: "string" } },
};

const list = (value: unknown): string[] | undefined => (typeof value === "string" ? value.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

async function main(argv: string[]): Promise<number | void> {
  const [command, ...rest] = argv;
  const values = parseArgs({ args: rest, options: OPTIONS[command] ?? {} }).values as Record<string, string | boolean | undefined>;
  const text = (name: string) => values[name] as string | undefined;
  switch (command) {
    case "install":
      await install(ctx, {
        storage: text("storage"),
        runtime: text("runtime") as Runtime | undefined,
        roles: list(values.roles),
        skills: list(values.skills),
        pageKey: text("page-key"),
      });
      return 0;
    case "uninstall":
      uninstall(ctx, { storage: text("storage") });
      return 0;
    case "health":
      return (await health(ctx)) ? 0 : 1;
    default:
      console.error(USAGE);
      return command ? 2 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== undefined) process.exit(code);
  },
  (e: unknown) => {
    console.error(`anywherellm-suite: ${(e as Error).message}`);
    process.exit(1);
  },
);
