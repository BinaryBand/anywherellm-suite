// runtime-lean.js: apps-lean's stand-in for a pages server, inlined in every page just before
// app.js, which the page uses unchanged. app.js saves with `post(app.append, ...)` and keeps up
// with `post(app.sync, ...)`; apps-lean gives it the addresses lean:append and lean:sync, and
// answers both here:
//   lean:append  the change goes to AnythingLLM as an apps-lean-event document (through the
//                browser extension's upload, which only stores it), with the app's secret, and is
//                confirmed as the next line. The skill applies it as it lands.
//   lean:sync    the page reads its state file (<token>.json beside it, which the skill writes
//                after every change) every 2 s while it's in view, and at once after it posts:
//                a newer line is the data, under this page's changes the app hasn't recorded yet.
//                A page whose parts changed reloads, unless the user is typing; an app that was
//                deleted says so.
// A change sent but not recorded stays applied over newer data, in this browser's storage, until
// the app lists its id (patched with App.apply, the page's one patch engine). App.log gives the
// newest changes the page was written with.
var AppsLean = (() => {
  const cfg = JSON.parse(document.getElementById("apps-lean").textContent);
  const KEY = "apps-lean:" + cfg.workspace + "/" + cfg.app;
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
  const keep = () => { try { localStorage.setItem(KEY, JSON.stringify({ pending })); } catch (e) {} };
  let pending = (load().pending || []).filter((e) => !cfg.seen.includes(e.id));
  let line = cfg.line, served = cfg.line, posted = 0;
  const stateUrl = location.pathname.replace(/\.html$/, ".json");
  function over(data) {
    // `data` with the changes the app hasn't recorded on top; one that no longer applies goes.
    const kept = [];
    for (const e of pending) {
      try { data = App.apply(data, e.patch); kept.push(e); } catch (err) {}
    }
    pending = kept;
    keep();
    return data;
  }
  const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const uuid = () => (self.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(16).slice(2));
  const native = window.fetch.bind(window);

  /** Posts an event of this app's page, with its secret, as a document AnythingLLM only stores;
   *  relative, as the page is served by AnythingLLM itself at whatever address the user reached it.
   *  Answers the response and the event's id. */
  async function upload(fields) {
    const id = uuid();
    const event = { apps_lean_event: 1, workspace: cfg.workspace, app: cfg.app, secret: cfg.secret, id, t: new Date().toISOString(), ...fields };
    const r = await native("/api/browser-extension/upload-content", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.key },
      body: JSON.stringify({ textContent: JSON.stringify(event), metadata: { title: cfg.eventTitle, docSource: "apps-lean page" } }),
    });
    return { r, id };
  }

  async function append(body) {
    const { r, id } = await upload({ kind: "change", ev: body.ev || "change", fields: body.fields, patch: body.patch });
    if (r.status === 403) return answer(403, { error: "AnythingLLM refused this page's key; ask the agent for the page again." });
    if (!r.ok) return answer(r.status >= 500 ? 503 : r.status, { error: "AnythingLLM answered " + r.status + "." });
    pending.push({ id, patch: body.patch });
    keep();
    posted = Date.now();
    line = Math.max(line, body.base) + 1;
    return answer(200, { line, lines: [{ n: line, patch: body.patch }] });
  }

  // Every 2 s while the page is in view, soon after this page posted, and at once when it comes
  // back into view.
  const pause = () => new Promise((go) => {
    const ms = Date.now() - posted < 2000 ? 250 : 2000;
    const done = () => (clearTimeout(t), document.removeEventListener("visibilitychange", wake), go());
    const wake = () => { if (!document.hidden) done(); };
    const t = setTimeout(done, ms);
    document.addEventListener("visibilitychange", wake);
  });
  /** The bar along the bottom saying what the user should know now, with an optional button: one
   *  bar, whose words are the newest. */
  let barEl = null;
  function bar(text, label, act) {
    if (!barEl) {
      barEl = document.createElement("div");
      barEl.setAttribute("role", "status");
      barEl.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:9;display:flex;gap:12px;align-items:center;justify-content:space-between;padding:10px 14px;border-radius:12px;background:var(--ink,#222);color:var(--panel,#fff);font:15px/1.4 system-ui,sans-serif";
    }
    if (barEl.dataset && barEl.dataset.said === text) return;
    if (barEl.dataset) barEl.dataset.said = text;
    barEl.textContent = text;
    if (label) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.style.cssText = "min-height:44px;padding:0 14px;border-radius:10px;border:0;font:inherit;font-weight:600";
      b.addEventListener("click", act);
      barEl.append(b);
    }
    document.body.append(barEl);
  }
  // The focused element, inside a shadow root too (Comment's tray is in one).
  const typing = () => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || !!(a && a.isContentEditable); };
  let gone = false;
  async function sync(body) {
    // App.log asks without waiting: the newest changes, as the page was written with them.
    if (body.wait === false) return answer(200, { line, lines: (cfg.log || []).filter((l) => l.n > (body.since || 0)) });
    if (gone) return new Promise(() => {}); // nothing more will come
    await pause();
    if (!host.isConnected) tray(); // a page that drew itself again took the button out
    if (!/^https?:$/.test(location.protocol)) return answer(200, { line: body.since, lines: [] });
    try {
      const next = await (await native(stateUrl, { cache: "no-cache" })).json();
      if (next && next.gone) {
        gone = true;
        bar("This app was deleted.");
        return new Promise(() => {});
      }
      if (next && next.version && cfg.version && next.version !== cfg.version) {
        // The page itself changed: a reload gets it. This page's unrecorded changes are kept in
        // the browser's storage, so they come back over it.
        if (!typing()) location.reload();
        else bar("This app's page changed.", "Reload", () => location.reload());
      }
      if (!next || typeof next.line !== "number" || (next.line === served && !pending.length)) return answer(200, { line: body.since, lines: [] });
      // A change the app saw is recorded, or was refused, which leaves the line as it was: either
      // way it no longer goes over the data.
      const seen = next.seen || [], left = pending.filter((e) => !seen.includes(e.id));
      const refused = (next.refused || []).filter((r) => pending.some((e) => e.id === r.id));
      if (next.line === served && left.length === pending.length) return answer(200, { line: body.since, lines: [] });
      if (refused.length) bar((refused.length > 1 ? refused.length + " changes weren't saved: " : "A change wasn't saved: ") + refused[refused.length - 1].why);
      served = next.line;
      pending = left;
      line = Math.max(line, next.line);
      return answer(200, { data: over(next.data), line });
    } catch (e) {
      return answer(503, { error: "Can't reach AnythingLLM." });
    }
  }

  // --- Comment: the user picks up to 5 things on the page and says one thing about them, a question
  // or a change; it goes to the chat as an ask, which the agent acts on only when the user asks it to
  // there. While picking, taps pick instead of pressing: these listeners, on the window and added
  // before any part's, see each tap first and keep it from the page; scrolling still works.
  const PICKS = cfg.picks || 5, WORDS = cfg.words || 500;
  let picking = false, picks = [], text = "", sending = false, failed = false, row = null;
  const host = document.createElement("div");
  const ui = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  const ours = (e) => (e.composedPath ? e.composedPath().includes(host) : host.contains(e.target));
  /** What marks the picked element in page.html and in the data, and what it showed. */
  function locate(el) {
    const near = (sel) => (el.closest ? el.closest(sel) : null);
    const part = near("[data-part]"), ref = near("[data-ref]"), id = near("[id]"), fig = near("[data-figure]"), item = near("[data-at]");
    let figure;
    try { figure = fig ? JSON.parse(fig.getAttribute("data-figure")).kind : undefined; } catch (e) {}
    const shown = String(el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
    const key = el.getAttribute && el.getAttribute("data-text");
    return {
      id: id && id.id || undefined, ref: ref && ref.getAttribute("data-ref") || undefined, part: part && part.getAttribute("data-part") || undefined,
      at: item ? item.getAttribute("data-at") + (key ? "/" + key : "") : undefined, figure, tag: String(el.tagName || "").toLowerCase(), cls: el.classList && el.classList[0] || undefined, shown: shown || undefined,
    };
  }
  const outline = (el, on) => { el.style.outline = on ? "3px solid var(--accent, #6a5cff)" : ""; el.style.outlineOffset = on ? "2px" : ""; };
  /** A row made of the page's first heading, for the button beside it; none when there's no heading,
   *  or it's hidden or inside a link or a control, where a tap on the button would do more. */
  function heading() {
    const h1 = document.querySelector && document.querySelector("h1");
    if (!h1 || !h1.parentNode || (h1.closest && h1.closest("a,button,label,summary,dialog,[hidden]")) || (h1.getClientRects && !h1.getClientRects().length)) return null;
    const r = document.createElement("div");
    r.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px";
    h1.parentNode.insertBefore(r, h1);
    h1.style.flex = "1";
    h1.style.minWidth = "0";
    r.append(h1);
    return r;
  }
  function tray() {
    const open = picking || picks.length;
    // Shut, the button is beside the heading (else in the top right corner, scrolling away with the
    // page); open, the tray is on the body, out of the page's layout. Put back if the page took it out.
    if (!document.body) return;
    if (!open && !(row && row.isConnected)) row = heading();
    const into = open || !row ? document.body : row;
    if (host.parentNode !== into) into.append(host);
    ui.innerHTML = `<style>
      :host{all:initial;display:block}
      .b{position:absolute;right:14px;top:14px;z-index:2147483646;min-height:44px;padding:0 16px;border-radius:14px;border:1px solid var(--line,#ccc);background:var(--panel,#fff);color:var(--ink,#222);font:600 15px system-ui,sans-serif}
      .b.in{position:static}
      .c{padding:6px 12px;border-radius:99px;background:var(--soft,#eef);font-size:14px;font-weight:600}
      .t{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;max-height:70vh;overflow:auto;padding:14px 16px 18px;border-radius:18px 18px 0 0;background:var(--panel,#fff);color:var(--ink,#222);box-shadow:0 -8px 28px rgba(0,0,0,.18);font:15px/1.45 system-ui,sans-serif;display:flex;flex-direction:column;gap:10px}
      .r{display:flex;gap:8px;justify-content:space-between;align-items:center}
      button{min-height:44px;padding:0 14px;border-radius:12px;border:1px solid var(--line,#ccc);background:var(--panel,#fff);color:inherit;font:inherit;font-weight:600}
      .p{background:var(--accent,#6a5cff);color:var(--on-accent,#fff);border:0}
      textarea{width:100%;box-sizing:border-box;min-height:64px;padding:10px;border-radius:12px;border:1px solid var(--line,#ccc);font:inherit;color:inherit;background:var(--bg,#fff)}
      small{color:var(--muted,#666)}
    </style>` + (!open ? `<button class="b${row ? " in" : ""}" data-a="start" type="button">Comment</button>` : picking
      ? `<div class="t" role="dialog" aria-label="Pick what to comment on"><div class="r"><b>Tap what you want to comment on</b><small>${picks.length} of ${PICKS}</small></div><div class="r"><button data-a="cancel" type="button">Cancel</button><button class="p" data-a="describe" type="button"${picks.length ? "" : " disabled"}>${picks.length ? "Comment on " + picks.length + (picks.length === 1 ? " pick" : " picks") : "Pick something first"}</button></div></div>`
      : `<div class="t" role="dialog" aria-label="Write your comment"><b>${picks.length} picked</b><div class="r" style="flex-wrap:wrap;justify-content:flex-start">${picks.map((p, i) => `<span class="c">${i + 1}. ${esc(p.where.part || p.where.ref || p.where.tag)}${p.where.shown ? ": " + esc(p.where.shown) : ""}</span>`).join("")}</div><label><small>What do you want to say about these?</small><textarea data-text maxlength="${WORDS}" placeholder="A question or a change">${esc(text)}</textarea></label><small>${failed ? "Couldn't send it: try again in a moment." : "Nothing changes until you ask in the chat."}</small><div class="r"><button data-a="back" type="button">Back</button><button class="p" data-a="send" type="button"${text.trim() ? "" : " disabled"}>Send to the chat</button></div></div>`);
  }
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function end() {
    for (const p of picks) outline(p.el, false);
    picks = [];
    text = "";
    picking = failed = false;
    tray();
  }
  // A send that fails keeps the picks and the text, for another try; one tap sends once.
  async function send() {
    if (sending) return;
    sending = true;
    const { r } = await upload({ kind: "ask", ev: "ask", text: text.trim(), picks: picks.map((p) => p.where) }).catch(() => ({ r: null }));
    sending = false;
    failed = !(r && r.ok);
    if (failed) return tray();
    end();
    bar("Sent to the chat. Ask the agent there to answer, or to make the change.");
  }
  // What each of the tray's buttons does to picking: on, off, or send.
  const ACTS = { start: true, back: true, describe: false, cancel: null, send: "send" };
  ui.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("[data-a]");
    const act = a && ACTS[a.getAttribute("data-a")];
    if (act === undefined || !a) return;
    if (act === "send") return send();
    if (act === null) return end();
    picking = act;
    tray();
  });
  ui.addEventListener("input", (e) => {
    if (!e.target.hasAttribute || !e.target.hasAttribute("data-text")) return;
    text = e.target.value;
    ui.querySelector('[data-a="send"]').disabled = !text.trim();
  });
  // Keys typed in the tray are its own: from outside its shadow they'd look like keys on the page
  // (a deck's space and arrows turn its screen).
  ui.addEventListener("keydown", (e) => e.stopPropagation());
  for (const type of ["click", "pointerdown", "mousedown", "mouseup", "pointerup", "submit", "input", "change", "keydown", "touchend"])
    window.addEventListener(type, (e) => {
      if (!picking || ours(e)) return;
      if (type === "keydown" && e.key === "Escape") end();
      if (type !== "touchend") e.preventDefault();
      e.stopImmediatePropagation();
      if (type !== "click" || !e.target || e.target === document.body || e.target === document.documentElement) return;
      const at = picks.findIndex((p) => p.el === e.target || p.el.contains(e.target));
      if (at >= 0) ((outline(picks[at].el, false)), picks.splice(at, 1));
      else if (picks.length < PICKS) (outline(e.target, true), picks.push({ el: e.target, where: locate(e.target) }));
      tray();
    }, { capture: true });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tray);
  else tray();

  window.fetch = (url, opts) => {
    if (url === "lean:append") return append(JSON.parse(opts.body));
    if (url === "lean:sync") return sync(JSON.parse(opts.body));
    return native(url, opts);
  };
  return {
    /** The app as app.js's App.start takes it. */
    app: () => ({ title: cfg.title, card: cfg.card, data: over(cfg.data), line, token: "", append: "lean:append", sync: "lean:sync" }),
  };
})();
