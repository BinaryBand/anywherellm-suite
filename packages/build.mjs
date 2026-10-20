// Builds the JavaScript parts with esbuild. Each part becomes one file that needs nothing installed
// beside it, and the build fails (removing the output) when a bundle took in a file from outside its
// part: that is the boundary between parts, since a part cannot ship another part's code.
//
//   install src/main.mts -> install/dist/anywherellm-suite.cjs, the command people run, for Node
//           18. The extension is fixed (.cjs) so it runs the same wherever it is copied to. What
//           install puts into AnythingLLM's storage, every skill, built first, is inlined as
//           PAYLOAD. Allowed: src/ and shared/.
//   skills  each skill's src/handler.ts -> <skill>/build/<hubId>/handler.js plus plugin.json, the
//           folder AnythingLLM unpacks, for Node 18. esbuild folds src/ and shared/ (helpers both
//           parts use) into the one handler.js, which then requires only Node's own modules (and
//           AnythingLLM's, by a path built at run time). Allowed: the skill's src/ and shared/,
//           and the packages VENDORED names for it, less the modules STUBBED names. A skill's
//           static/ folder (guides, pages, snippets: what is tuned rather than coded) is inlined
//           as text, as STATIC_FILES ({ "guide/index.md": "...", ... }), so the skill still ships
//           two files, which the Hub's upload and install's text payload both need. The VENDORED
//           packages' versions are inlined as VENDORED_VERSIONS ("puppeteer-core@24.43.1 ws@8.22.0
//           ..."), for the per-process keys that keep a reloaded skill off an older copy.
//
// usage: node build.mjs [install | skills [skill ...]]   (no argument: every part)
import { build } from "esbuild";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const here = path.dirname(self);

/** The packages a skill may bundle besides its own code, by the skill's folder name. Each is a
 *  decision (docs/notes/README.md): library bundles QuickJS, the engine its functions run in.
 *  @type {Record<string, string[]>} */
const VENDORED = {
  apps: ["node_modules/fast-json-patch/", "node_modules/acorn/"],
  library: ["node_modules/quickjs-emscripten-core/", "node_modules/@jitl/quickjs-ffi-types/", "node_modules/@jitl/quickjs-singlefile-cjs-release-sync/"],
  browser: ["node_modules/puppeteer-core/", "node_modules/@puppeteer/browsers/", "node_modules/ws/", "node_modules/debug/", "node_modules/ms/", "node_modules/semver/"],
};

/** Modules a vendored package requires but the skill never runs, bundled as an empty module, by the
 *  skill's folder name; each pattern matches the path as required, a relative one made absolute.
 *  browser: Puppeteer's browser downloads (its installer and CLI, and proxy-agent for its fetches)
 *  and WebDriver BiDi (chromium-bidi), since the skill launches a Chrome it found and speaks CDP.
 *  They were three quarters of the bundle.
 *  @type {Record<string, RegExp[]>} */
const STUBBED = {
  browser: [/^proxy-agent$/, /^chromium-bidi\//, /\/@puppeteer\/browsers\/lib\/cjs\/(CLI|install)\.js$/],
};

/** An esbuild plugin that bundles each module `patterns` match as an empty one, and fails the build
 *  when a pattern matched nothing: the package moved the module, and the bundle grew without it.
 *  @param {RegExp[]} patterns
 *  @returns {import("esbuild").Plugin} */
const stubs = (patterns) => ({
  name: "stubs",
  setup(b) {
    const hit = new Set();
    b.onResolve({ filter: /.*/ }, ({ path: p, resolveDir }) => {
      const full = p.startsWith(".") ? path.join(resolveDir, p).split(path.sep).join("/") : p;
      const found = patterns.find((re) => re.test(full));
      if (!found) return undefined;
      hit.add(found);
      return { path: p, namespace: "stub" };
    });
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "module.exports = {};", loader: "js" }));
    b.onEnd((result) => {
      const unused = patterns.filter((re) => !hit.has(re));
      if (unused.length && !result.errors.length) return { errors: [{ text: `STUBBED patterns matched nothing: ${unused.join(", ")}` }] };
    });
  },
});

/** VENDORED_VERSIONS as the skill `name` (its folder) is built with: each package VENDORED names
 *  for it, as name@version from its package.json; "" with none.
 *  @param {string} name */
export const vendoredVersions = (name) =>
  (VENDORED[name] || []).map((prefix) => `${prefix.slice("node_modules/".length, -1)}@${JSON.parse(fs.readFileSync(path.join(here, prefix, "package.json"), "utf8")).version}`).join(" ");

/** Files from node_modules that a skill's pages carry (the browser can't import them), by the name
 *  they have in STATIC_FILES, for the skill's folder name.
 *  @type {Record<string, Record<string, string>>} */
const PAGE_LIBRARIES = { apps: { "fast-json-patch.js": "node_modules/fast-json-patch/dist/fast-json-patch.min.js" } };

/** The text of every file under `dir` (a skill's static/), by its path there with forward slashes,
 *  and the skill's PAGE_LIBRARIES; {} with no `dir`.
 *  @param {string} dir
 *  @param {string} [skill] the skill's folder name, for its PAGE_LIBRARIES
 *  @returns {Record<string, string>} */
