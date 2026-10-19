// An .html file imported as its text (the Vault's page, vault-page.mts): esbuild inlines it
// (build.mjs), so a skill's bundle reads no file.
declare module "*.html" {
  const text: string;
  export default text;
}
