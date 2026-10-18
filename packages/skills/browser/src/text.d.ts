// The skill's static/ folder as text, by path ({ "guide/index.md": "...", ... }), inlined by build.mjs.
declare const STATIC_FILES: Record<string, string>;

// The versions of the packages the skill bundles, by name ({ "puppeteer-core": "24.43.1" }), inlined by build.mjs.
declare const VENDORED_VERSIONS: Record<string, string>;
