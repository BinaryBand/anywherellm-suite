// The pages' two dark palettes: each page writes its dark colours once for the device's setting
// (@media prefers-color-scheme) and once for ?theme=dark (:root[data-theme="dark"]). An edit to one
// copy and not the other shows only under one of them, so the copies are checked here.

import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PAGES = ["./vault.html", "../skills/apps/static/pages/manager.html", "../skills/browser/static/pages/tab.html", "../skills/library/static/pages/library.html"];
const read = (page: string): string => fs.readFileSync(fileURLToPath(new URL(page, import.meta.url)), "utf8");
/** A block's declarations, one each, whatever the spacing. */
const decls = (body: string): string[] => body.split(";").map((d) => d.trim().replace(/\s*:\s*/, ":")).filter(Boolean);

for (const page of PAGES) {
  test(`${page.split("/").pop()}: ?theme sets the theme, and its dark colours are the same for the device's dark and ?theme=dark`, () => {
    const html = read(page);
    assert.match(html, /document\.documentElement\.dataset\.theme = theme/, "the page reads ?theme");
    const device = [...html.matchAll(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}\s*\}/g)].map((m) => decls(m[1]));
    const chosen = [...html.matchAll(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/g)].map((m) => decls(m[1]));
    assert.equal((html.match(/prefers-color-scheme/g) || []).length, device.length, "every dark rule gives way to ?theme=light");
    assert.ok(device.length >= 1);
    assert.deepEqual(chosen, device);
  });
}
