// Which of AnythingLLM's internal routes a client may reach. The bridge logs in with AnythingLLM's
// password, so what it passes is the owner's to choose: BRIDGE_ALLOW lists the routes, and nothing
// else gets through.
//
// An entry is `[METHOD ]/path/prefix`, entries separated by commas:
//
//     GET /scheduled-jobs, /workspaces, POST /system/custom-models
//
// With no method an entry allows GET, POST, PUT and DELETE. A prefix matches whole path segments:
// `/workspaces` allows `/workspaces/home/memories` but not `/workspaces-old`. A `*` segment matches
// any one segment, for a route with the workspace in its middle: `POST /workspace/*/thread/*/update`.
// The path is AnythingLLM's own, under `/api`.

import { forbidden, invalid } from "#shared/errors";

export const METHODS = ["GET", "POST", "PUT", "DELETE"];
const WILDCARD = "*";
const SEGMENT = /^[^/\\\x00-\x1f\x7f]+$/;
const QUERY = /^[\x21-\x7e]*$/; // as it arrives, already percent-encoded

export interface Rule {
  /** null: any of METHODS. */
  method: string | null;
  prefix: string[];
}

/** The segments of a path with no empty, `.` or `..` segment, which could climb out of the prefix
 *  a rule names. */
function segmentsOf(path: string): string[] {
  const found = path.replace(/^\/+|\/+$/g, "").split("/");
  if (!found.every((s) => SEGMENT.test(s) && s !== "." && s !== "..")) throw invalid(`bad path ${JSON.stringify(path)}`);
  return found;
}

const pathOf = (segments: string[]): string => "/" + segments.join("/");

export const show = (rule: Rule): string => `${rule.method ? rule.method + " " : ""}${pathOf(rule.prefix)}`;

const matches = (prefix: string[], segments: string[]): boolean =>
  prefix.every((want, i) => i < segments.length && (want === WILDCARD || want === segments[i]));

const permits = (rule: Rule, method: string, segments: string[]): boolean =>
  (rule.method === null ? METHODS.includes(method) : rule.method === method) && matches(rule.prefix, segments);

/** The rules a BRIDGE_ALLOW text lists. */
export function parseRules(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const entry of text.split(",").map((e) => e.trim()).filter(Boolean)) {
    const cut = entry.lastIndexOf(" ");
    const method = (cut < 0 ? "" : entry.slice(0, cut)).trim().toUpperCase();
    const path = entry.slice(cut + 1);
    if ((method && !METHODS.includes(method)) || !path.startsWith("/")) {
      throw invalid(`BRIDGE_ALLOW: ${JSON.stringify(entry)} is not \`[GET|POST|PUT|DELETE ]/path/prefix\``);
    }
    try {
      rules.push({ method: method || null, prefix: segmentsOf(path) });
    } catch {
      throw invalid(`BRIDGE_ALLOW: bad path in ${JSON.stringify(entry)}`);
    }
  }
  return rules;
}

/** The rules of contract/default-allow.txt: one entry per line (commas work too), `#` lines and
 *  blank lines left out. */
export const defaultRules = (text: string): Rule[] =>
  parseRules(text.split("\n").filter((line) => !line.trim().startsWith("#")).join(","));

/** That file as a BRIDGE_ALLOW value, on one line. */
export const defaultList = (text: string): string => defaultRules(text).map(show).join(", ");

/** A route AnythingLLM declares: a `:name` segment takes any one segment. */
export interface Declared {
  method: string;
  segments: string[];
}

/** The rules that name no declared route, as they are written: a route that has gone or moved.
 *  A rule is a prefix, so any route under it will do. */
export function absentRules(rules: Rule[], declared: Declared[]): string[] {
  const under = (rule: Rule, route: Declared): boolean =>
    (rule.method === null || rule.method === route.method) &&
    rule.prefix.length <= route.segments.length &&
    rule.prefix.every((want, i) => want === WILDCARD || route.segments[i].startsWith(":") || want === route.segments[i]);
  return rules.filter((rule) => !declared.some((route) => under(rule, route))).map(show);
}

/** `encodeURIComponent` that also encodes `!'()*`, so no character is left that could end a segment. */
const quote = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** The upstream path and query for a request the rules allow: each segment requoted, so an encoded
 *  `?` or `#` stays inside its segment. Throws 403 when no rule allows it, 400 for a bad query. */
export function route(rules: Rule[], method: string, path: string, query: string): string {
  const segments = segmentsOf(path);
  if (!rules.some((r) => permits(r, method, segments))) throw forbidden(`the bridge doesn't pass ${method} ${pathOf(segments)}`);
  if (!QUERY.test(query)) throw invalid("bad query string");
  return pathOf(segments.map(quote)) + (query ? `?${query}` : "");
}
