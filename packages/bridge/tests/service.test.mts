// The bridge as a service, through install, uninstall and health: systemd on Linux, launchd on
// macOS, the Task Scheduler on Windows, and foreground where none answers. Each manager's commands
// are scripted; a real bridge answers on the port the service would listen on.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { readEnv } from "#shared/envfile";
import { Upstream } from "#shared/upstream";
import { parseRules } from "../src/allow.mts";
import { health, install, uninstall, type Ctx, type Options } from "../src/install.mts";
import { createServer } from "../src/server.mts";
import { choose, parseKind, type Host, type Run } from "../src/service/index.mts";
import { plistText } from "../src/service/launchd.mts";
import { UNIT, unitFile, unitText } from "../src/service/systemd.mts";
import { csvFields, scriptText } from "../src/service/windows.mts";
import { close, listen } from "./fakes/net.mts";
import { tempDir } from "./fakes/tmp.mts";

const tmp = tempDir("service");

type Answer = { status: number | null; stdout?: string };

/** A service manager's commands: `answers` by the command and its arguments, space-joined (or a
 *  prefix of them, the longest that matches); anything else succeeds with no output. Every call is
 *  kept, as that same text. */
function manager(answers: Record<string, Answer> = {}) {
  const calls: string[] = [];
  const run: Run = (command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    const match = Object.keys(answers)
      .filter((k) => key === k || key.startsWith(`${k} `))
      .sort((a, b) => b.length - a.length)[0];
    const answer = match ? answers[match] : { status: 0 };
    return { status: answer.status, stdout: answer.stdout ?? "" };
  };
  return { calls, run };
}
const systemctl = (answers: Record<string, Answer> = {}) => manager({ "systemctl --user is-system-running": { status: 0, stdout: "running\n" }, ...answers });

let bridge: http.Server;
let port: number;
let home: string;
let storage: string;
let printed: string[];

const ctxWith = (run: Run, platform: NodeJS.Platform = "linux", env: Record<string, string> = {}): Ctx => ({
  home,
  // Its own settings file on this machine: one derived from another OS's layout would not be a path here.
  env: { BRIDGE_PORT: String(port), BRIDGE_ENV_FILE: envFile(), LOCALAPPDATA: path.join(home, "local"), ...env },
  platform,
  print: (l) => printed.push(l),
  command: ["/usr/bin/node", "/opt/my apps/anywherellm-suite.cjs", "serve"],
  node: "/usr/bin/node",
  defaultAllow: "/workspaces",
  payload: { control: "", skills: [] },
  run,
  uid: 501,
  startWait: 1,
});
const opts = (more: Partial<Options> = {}): Options => ({ storage, bridge: true, start: true, ...more });
const host = (run: Run, platform: NodeJS.Platform): Host => ({ platform, env: {}, home, run, uid: 501 });
const envFile = () => path.join(home, "bridge.env");
const settings = () => readEnv(envFile());
const DEFINITION = { command: ["/usr/bin/node", "/opt/my apps/anywherellm-suite.cjs", "serve"], envFile: "/h/bridge.env", port: 8467 };

beforeEach(async () => {
  bridge = createServer({ rules: parseRules(""), upstream: new Upstream("http://127.0.0.1:1", null), log: () => {} });
  port = await listen(bridge);
  home = fs.mkdtempSync(path.join(tmp, "home-"));
  storage = path.join(home, "storage");
  fs.mkdirSync(path.join(storage, "plugins"), { recursive: true });
  printed = [];
});
afterEach(() => close(bridge));

// --- choosing

test("each OS gets its own manager when it answers, foreground when it doesn't, and a named one always", () => {
  assert.equal(choose("", host(systemctl().run, "linux")).kind, "systemd");
  assert.equal(choose("", host(manager({ "systemctl --user is-system-running": { status: 1, stdout: "offline\n" } }).run, "linux")).kind, "foreground");
  assert.equal(choose("", host(manager().run, "darwin")).kind, "launchd");
  assert.equal(choose("", host(manager({ "launchctl print gui/501": { status: 113 } }).run, "darwin")).kind, "foreground");
  assert.equal(choose("", host(manager().run, "win32")).kind, "windows");
  assert.equal(choose("", host(manager({ schtasks: { status: null } }).run, "win32")).kind, "foreground", "no schtasks");
  assert.equal(choose("", host(manager().run, "freebsd")).kind, "foreground");
  const asked = manager({ "systemctl --user is-system-running": { status: 1 } });
  assert.equal(choose("systemd", host(asked.run, "linux")).kind, "systemd");
  assert.deepEqual(asked.calls, [], "a named manager isn't asked");
});

