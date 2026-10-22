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
//   App.cue(el, cue)        say what just happened to el, for motion.js to show if the page has it:
//                           done, added, reveal, success, miss; App.oncue(fn) hears them
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
// A page opened with ?theme=light or ?theme=dark keeps to that theme whatever the device's;
// <html data-theme> set or removed later switches it again.
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
  const sleep = (ms) => new Promise((go) => setTimeout(go, ms));

  // --- JSON Patch: fast-json-patch, inlined before this (bound now, so a page can't replace it, and a missing one fails here); worded as the host's src/patch.ts words it ---
  const { applyPatch, getValueByPointer } = jsonpatch;
  const refusal = (o) =>
    o && o.op === "remove" && o.path === "" ? "remove: can't remove the whole document" : o && o.op === "move" && o.path.startsWith(o.from + "/") ? `move ${o.from}: into itself` : null;

  // The value at a JSON pointer; throws when there is none
  function at(doc, path) {
    let value;
    try {
      value = getValueByPointer(doc, path); // throws for a missing parent, answers undefined for a missing last key
    } catch {}
    if (value === undefined) throw new Error(`${path}: there's nothing there`);
    return value;
  }
  // `data` with `ops` applied, as a new value. The ops are cloned: the library puts their values into the result
  function apply(data, ops) {
    const refused = Array.isArray(ops) ? ops.map(refusal).find(Boolean) : null;
    if (refused) throw new Error(refused);
    try {
      return applyPatch(data, clone(ops), true, false).newDocument;
    } catch (e) {
      throw new Error((e.operation ? `${e.operation.op} ${e.operation.path}: ` : "") + e.message.split("\n")[0]);
    }
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

  // --- forms, which the sandbox won't submit, and the theme ---

  function submit(form, submitter) {
    if (!form.noValidate && !submitter?.formNoValidate && !form.checkValidity()) return form.reportValidity();
    const event = typeof SubmitEvent === "function"
      ? new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter })
      : new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
  }
  const SCHEME = /\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/gi;
  const written = new WeakMap(); // a media list: its text as the page wrote it
  function keepTheme() {
    const set = document.documentElement.dataset.theme;
    const theme = set === "light" || set === "dark" ? set : null;
    const fix = (media) => {
      const text = written.get(media) ?? media.mediaText;
      if (text.search(SCHEME) < 0) return;
      written.set(media, text);
      const kept = theme ? text.replace(SCHEME, (_, scheme) =>
        scheme.toLowerCase() === theme ? "(min-width: 0px)" : "(max-width: -1px)") : text;
      if (media.mediaText !== kept) media.mediaText = kept;
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
    document.documentElement.style.colorScheme = theme || "";
  }
  if (typeof location !== "undefined" && typeof document !== "undefined" && document.styleSheets) {
    const theme = new URLSearchParams(location.search).get("theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
    keepTheme();
    new MutationObserver(keepTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }
  // --- parts: a component's script runs once for each element that holds it ---

  const mounts = []; // [name, fn]
  const drawers = new WeakMap(); // a mounted element: its draw
  const lookup = (path) => {
    try {
      return at(app.data, path);
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

  const oncue = [];

  return {
    cue(el, what) {
      for (const fn of oncue) fn(el, what);
    },
    oncue(fn) {
      oncue.push(fn);
    },
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
      return at(app.data, path);
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
      return this.patch([{ op: lookup(path) !== undefined ? "replace" : "add", path, value }], event);
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
