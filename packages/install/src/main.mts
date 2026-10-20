#!/usr/bin/env node
// anywherellm-suite: `install`, `uninstall` and `health` put the skills into AnythingLLM's
// storage, take them out and check them (install.mts).

import os from "node:os";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { INNER_STORAGE, type Payload } from "./addons.mts";
import { health, install, uninstall, type Ctx } from "./install.mts";
import { pages } from "./pages.mts";

/** The skills, put in by packages/build.mjs. */
declare const PAYLOAD: Payload;

const USAGE = `usage: anywherellm-suite <command>

  install [--storage DIR]        put the skills into AnythingLLM's storage
          [--skills all|none|NAME,...]
          [--page-key brx-...]   the key the skills' pages post with (Settings > Browser Extension)
  uninstall [--storage DIR]      take them out again
  health [--storage DIR]         check it all; exit 1 when a check fails
  pages [--storage DIR]          show where to open the Library page and the Vault
        [--hide | --show]        keep their links from the agent, or give them back

The storage is AnythingLLM Desktop's when there is one; for Docker, the folder mounted at
${INNER_STORAGE}.
`;

const ctx: Ctx = {
  home: os.homedir(),
  env: process.env,
  platform: process.platform,
  print: console.log,
  payload: PAYLOAD,
};

const OPTIONS: Record<string, ParseArgsConfig["options"]> = {
  install: {
    storage: { type: "string" },
    skills: { type: "string" },
    "page-key": { type: "string" },
  },
  uninstall: { storage: { type: "string" } },
  health: { storage: { type: "string" } },
  pages: { storage: { type: "string" }, hide: { type: "boolean" }, show: { type: "boolean" } },
};

const list = (value: unknown): string[] | undefined => (typeof value === "string" ? value.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const values = parseArgs({ args: rest, options: OPTIONS[command] ?? {} }).values as Record<string, string | boolean | undefined>;
  const text = (name: string) => values[name] as string | undefined;
  switch (command) {
    case "install":
      await install(ctx, {
        storage: text("storage"),
        skills: list(values.skills),
        pageKey: text("page-key"),
      });
      return 0;
    case "uninstall":
      uninstall(ctx, { storage: text("storage") });
      return 0;
    case "health":
      return (await health(ctx, { storage: text("storage") })) ? 0 : 1;
    case "pages":
      return pages(ctx, { storage: text("storage"), hide: values.hide === true, show: values.show === true });
    default:
      console.error(USAGE);
      return command ? 2 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`anywherellm-suite: ${(e as Error).message}`);
    process.exit(1);
  },
);
