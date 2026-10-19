// JSON Patch (RFC 6902, by fast-json-patch) and JSON Pointer (RFC 6901) on plain JSON values. apply()
// never changes its input: it answers the patched copy, or throws a PatchError naming the operation
// that failed. The page's apply (static/app.js) is the same library worded the same way.

import jsonpatch from "fast-json-patch";

/** A JSON value as the skill handles it: data, schemas and app files, read from JSON and checked by
 *  the schema at run time rather than by types. */
export type Json = any;

export class PatchError extends Error {}

export const clone = <T,>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

/** The pointer's reference tokens: "" is the whole document. */
function tokens(pointer: string): string[] {
  if (pointer === "") return [];
  if (typeof pointer !== "string" || !pointer.startsWith("/")) throw new PatchError(`not a JSON pointer: ${JSON.stringify(pointer)}`);
  return pointer.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

const isIndex = (token: string): boolean => /^(0|[1-9][0-9]*)$/.test(token);

/** The value the pointer names, or undefined when there is none. */
export function get(doc: Json, pointer: string): Json {
  let here = doc;
  for (const t of tokens(pointer)) {
    if (Array.isArray(here)) {
      if (!isIndex(t) || Number(t) >= here.length) return undefined;
      here = here[Number(t)];
    } else if (here !== null && typeof here === "object") {
      if (!Object.hasOwn(here, t)) return undefined;
      here = here[t];
    } else return undefined;
  }
  return here;
}

export function equal(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]));
}

/** Why the library can't be left to refuse `o`: it answers null for removing the whole document, and fails with a TypeError for moving a place into itself. */
const refusal = (o: Json): string | null =>
  o?.op === "remove" && o.path === "" ? "remove: can't remove the whole document" : o?.op === "move" && o.path.startsWith(o.from + "/") ? `move ${o.from}: into itself` : null;

/** `doc` with `patch` applied, as a new value. The patch is cloned: the library puts its values into the
 *  result, where a later operation would change them in the patch kept in the history. */
export function apply(doc: Json, patch: Json): Json {
  const refused = Array.isArray(patch) ? patch.map(refusal).find(Boolean) : null;
  if (refused) throw new PatchError(refused);
  try {
    return jsonpatch.applyPatch(doc, clone(patch), true, false).newDocument;
  } catch (e: any) {
    throw new PatchError((e.operation ? `${e.operation.op} ${e.operation.path}: ` : "") + e.message.split("\n")[0]);
  }
}
