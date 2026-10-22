// The pages' colours: every page carries the same house token block (the design canvas's lite.css),
// which follows the device's light or dark and high contrast, and ?theme forces light or dark. A
// page that drifted from the others, or set dark colours of its own, would show it only in one theme.
// Sizes follow the canvas's desktop boards: one density block, touch sizes unless the pointer is fine.

import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PAGES = ["./vault.html", "../skills/apps/static/pages/manager.html", "../skills/browser/static/pages/tab.html", "../skills/library/static/pages/library.html"];
const read = (page: string): string => fs.readFileSync(fileURLToPath(new URL(page, import.meta.url)), "utf8");
// A marked block of a page's CSS: from "/* <name>:" to "/* end of <name> */".
const block = (name: string) => (html: string): string => new RegExp(`/\\* ${name}:[\\s\\S]*?/\\* end of ${name} \\*/`).exec(html)?.[0] ?? "";
const tokens = block("house tokens");
const density = block("density");
const vault = read(PAGES[0]);
const first = tokens(vault);
const firstDensity = density(vault);

test("the house token block: light and dark in one list each, forced by data-theme, with high contrast", () => {
  assert.match(first, /--bg:light-dark\(/);
  assert.match(first, /:root\[data-theme="light"\]\{color-scheme:light\}/);
  assert.match(first, /:root\[data-theme="dark"\]\{color-scheme:dark\}/);
  const device = /@media \(prefers-contrast: more\)\{:root:not\(\[data-contrast="off"\]\)\{([^}]*)\}\}/.exec(first)?.[1];
  const chosen = /:root\[data-contrast="more"\]\{([^}]*)\}/.exec(first)?.[1];
  assert.ok(device, "high contrast follows the device");
  assert.equal(chosen, device, "data-contrast=more is the same high contrast");
});

test("the density block: pointer sizes only where a mouse or trackpad is the only pointer", () => {
  assert.match(firstDensity, /\(pointer:fine\) and \(hover:hover\) and \(not \(any-pointer:coarse\)\)\{:root\{--ctl:/);
});

for (const page of PAGES) {
  test(`${page.split("/").pop()}: ?theme sets the theme, and its colours are the house tokens, as every page's`, () => {
    const html = read(page);
    assert.match(html, /document\.documentElement\.dataset\.theme = theme/, "the page reads ?theme");
    assert.equal(tokens(html), first, "the same token block as vault.html");
    assert.doesNotMatch(html, /prefers-color-scheme/, "no dark colours of its own: light-dark() in the tokens");
  });

  test(`${page.split("/").pop()}: its controls take the density block’s sizes, and hover only tints where there is hover`, () => {
    const html = read(page);
    assert.equal(density(html), firstDensity, "the same density block as vault.html");
    const own = html.slice(html.indexOf("/* end of density */"), html.indexOf("</style>"));
    assert.ok(own.startsWith("/* end of density */") && own.length > 20, "the page's own styles follow the density block");
    assert.doesNotMatch(own, /min-height:44px/, "controls sized from --ctl, not the fixed touch size");
    assert.doesNotMatch(own.replace(/@media \(hover:hover\)\{[^{}]*\{[^}]*\}\}/g, ""), /:hover/, "every :hover inside @media (hover:hover)");
  });

  test(`${page.split("/").pop()}: its words take the curly apostrophe (can’t, page’s), as the canvas has them`, () => {
    const words = read(page).replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|\/\/[^\n]*/g, ""); // comments are code's, not the page's
    assert.deepEqual(words.match(/[A-Za-z]'[A-Za-z]+/g) ?? [], []);
  });
}
