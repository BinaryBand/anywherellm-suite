#!/usr/bin/env node
// anywherellm-suite: `install`, `uninstall` and `health` put the control server and the skills into
// AnythingLLM's storage, and with --bridge set up the bridge (install.mts); `serve` runs the bridge;
// `pair` prints the link a phone connects with; `settings` prints the settings in use.

import fs from "node:fs";
import os from "node:os";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { invalid } from "#shared/errors";
import { Upstream } from "#shared/upstream";
import defaultAllow from "../../../contract/default-allow.txt";
import { INNER_STORAGE, type Payload, type Runtime } from "./addons.mts";
import { defaultList } from "./allow.mts";
import { health, install, uninstall, type Ctx } from "./install.mts";
import { developerKey, pairingLink } from "./pair.mts";
import { createServer } from "./server.mts";
import { fileFor, loadSettings, shown } from "./settings.mts";

/** The control server and the skills, put in by packages/build.mjs. */
declare const PAYLOAD: Payload;

const USAGE = `usage: anywherellm-suite <command>

  install [--storage DIR]        put the control server and the skills into AnythingLLM's storage
          [--runtime container|native] [--roles chat,schedule] [--skills all|none|NAME,...]
          [--page-key brx-...]   the key the skills' pages post with (Settings > Browser Extension)
          [--bridge [--no-start] [--service systemd|launchd|windows|foreground|auto]]
                                 and set up the bridge for AnywhereLLM Lite
  uninstall [--storage DIR]      take them out again, and stop the bridge
  health                         check it all; exit 1 when a check fails
  serve                          run the bridge
  pair [--url U] [--bridge U] [--apps U]
                                 print the link AnywhereLLM Lite connects with (it holds the key)
  settings                       print the settings in use

The storage is AnythingLLM Desktop's when there is one; for Docker, the folder mounted at
${INNER_STORAGE}.
`;

const ctx: Ctx = {
  home: os.homedir(),
  env: process.env,
  platform: process.platform,
  print: console.log,
  command: [process.execPath, fs.realpathSync(process.argv[1]), "serve"],
  node: process.execPath,
  defaultAllow: defaultList(defaultAllow),
  payload: PAYLOAD,
};

const OPTIONS: Record<string, ParseArgsConfig["options"]> = {
  install: {
    storage: { type: "string" },
    runtime: { type: "string" },
    roles: { type: "string" },
    skills: { type: "string" },
    "page-key": { type: "string" },
    bridge: { type: "boolean" },
    "no-start": { type: "boolean" },
    service: { type: "string" },
  },
  uninstall: { storage: { type: "string" } },
  pair: { url: { type: "string" }, bridge: { type: "string" }, apps: { type: "string" } },
};

const list = (value: unknown): string[] | undefined => (typeof value === "string" ? value.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

async function main(argv: string[]): Promise<number | void> {
  const [command, ...rest] = argv;
  const values = parseArgs({ args: rest, options: OPTIONS[command] ?? {} }).values as Record<string, string | boolean | undefined>;
  const text = (name: string) => values[name] as string | undefined;
  switch (command) {
    case "serve": {
      const settings = loadSettings(ctx);
      const server = createServer({ rules: settings.allow, upstream: Upstream.of(settings), log: console.error });
      server.on("error", (e) => {
        console.error(`anywherellm-suite: ${e.message}`);
        process.exit(1);
      });
      server.listen(settings.port, "127.0.0.1", () => console.error(`the bridge on :${settings.port}, passing ${settings.allow.length} routes`));
      for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));
      return; // runs until stopped
    }
    case "install":
      await install(ctx, {
        storage: text("storage"),
        runtime: text("runtime") as Runtime | undefined,
        roles: list(values.roles),
        skills: list(values.skills),
        pageKey: text("page-key"),
        bridge: Boolean(values.bridge),
        start: !values["no-start"],
        service: text("service"),
      });
      return 0;
    case "uninstall":
      uninstall(ctx, { storage: text("storage") });
      return 0;
    case "health":
      return (await health(ctx)) ? 0 : 1;
    case "pair": {
      const settings = loadSettings(ctx);
      const address = text("url") || settings.anythingllmPublicUrl;
      if (!address) throw invalid("no address for AnythingLLM: set ANYTHINGLLM_PUBLIC_URL or PUBLIC_HOST in the settings, or pass --url");
      const key = await developerKey(Upstream.of(settings));
      console.error(`Open this in AnywhereLLM Lite to connect to ${address}. It holds the key:`);
      console.log(pairingLink(address, key, text("bridge") || settings.publicUrl, text("apps") || settings.appsUrl));
      return 0;
    }
    case "settings":
      console.log(`# from ${fileFor(ctx)} and the environment`);
      for (const [key, value] of Object.entries(shown(loadSettings(ctx)))) console.log(`${key}=${value}`);
      return 0;
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