test("BRIDGE_SERVICE names a manager or auto", () => {
  assert.equal(parseKind(" LaunchD "), "launchd");
  assert.equal(parseKind("auto"), "");
  assert.equal(parseKind(undefined), "");
  assert.throws(() => parseKind("cron"), /BRIDGE_SERVICE is one of systemd, launchd, windows, foreground or auto/);
});

test("--service is saved, auto takes it out, and a bad one is refused", async () => {
  await install(ctxWith(manager().run), opts({ service: "foreground" }));
  assert.equal(settings().BRIDGE_SERVICE, "foreground");
  assert.match(printed.join("\n"), /BRIDGE_SERVICE is foreground. Run `anywherellm-suite serve`/);
  await install(ctxWith(systemctl().run), opts({ service: "auto" }));
  assert.equal(settings().BRIDGE_SERVICE, undefined);
  await assert.rejects(install(ctxWith(systemctl().run), opts({ service: "cron" })), /BRIDGE_SERVICE is one of/);
});

// --- systemd

test("systemd: install writes the unit, then reloads, enables and restarts, in that order", async () => {
  const sc = systemctl();
  const ctx = ctxWith(sc.run);
  await install(ctx, opts());
  const file = unitFile({ platform: "linux", env: ctx.env, home });
  assert.equal(fs.readFileSync(file, "utf8"), unitText({ command: ctx.command, envFile: envFile(), port }));
  assert.deepEqual(sc.calls, ["systemctl --user is-system-running", "systemctl --user daemon-reload", `systemctl --user enable ${UNIT}`, `systemctl --user restart ${UNIT}`]);
  assert.ok(printed.includes(`wrote the bridge's service: ${UNIT}`));
});

test("systemd: the unit is in XDG_CONFIG_HOME when it is set", () => {
  assert.equal(unitFile({ platform: "linux", env: { XDG_CONFIG_HOME: "/c" }, home: "/h" }), "/c/systemd/user/anywherellm-bridge.service");
  assert.equal(unitFile({ platform: "linux", env: {}, home: "/h" }), "/h/.config/systemd/user/anywherellm-bridge.service");
});

test("systemd: the unit runs the command with the settings file as its environment", () => {
  const text = unitText(DEFINITION);
  assert.match(text, /^EnvironmentFile=\/h\/bridge\.env$/m);
  assert.match(text, /^ExecStart=\/usr\/bin\/node "\/opt\/my apps\/anywherellm-suite\.cjs" serve$/m);
  assert.match(text, /^WantedBy=default\.target$/m);
});

test("systemd: a second install with the same unit restarts without reloading", async () => {
  await install(ctxWith(systemctl().run), opts());
  const sc = systemctl();
  await install(ctxWith(sc.run), opts());
  assert.deepEqual(sc.calls, ["systemctl --user is-system-running", `systemctl --user enable ${UNIT}`, `systemctl --user restart ${UNIT}`]);
});

test("systemd: a restart it refuses is an error that points at the journal", async () => {
  await assert.rejects(install(ctxWith(systemctl({ [`systemctl --user restart ${UNIT}`]: { status: 1 } }).run), opts()), /systemctl restart .* failed; see `journalctl --user -u anywherellm-bridge\.service`/);
});

