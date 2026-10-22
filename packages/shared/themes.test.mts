// The pages' look is House UI, as the design canvas draws them: every page carries the same House UI
// block (its tokens with the indigo scheme only, then its root, density and focus rules), which follows
// the device's light or dark and contrast, and ?theme forces one. A page that drifted from the others,
// set colours of its own or used a token House UI doesn't have would show it only in one theme.

import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PAGES = ["./vault.html", "../skills/apps/static/pages/manager.html", "../skills/browser/static/pages/tab.html", "../skills/library/static/pages/library.html"];
const read = (page: string): string => fs.readFileSync(fileURLToPath(new URL(page, import.meta.url)), "utf8");
const house = (html: string): string => /\/\* house ui:[\s\S]*?\/\* end of house ui \*\//.exec(html)?.[0] ?? "";
const first = house(read(PAGES[0]));
const defined = new Set(first.match(/--[a-z0-9-]+(?=:)/g));
// The page's own styles and markup: everything but the House UI block.
const own = (html: string): string => html.replace(house(html), "");
const styleOf = (html: string): string => html.slice(html.indexOf("/* end of house ui */"), html.indexOf("</style>"));

test("the House UI block: indigo, light and dark with their higher-contrast themes, density by the pointer", () => {
  assert.match(first, /--ground: var\(--indigo-ground\)/);
  assert.doesNotMatch(first, /--(blue|teal|green|amber|coral|rose|violet|graphite)-/, "the indigo scheme only");
  for (const theme of ["light", "dark", "light-hc", "dark-hc"]) assert.match(first, new RegExp(`\\[data-theme="${theme}"\\] \\{`), theme);
  assert.match(first, /@media \(prefers-contrast: more\)/);
  assert.match(first, /\[data-theme="dark"\]\[data-contrast="more"\] \{/);
  assert.match(first, /@media \(pointer: fine\) and \(hover: hover\) and \(not \(any-pointer: coarse\)\) \{\s*\.hu-root:not\(\[data-density="touch"\]\) \{\s*--control-h:/);
});

for (const page of PAGES) {
  test(`${page.split("/").pop()}: ?theme sets the theme, and its look is the House UI block, as every page’s`, () => {
    const html = read(page);
    assert.match(html, /document\.documentElement\.dataset\.theme = theme/, "the page reads ?theme");
    assert.match(html, /<body class="hu-root"/);
    assert.equal(house(html), first, "the same House UI block as vault.html");
    // The tab's screenshot, its thumbnail and the field laid over it stand for the remote page, whose white they keep.
    const styles = styleOf(html).replace(/(#shot|\.over,\.over:focus-visible|\.thumb img)\{[^}]*\}/g, "");
    assert.doesNotMatch(styles, /prefers-color-scheme|#[0-9a-f]{3,8}\b|oklch\(|rgba?\(/i, "no colours of its own");
    const used = [...own(html).matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(used.filter((t) => !defined.has(t)))], [], "only House UI’s tokens");
    assert.doesNotMatch(own(html), /min-height:44px/, "controls sized from --control-h, not the fixed touch size");
    assert.doesNotMatch(own(html).replace(/@media \(hover:hover\)\{[^{}]*\{[^}]*\}\}/g, ""), /:hover/, "every :hover inside @media (hover:hover)");
  });

  test(`${page.split("/").pop()}: its words take the curly apostrophe (can’t, page’s), as the canvas has them`, () => {
    const words = read(page).replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|\/\/[^\n]*/g, ""); // comments are code's, not the page's
    assert.deepEqual(words.match(/[A-Za-z]'[A-Za-z]+/g) ?? [], []);
  });
}
