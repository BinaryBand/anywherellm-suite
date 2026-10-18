// The skill's static/ folder as text, by path ({ "guide/index.md": "...", ... }), inlined by build.mjs.
declare const STATIC_FILES: Record<string, string>;

// The packages the skill bundles, as name@version ("a@1.2.3 b@4.5.6"), inlined by build.mjs.
declare const VENDORED_VERSIONS: string;
