// app.js: an app page's way to its data, which the host inlines into every app's page.
// The page loads it and starts it with what the host embedded:
//
//   <script src="app.js"></script>
//   <script>App.start(/*APP*/null); App.onchange(draw); draw();</script>
//
//   App.start(app)          takes {title, card, data, line, append, sync}; returns
//                           App.data, the one object for good: every change is made in it
//   App.data, App.title, App.card, App.line   the app as this page has it now
//   App.patch(ops, event)   change the data: a JSON patch (RFC 6902) on the data, applied
//                           here at once and saved shortly after; a promise of whether it
//                           was saved. `event` is optional: {ev, ...fields}, logged with the
//                           patch ({ev: "review", card: "tack", ok: true})
//   App.set(path, v, event) replace what's at path, or add it
//   App.get(path)           what's at path
//   App.log(since)          a promise of the log's lines after line `since` (default 0)
//   App.onchange(fn)        fn(App.data) after every change: this page's own, and one from
//                           elsewhere (another tab, the agent)
//   App.onstatus(fn)        fn(state, text): saving, saved, offline, conflict, error
//   App.mount(name, fn)     run a component: fn({root, at, q}) once for each element with
//                           data-part=name, `at` the data it stands for (its data-at, "" for
//                           the whole data) and q(ref) its element with data-ref=ref; the
//                           function fn returns draws it, then and after every change
//
// A component repeats over a list: an element with data-each="/habits" holds a <template>,
// copied once for each item, and in each copy the parts stand for that item ("/habits/1")
// and an element with data-text="name" shows the item's name. The copies are made again when
// the list's length changes.
//
// The data is the state the log's lines reach. The page keeps the state at its line (what
// the host confirmed) and its own changes not yet saved, and shows the one on top of the
// other. Lines appended elsewhere arrive by sync and go under the page's own changes. A change
// that no longer applies on top (a `test` that fails, an item that's gone) is dropped.
// Guard a change to a list item by its place (remove /items/3), which could now be another item:
//   [{op: "test", path: "/items/3/text", value: "Eggs"},
//    {op: "replace", path: "/items/3/done", value: true}]
//
// A value that follows from the time (a timer's seconds left) is never stored: store when
// something started and work the rest out from Date.now().
//
// A page opened with ?theme=light or ?theme=dark keeps to that theme whatever the device's.
// Forms don't submit on the pages server (its sandbox has no allow-forms), so Enter in a
// field and a click on a submit button become a submit event the form's handler sees.
"use strict";
const App = (() => {
  const SAVE_AFTER = 300; // ms after the last change
  const RETRY = 3000;
  const MAX_BODY = 256 * 1024;
  let app = null; // what the host embedded; app.data is what the page shows
  let confirmed = null; // the state after app.line, as the host has it
  let queue = []; // changes not sent yet: [{ops, event, done: [resolve]}]
  let flight = null; // the change being sent
  let timer = 0;
  let settled = null; // resolves when the change in flight is answered
  const onchange = [];
  const onstatus = [];

  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  // As JSON values: an object's keys in any order
  function equal(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]));
  }
  const sleep = (ms) => new Promise((go) => setTimeout(go, ms));

  // --- JSON Patch, as the host applies it (src/patch.ts); "" is the data as a whole ---

  function pointer(path) {
    if (typeof path !== "string" || (path && !path.startsWith("/"))) throw new Error(`bad path ${path}`);
    if (!path) return ["root"];
    return ["root", ...path.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"))];
  }
  function index(list, token, path, appending) {
    if (appending && token === "-") return list.length;
    if (!/^(0|[1-9][0-9]*)$/.test(token)) throw new Error(`${path}: ${token} isn't an index`);
    const i = Number(token);
    if (i > list.length || (i === list.length && !appending)) throw new Error(`${path}: there's no item ${i}`);
    return i;
  }
  // The container the path's last token is in, that token, and how deep the path goes
  function slot(doc, path) {
    const parts = pointer(path);
    let where = doc;
    for (const token of parts.slice(0, -1)) {
      if (Array.isArray(where)) where = where[index(where, token, path, false)];
      else if (where && typeof where === "object" && Object.hasOwn(where, token)) where = where[token];
      else throw new Error(`${path}: there's nothing at ${token}`);
    }
    return [where, parts[parts.length - 1], parts.length];
  }
  function at(doc, path) {
    const [where, last] = slot(doc, path);
    if (Array.isArray(where)) return where[index(where, last, path, false)];
    if (where && typeof where === "object" && Object.hasOwn(where, last)) return where[last];
    throw new Error(`${path}: there's nothing there`);
  }
  function remove(doc, path) {
    const [where, last, depth] = slot(doc, path);
    if (depth === 1) throw new Error("the data as a whole can't be removed");
    if (Array.isArray(where)) return where.splice(index(where, last, path, false), 1)[0];
    if (where && typeof where === "object" && Object.hasOwn(where, last)) {
      const value = where[last];
      delete where[last];
      return value;
    }
    throw new Error(`${path}: there's nothing there`);
  }
  function add(doc, path, value) {
    const [where, last] = slot(doc, path);
    if (Array.isArray(where)) where.splice(index(where, last, path, true), 0, value);
    else if (where && typeof where === "object") where[last] = value;
    else throw new Error(`${path}: its parent isn't an object or a list`);
  }
  function apply(data, ops) {
    const doc = { root: clone(data) };
    for (const step of ops) {
      const { op, path } = step;
      if ((op === "add" || op === "replace") && !("value" in step)) throw new Error(`${op} needs a value`);
      if (op === "add") add(doc, path, clone(step.value));
      else if (op === "remove") remove(doc, path);
      else if (op === "replace") {
        at(doc, path);
        const [where, last] = slot(doc, path);
        where[Array.isArray(where) ? Number(last) : last] = clone(step.value);
      } else if (op === "test") {
        if (!equal(at(doc, path), step.value)) throw new Error(`${path} isn't what the patch expected`);
      } else if (op === "move" || op === "copy") {
        const origin = pointer(step.from);
        const target = pointer(path);
        if (op === "move" && target.length > origin.length && origin.every((t, i) => t === target[i]))
          throw new Error(`${step.from} can't move into itself`);
        add(doc, path, op === "move" ? remove(doc, step.from) : clone(at(doc, step.from)));
      } else throw new Error("op must be one of: add, remove, replace, move, copy, test");
    }
    return doc.root;
  }

  // --- state ---

  function into(kept, next) {
    // In place, so a page that kept App.data (or a part of it) sees the change.
    const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
    if (Array.isArray(kept) && Array.isArray(next)) {
      kept.splice(0, kept.length, ...next);
      return kept;
    }
    if (object(kept) && object(next)) {
      for (const key of Object.keys(kept)) if (!Object.hasOwn(next, key)) delete kept[key];
      for (const key of Object.keys(next)) kept[key] = Object.hasOwn(kept, key) ? into(kept[key], next[key]) : next[key];
      return kept;
    }
    return next;
  }
  function status(state, text) {
    for (const fn of onstatus) fn(state, text || "");
  }
  function changed() {
    for (const fn of onchange) fn(app.data);
  }
  function catchUp(reply) {
    // The host's lines (or its whole state) under the page's own changes.
    if (reply.data !== undefined && !reply.lines) confirmed = clone(reply.data);
    for (const line of reply.lines || []) {
      if (line.n <= app.line) continue; // already have it
      try {
        confirmed = apply(confirmed, line.patch);
      } catch {}
    }
    app.line = Math.max(app.line, reply.line);
  }
  function show() {
    // The confirmed state with the page's unsaved changes on top; one that no longer
    // applies is dropped, and its promise says so.
    let data = confirmed;
    const pending = flight ? [flight, ...queue] : queue;
    const kept = [];
    for (const change of pending) {
      try {
        data = apply(data, change.ops);
        kept.push(change);
      } catch {
        for (const resolve of change.done) resolve(false);
        status("conflict", "Changed elsewhere; showing the latest.");
      }
    }
    if (flight && !kept.includes(flight)) flight = null;
    queue = kept.filter((c) => c !== flight);
    const before = JSON.stringify(app.data);
    app.data = into(app.data, clone(data));
    if (JSON.stringify(app.data) !== before) changed();
  }

  // --- saving ---

  function later() {
    clearTimeout(timer);
    timer = setTimeout(flush, SAVE_AFTER);
  }

  async function post(url, body, signal) {
    const answer = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(body),
      signal,
    });
    return [answer.status, await answer.json().catch(() => ({}))];
  }

  function next() {
    // The next change to send: plain changes in a row go as one.
    const first = queue.shift();
    while (!first.event && queue.length && !queue[0].event) {
      const more = queue.shift();
      first.ops = first.ops.concat(more.ops);
      first.done = first.done.concat(more.done);
    }
    return first;
  }

  function body(change) {
    const out = { base: app.line, patch: change.ops };
    if (change.event) {
      const { ev, ...fields } = change.event;
      if (ev) out.ev = ev;
      if (Object.keys(fields).length) out.fields = fields;
    }
    return out;
  }

  async function flush() {
    if (flight || !queue.length) return;
    flight = next();
    let release;
    settled = new Promise((go) => (release = go));
    try {
      await send(flight);
    } finally {
      release();
      settled = null;
    }
    if (queue.length) later();
  }

  async function send(change) {
    const sent = body(change);
    if (JSON.stringify(sent).length > MAX_BODY - 1024) {
      status("error", "That change is too big to save at once.");
      return drop(change);
    }
    status("saving", "Saving…");
    let code, reply;
    try {
      [code, reply] = await post(app.append, sent);
    } catch {
      return retry(change, "Couldn't reach the server; trying again.");
    }
    if (code === 200) {
      flight = null;
      catchUp(reply);
      for (const resolve of change.done) resolve(true);
      status("saved", "Saved");
      return show();
    }
    if (code === 429 || code >= 500) return retry(change, reply.error || "Busy; trying again.");
    status("error", reply.error || `Couldn't save (${code}).`);
    drop(change);
  }

  function retry(change, text) {
    flight = null;
    queue.unshift(change);
    status("offline", text);
    setTimeout(flush, RETRY);
  }

  function drop(change) {
    flight = null;
    for (const resolve of change.done) resolve(false);
    show();
  }

  // --- keeping up with changes made elsewhere ---

  async function sync() {
    while (true) {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        await new Promise((go) => document.addEventListener("visibilitychange", go, { once: true }));
        continue;
      }
      if (settled) {
        await settled; // its answer brings the lines appended meanwhile
        continue;
      }
      let code, reply;
      try {
        [code, reply] = await post(app.sync, { since: app.line });
      } catch {
        await sleep(RETRY);
        continue;
      }
      if (code !== 200) {
        await sleep(RETRY * 2);
        continue;
      }
      if (flight || settled) continue; // the append's answer has these lines too
      catchUp(reply);
      if (reply.data !== undefined || reply.lines?.length) show();
    }
  }

  // --- forms, which the sandbox won't submit, and the theme a page was opened in ---

  function submit(form, submitter) {
    if (!form.noValidate && !submitter?.formNoValidate && !form.checkValidity()) return form.reportValidity();
    const event = typeof SubmitEvent === "function"
      ? new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter })
      : new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
  }
  const SCHEME = /\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/gi;
  function keepTheme(theme) {
    const fix = (media) => {
      const text = media.mediaText;
      const kept = text.replace(SCHEME, (_, scheme) =>
        scheme.toLowerCase() === theme ? "(min-width: 0px)" : "(max-width: -1px)");
      if (kept !== text) media.mediaText = kept;
    };
    const visit = (rules) => {
      for (const rule of rules) {
        if (rule.media) fix(rule.media);
        if (rule.cssRules) visit(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      if (sheet.media) fix(sheet.media);
      try {
        visit(sheet.cssRules);
      } catch {}
    }
    document.documentElement.style.colorScheme = theme;
  }
  if (typeof location !== "undefined" && typeof document !== "undefined" && document.styleSheets) {
    const theme = new URLSearchParams(location.search).get("theme");
    if (theme === "light" || theme === "dark") keepTheme(theme);
  }
  // --- parts: a component's script runs once for each element that holds it ---

  const mounts = []; // [name, fn]
  const drawers = new WeakMap(); // a mounted element: its draw
  const lookup = (path) => {
    try {
      return at({ root: app.data }, path);
    } catch {
      return undefined;
    }
  };
  function copies() {
    for (const box of document.querySelectorAll("[data-each]")) {
      const template = box.querySelector(":scope > template");
      const list = lookup(box.dataset.each);
      const n = Array.isArray(list) ? list.length : 0;
      if (!template || box.eachCount === n) continue;
      box.eachCount = n;
      box.replaceChildren(template, ...Array.from({ length: n }, (_, i) => {
        const copy = template.content.cloneNode(true);
        for (const part of copy.querySelectorAll("[data-part], [data-text]")) part.dataset.at = `${box.dataset.each}/${i}${part.dataset.at || ""}`;
        return copy;
      }));
    }
  }
  function drawParts() {
    copies();
    for (const [name, fn] of mounts) {
      for (const root of document.querySelectorAll(`[data-part="${name}"]`)) {
        if (drawers.has(root)) continue;
        const draw = fn({ root, at: root.dataset.at || "", q: (ref) => root.querySelector(`[data-ref="${ref}"]`) });
        drawers.set(root, typeof draw === "function" ? draw : () => {});
      }
    }
    for (const root of document.querySelectorAll("[data-part]")) drawers.get(root)?.();
    for (const text of document.querySelectorAll("[data-text]")) text.textContent = lookup(`${text.dataset.at || ""}/${text.dataset.text}`) ?? "";
  }

  const NOT_TEXT = ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"];
  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("click", (e) => {
      const button = e.target?.closest?.("button, input[type=submit], input[type=image]");
      if (!button?.form || (button.type || "").toLowerCase() !== "submit") return;
      e.preventDefault();
      submit(button.form, button);
    }, true);
    document.addEventListener("keydown", (e) => {
      const field = e.target;
      if (e.key !== "Enter" || e.isComposing || field?.tagName !== "INPUT" || !field.form) return;
      if (NOT_TEXT.includes((field.type || "").toLowerCase())) return;
      e.preventDefault();
      submit(field.form, null);
    }, true);
  }

  return {
    /** `data` with `ops` applied, as a new value; throws when one doesn't apply. */
    apply,
    start(embedded) {
      if (!embedded || typeof embedded !== "object") throw new Error("App.start needs the app the host embedded");
      app = embedded;
      confirmed = clone(app.data);
      sync();
      return app.data;
    },
    get data() {
      return app.data;
    },
    get title() {
      return app.title;
    },
    get card() {
      return app.card;
    },
    get line() {
      return app.line;
    },
    get(path) {
      return at({ root: app.data }, path);
    },
    patch(ops, event) {
      if (!Array.isArray(ops) || !ops.length) throw new Error("a patch is a list of operations");
      if (event !== undefined && (event === null || typeof event !== "object")) throw new Error("an event is an object, e.g. {ev: 'done'}");
      app.data = into(app.data, apply(app.data, ops)); // throws, changing nothing, when it doesn't apply
      const promise = new Promise((resolve) => queue.push({ ops: clone(ops), event: clone(event), done: [resolve] }));
      later();
      changed();
      return promise;
    },
    set(path, value, event) {
      let there = true;
      try {
        at({ root: app.data }, path);
      } catch {
        there = false;
      }
      return this.patch([{ op: there ? "replace" : "add", path, value }], event);
    },
    async log(since = 0) {
      const [code, reply] = await post(app.sync, { since, wait: false });
      if (code !== 200) throw new Error(reply.error || `Couldn't read the log (${code}).`);
      return reply.lines || [];
    },
    onchange(fn) {
      onchange.push(fn);
    },
    onstatus(fn) {
      onstatus.push(fn);
    },
    mount(name, fn) {
      if (!mounts.length) onchange.push(drawParts);
      mounts.push([name, fn]);
      drawParts();
    },
  };
})();
