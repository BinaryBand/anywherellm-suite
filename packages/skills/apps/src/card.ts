// An app's card: its title, a summary line and up to ROWS rows, as Markdown the agent puts in its
// reply. app.json's card names what to show:
//   summary  text for the line beside the title
//   lines    a list of texts, or one pointer to a list in the data
//   items    a pointer to a list in the data: one row each, with a tick when the item has a `done`
//            key; `text` and `done` name the keys (default "text" and "done"); `where` keeps only
//            the items whose keys have those values
// A text that starts with "/" is a JSON Pointer into the data; elsewhere {/pointer} is replaced by
// what the pointer finds, and a pointer ending in /length on a list is its length. A missing value
// reads as empty, so a card never fails to draw.

import { get, type Json } from "./patch.ts";

export const ROWS = 6;
const TEXT_MAX = 120;

function lookup(data: Json, pointer: string): Json {
  try {
    return found(data, pointer);
  } catch {
    return undefined; // a card never breaks an answer: what isn't there shows as nothing
  }
}

function found(data: Json, pointer: string): Json {
  if (pointer.endsWith("/length")) {
    const list = get(data, pointer.slice(0, -"/length".length));
    return Array.isArray(list) ? list.length : undefined;
  }
  return get(data, pointer);
}

const plain = (v: Json): string => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
const short = (s: string): string => (s.length > TEXT_MAX ? s.slice(0, TEXT_MAX - 1) + "…" : s);

/** A pointer's value as a card says it: a list as how many it holds ("3 cards"), else as text. */
const counted = (v: Json, pointer: string): string => (Array.isArray(v) ? `${v.length} ${pointer.split("/").pop()}` : plain(v));

/** A card's text: a pointer's value, or text with {/pointer}s filled in. */
const textOf = (data: Json, text: Json): string =>
  typeof text !== "string" ? "" : text.startsWith("/") ? counted(lookup(data, text), text) : text.replace(/\{(\/[^{}]*)\}/g, (_, p) => plain(lookup(data, p)));

/** The items the card lists: the pointer's list, less those `where` leaves out. */
function itemsOf(spec: Json, data: Json): Json[] | null {
  const found = typeof spec.items === "string" ? get(data, spec.items) : undefined;
  if (!Array.isArray(found)) return null;
  const where = spec.where && typeof spec.where === "object" ? Object.entries(spec.where) : [];
  return found.filter((i) => where.every(([k, v]) => i && typeof i === "object" && i[k] === v));
}

function summaryOf(card: Json, data: Json, items: Json[] | null): string {
  if (typeof card.summary === "string") return textOf(data, card.summary);
  if (!items) return "";
  const done = card.done || "done";
  if (items.some((i) => i && typeof i === "object" && typeof i[done] === "boolean")) {
    const left = items.filter((i) => !(i && i[done] === true)).length;
    return `${left} of ${items.length} left`;
  }
  return `${items.length} item${items.length === 1 ? "" : "s"}`;
}

const cell = (s: string): string => s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");

/** The card's summary line, as text: what the headline says beside the title. */
export function summary(app: Json): string {
  const spec = app.card || {};
  return summaryOf(spec, app.data, itemsOf(spec, app.data));
}

/** The card's first line: its title and summary; with an address the title is the link to the app's page. */
export function headline(app: Json, url?: string | null): string {
  const line = summary(app);
  const title = url ? `[${cell(app.title).replace(/[[\]]/g, "\\$&")}](${url})` : cell(app.title);
  return `**${title}**${line ? ` · ${cell(line)}` : ""}`;
}

/** The card's Markdown lines. Items with a tick are a table of ☑ and ☐ (AnythingLLM's chat draws no
 *  Markdown checkboxes) under the headline as its header row, a ticked one struck through; other
 *  items are a bulleted list under the headline. */
export function card(app: Json, url?: string | null): string[] {
  const spec = app.card || {};
  const found = itemsOf(spec, app.data);
  const items = found && found.length ? found : null;
  if (!items) {
    // A pointer's list is data, shown as it is; a list in the card is texts that may point.
    const fromData = typeof spec.lines === "string";
    const listed = fromData ? lookup(app.data, spec.lines) : spec.lines;
    const lines: string[] = Array.isArray(listed) ? listed.slice(0, ROWS).map((l) => cell(short(fromData ? plain(l) : textOf(app.data, l)))).filter(Boolean) : [];
    return lines.length ? [headline(app, url), "", ...lines.map((l) => `- ${l}`)] : [headline(app, url)];
  }
  const textKey = spec.text || "text", doneKey = spec.done || "done";
  const rows = items.slice(0, ROWS).map((item) => {
    const isObject = item && typeof item === "object" && !Array.isArray(item);
    const text = cell(short(plain(isObject ? item[textKey] : item)) || "(empty)");
    return { text, done: isObject && typeof item[doneKey] === "boolean" ? (item[doneKey] as boolean) : null };
  });
  const more = items.length > ROWS ? `…and ${items.length - ROWS} more` : null;
  if (rows.some((r) => r.done !== null)) {
    return [
      `| | ${headline(app, url)} |`,
      "|---|---|",
      ...rows.map((r) => (r.done === null ? `| | ${r.text} |` : r.done ? `| ☑ | ~~${r.text}~~ |` : `| ☐ | ${r.text} |`)),
      ...(more ? [`| | ${more} |`] : []),
    ];
  }
  return [headline(app, url), "", ...rows.map((r) => `- ${r.text}`), ...(more ? [`- ${more}`] : [])];
}