export function staticFiles(dir, skill = "") {
  if (!fs.existsSync(dir)) return {};
  const names = fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
  const read = (/** @type {string} */ file) => fs.readFileSync(file, "utf8");
  return Object.fromEntries([
    ...names.map((name) => [name, read(path.join(dir, name))]),
    ...Object.entries(PAGE_LIBRARIES[skill] || {}).map(([name, from]) => [name, read(path.join(here, from))]),
  ]);
}

/** The shared code's sources, hashed: inlined as SHARED_STAMP, so perBuild's caches change with
 *  them and a build of the same code bundles the same bytes. */
function sharedStamp() {
  const dir = path.join(here, "shared");
  const hash = crypto.createHash("sha256");
  for (const name of fs.readdirSync(dir).filter((n) => /\.(mts|html)$/.test(n) && !n.endsWith(".test.mts")).sort()) hash.update(name).update(fs.readFileSync(path.join(dir, name)));
  return hash.digest("hex").slice(0, 16);
}

/**
 * Bundles `entry` into `outfile`; `allowed` are path prefixes relative to `cwd`, as esbuild's
 * metafile writes them. `clean` is what to remove if the bundle took in anything else. Answers the
 * files it took in, as the metafile names them.
 * @param {{ entry: string, outfile: string, target: string, allowed: string[], label: string,
 *   define?: Record<string, string>, loader?: Record<string, "text">, clean?: string, cwd?: string,
 *   plugins?: import("esbuild").Plugin[] }} options
 */
export async function bundle({ entry, outfile, target, define, loader, allowed, label, clean = outfile, cwd = here, plugins }) {
  define = { SHARED_STAMP: JSON.stringify(sharedStamp()), ...define };
  const { metafile } = await build({
    absWorkingDir: cwd,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    target,
    format: "cjs",
    define,
    loader,
    metafile: true,
    logLevel: "warning",
    plugins,
  });
  // `<define:NAME>` is a `define` value esbuild lists as an input, and `stub:path` a module stubs()
  // bundled empty; neither is a file. (Any other `name:` could be one, such as a Windows drive's.)
  const stray = Object.keys(metafile.inputs).filter((file) => !/^(<define:|stub:)/.test(file) && !allowed.some((prefix) => file.startsWith(prefix)));
  if (stray.length) {
    fs.rmSync(clean, { recursive: true, force: true });
    throw new Error(`${label} bundles files outside ${allowed.join(", ")}: ${stray.join(", ")}`);
  }
  return Object.keys(metafile.inputs);
}

/** What install puts into the storage (install/src/addons.mts's Payload): every skill, built first. */
async function payload() {
  const skills = (await buildSkills([])).map(({ name, hubId, out, pages }) => ({
    name,
    hubId,
    pages,
    files: Object.fromEntries(fs.readdirSync(out).map((file) => [file, fs.readFileSync(path.join(out, file), "utf8")])),
  }));
  return { skills };
}

async function buildInstall() {
  const define = { PAYLOAD: JSON.stringify(await payload()) };
  const outfile = path.join(here, "install", "dist", "anywherellm-suite.cjs");
  await bundle({ entry: "install/src/main.mts", outfile, target: "node18", define, allowed: ["install/src/", "shared/"], label: "the installer" });
  fs.chmodSync(outfile, 0o755);
  console.log(`built install -> ${path.relative(here, outfile)}`);
}

/** The skills: the folders of packages/skills with a src/handler.ts. */
const skillNames = () => fs.readdirSync(path.join(here, "skills")).filter((name) => fs.existsSync(path.join(here, "skills", name, "src", "handler.ts")));

/** Builds the skills `names` (none: every one); each one's name, hubId, output folder, and whether
 *  it has pages (bundles shared/pages, so they post with the pages' key).
 *  @param {string[]} names */
async function buildSkills(names) {
  const built = [];
  for (const name of names.length ? names : skillNames()) {
    const dir = path.join(here, "skills", name);
    const { hubId, entrypoint } = JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf8"));
    const out = path.join(dir, "build", hubId);
    fs.rmSync(out, { recursive: true, force: true });
    const inputs = await bundle({
      entry: path.join(dir, "src", "handler.ts"),
      outfile: path.join(out, entrypoint.file),
      target: "node18",
      define: { STATIC_FILES: JSON.stringify(staticFiles(path.join(dir, "static"), name)), VENDORED_VERSIONS: JSON.stringify(vendoredVersions(name)) },
      loader: { ".html": "text" }, // shared/vault.html, the Vault's page, which each skill that keeps secrets serves
      allowed: [`skills/${name}/src/`, "shared/", ...(VENDORED[name] || [])],
      label: name,
      clean: out,
      plugins: STUBBED[name] ? [stubs(STUBBED[name])] : undefined,
    });
    fs.copyFileSync(path.join(dir, "plugin.json"), path.join(out, "plugin.json"));
    console.log(`built ${name} -> ${path.relative(here, out)}`);
    built.push({ name, hubId, out, pages: inputs.includes("shared/pages.mts") });
  }
  return built;
}

if (process.argv[1] === self) {
  const [part, ...names] = process.argv.slice(2);
  if (part && !["install", "skills"].includes(part)) throw new Error(`usage: node build.mjs [install | skills [skill ...]], not ${part}`);
  if (!part || part === "install") await buildInstall(); // builds the skills first
  else await buildSkills(names);
}