test("a started bridge that never answers is an error that says where its log is", async () => {
  await assert.rejects(install(ctxWith(systemctl().run, "linux", { BRIDGE_PORT: "1" }), opts()), { status: 400, message: /the bridge didn't answer; see `journalctl --user -u/ });
});

test("with no service manager install writes nothing and says to run serve yourself", async () => {
  const sc = systemctl({ "systemctl --user is-system-running": { status: 1, stdout: "" } });
  await install(ctxWith(sc.run), opts());
  assert.ok(!fs.existsSync(unitFile({ platform: "linux", env: {}, home })));
  assert.deepEqual(sc.calls, ["systemctl --user is-system-running"]);
  assert.match(printed.join("\n"), /no service manager the bridge drives.*serve.*own supervisor/s);
});

test("systemd: uninstall stops a service it defined, and only that, whatever state the manager is in", async () => {
  await install(ctxWith(systemctl().run), opts());
  printed.length = 0;
  const sc = manager({ "systemctl --user is-system-running": { status: 1, stdout: "stopping\n" } });
  uninstall(ctxWith(sc.run));
  assert.deepEqual(sc.calls, [`systemctl --user disable --now ${UNIT}`]);
  assert.ok(printed.includes("Stopped the bridge."), printed.join("\n"));
  assert.equal(settings().ANYTHINGLLM_STORAGE, undefined);

  fs.rmSync(unitFile({ platform: "linux", env: {}, home }));
  const none = systemctl();
  uninstall(ctxWith(none.run));
  assert.ok(!none.calls.some((c) => c.includes("disable")));
});

test("systemd: uninstall says so when it would not stop the service", async () => {
  await install(ctxWith(systemctl().run), opts());
  printed.length = 0;
  uninstall(ctxWith(systemctl({ [`systemctl --user disable --now ${UNIT}`]: { status: 1 } }).run));
  assert.match(printed.join("\n"), /anywherellm-bridge\.service would not stop: stop the bridge yourself/);
});

test("systemd: the user manager is usable while it is running, degraded or starting, and not otherwise", () => {
  const says = (stdout: string) => choose("", host(() => ({ status: stdout ? 0 : 1, stdout: `${stdout}\n` }), "linux")).kind === "systemd";
  for (const state of ["running", "degraded", "starting"]) assert.ok(says(state), state);
  for (const state of ["initializing", "maintenance", "stopping", "offline", "unknown", ""]) assert.ok(!says(state), JSON.stringify(state));
});

test("health shows the service's state, and fails when it is not active", async () => {
  await install(ctxWith(systemctl().run), opts());
  printed.length = 0;
  await health(ctxWith(systemctl({ [`systemctl --user is-active ${UNIT}`]: { status: 0, stdout: "active\n" } }).run));
  assert.ok(printed.includes(`ok   ${UNIT}: active`), printed.join("\n"));
  printed.length = 0;
  assert.equal(await health(ctxWith(systemctl({ [`systemctl --user is-active ${UNIT}`]: { status: 3, stdout: "failed\n" } }).run)), false);
  assert.ok(printed.includes(`FAIL ${UNIT}: failed`), printed.join("\n"));
});

// --- launchd

const plist = () => path.posix.join(home, "Library", "LaunchAgents", "local.anywherellm-bridge.plist");

test("launchd: install writes the agent, then enables, boots out and bootstraps it in the GUI domain", async () => {
  const lc = manager();
  const ctx = ctxWith(lc.run, "darwin");
  await install(ctx, opts());
  const log = path.posix.join(home, "Library", "Logs", "anywherellm-bridge.log");
  assert.equal(fs.readFileSync(plist(), "utf8"), plistText({ command: ctx.command, envFile: envFile(), port }, log));
  assert.deepEqual(lc.calls, [
    "launchctl print gui/501",
    "launchctl enable gui/501/local.anywherellm-bridge",
    "launchctl bootout gui/501/local.anywherellm-bridge",
    `launchctl bootstrap gui/501 ${plist()}`,
  ]);
  assert.ok(fs.existsSync(path.dirname(log)), "the log's folder is made");
});

test("launchd: the agent runs the command, keeps it alive after a crash, and logs to one file", () => {
  const text = plistText({ ...DEFINITION, command: ["/usr/local/bin/node", "/opt/a&b/anywherellm-suite.cjs", "serve"] }, "/Users/u/Library/Logs/anywherellm-bridge.log");
  assert.match(text, /<key>Label<\/key><string>local\.anywherellm-bridge<\/string>/);
  assert.match(text, /<array>\n {4}<string>\/usr\/local\/bin\/node<\/string>\n {4}<string>\/opt\/a&amp;b\/anywherellm-suite\.cjs<\/string>\n {4}<string>serve<\/string>\n {2}<\/array>/);
  assert.match(text, /<key>BRIDGE_ENV_FILE<\/key><string>\/h\/bridge\.env<\/string>/);
  assert.match(text, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(text, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(text, /<key>StandardErrorPath<\/key><string>\/Users\/u\/Library\/Logs\/anywherellm-bridge\.log<\/string>/);
});

test("launchd: a refused bootstrap is an error that says where the log is", async () => {
  await assert.rejects(install(ctxWith(manager({ "launchctl bootstrap": { status: 5 } }).run, "darwin"), opts()), /launchctl bootstrap gui\/501 .* failed; see .*anywherellm-bridge\.log/);
});

test("launchd: it is active while launchctl says it runs; uninstall boots it out and disables it", async () => {
  await install(ctxWith(manager().run, "darwin"), opts());
  printed.length = 0;
  await health(ctxWith(manager({ "launchctl print gui/501/local.anywherellm-bridge": { status: 0, stdout: "gui/501/local.anywherellm-bridge = {\n\tstate = running\n}" } }).run, "darwin"));
  assert.ok(printed.includes("ok   local.anywherellm-bridge: active"), printed.join("\n"));
  printed.length = 0;
  await health(ctxWith(manager({ "launchctl print gui/501/local.anywherellm-bridge": { status: 0, stdout: "\tstate = waiting\n" } }).run, "darwin"));
  assert.ok(printed.includes("FAIL local.anywherellm-bridge: inactive"), printed.join("\n"));
  const lc = manager();
  uninstall(ctxWith(lc.run, "darwin"));
  assert.deepEqual(lc.calls, ["launchctl bootout gui/501/local.anywherellm-bridge", "launchctl disable gui/501/local.anywherellm-bridge"]);
});

// --- the Task Scheduler

const local = () => path.join(home, "local", "anywherellm-bridge");

test("windows: install writes serve.cmd and a logon task that runs it with no window, then runs it", async () => {
  const st = manager({ "schtasks /Query /TN anywherellm-bridge": { status: 1 } });
  const ctx = ctxWith(st.run, "win32");
  await install(ctx, opts());
  const script = path.join(local(), "serve.cmd");
  assert.equal(fs.readFileSync(script, "utf8"), scriptText({ command: ctx.command, envFile: envFile(), port }, path.join(local(), "bridge.log")));
  assert.deepEqual(st.calls, [
    "schtasks /Query /FO CSV /NH",
    `schtasks /Create /TN anywherellm-bridge /TR conhost.exe --headless cmd.exe /d /c "${script}" /SC ONLOGON /F`,
    "schtasks /Change /TN anywherellm-bridge /ENABLE",
    "schtasks /End /TN anywherellm-bridge",
    "schtasks /Run /TN anywherellm-bridge",
  ]);
});

test("windows: serve.cmd quotes each word, doubles %, and refuses a double quote", () => {
  const text = scriptText({ command: ["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\a b\\100%\\anywherellm-suite.cjs", "serve"], envFile: "C:\\Users\\a b\\bridge.env", port: 1 }, "C:\\log.txt");
  assert.deepEqual(text.split("\r\n").slice(2), [
    'set "BRIDGE_ENV_FILE=C:\\Users\\a b\\bridge.env"',
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a b\\100%%\\anywherellm-suite.cjs" "serve" >> "C:\\log.txt" 2>&1',
    "",
  ]);
  assert.throws(() => scriptText({ ...DEFINITION, envFile: 'C:\\a"b' }, "C:\\l"), /double quote/);
});

test("windows: a second install with the same script and task creates nothing", async () => {
  await install(ctxWith(manager({ "schtasks /Query /TN anywherellm-bridge": { status: 1 } }).run, "win32"), opts());
  const st = manager();
  await install(ctxWith(st.run, "win32"), opts());
  assert.ok(!st.calls.some((c) => c.includes("/Create")), st.calls.join("\n"));
});

test("windows: running is read from the status or the last result, in any language", async () => {
  const row = (status: string, result: string) => `"HOST","\\anywherellm-bridge","N/A","${status}","Interactive only","10/15/2026 9:00:00 AM","${result}","me"`;
  assert.deepEqual(csvFields(row("Running", "267009")).slice(3, 7), ["Running", "Interactive only", "10/15/2026 9:00:00 AM", "267009"]);
  await install(ctxWith(manager({ "schtasks /Query /TN anywherellm-bridge": { status: 1 } }).run, "win32"), opts());
  for (const [status, result, word] of [
    ["Running", "0", "active"],
    ["Wird ausgeführt", "267009", "active"],
    ["Ready", "0", "ready"],
    ["Disabled", "1", "disabled"],
  ]) {
    const st = manager({ "schtasks /Query /TN anywherellm-bridge /V": { status: 0, stdout: `${row(status, result)}\r\n` } });
    printed.length = 0;
    await health(ctxWith(st.run, "win32"));
    assert.ok(printed.some((l) => l.endsWith(`task anywherellm-bridge: ${word}`)), `${status}: ${printed.join("\n")}`);
  }
});

test("windows: uninstall ends the task and disables it", async () => {
  await install(ctxWith(manager({ "schtasks /Query /TN anywherellm-bridge": { status: 1 } }).run, "win32"), opts());
  printed.length = 0;
  const st = manager();
  uninstall(ctxWith(st.run, "win32"));
  assert.deepEqual(st.calls, ["schtasks /Query /TN anywherellm-bridge", "schtasks /End /TN anywherellm-bridge", "schtasks /Change /TN anywherellm-bridge /DISABLE"]);
  assert.ok(printed.includes("Stopped the bridge."));
});
