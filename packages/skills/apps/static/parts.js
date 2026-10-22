// parts.js: drawings and read-only widgets for app pages, inlined by the host for
// <script src="parts.js"></script>, after it the figure kinds in parts/figures/. Neither
// writes the data, so a page shows them without wiring:
//
//   <figure class="fig" data-figure='{"kind": "flow", ...}'>   drawn where it stands
//   <div class="tree" data-tree='{"entries": [{path, note?, tag?, text?}]}'>   a folder tree
//   Parts.figure(spec), Parts.tree(entries)   the same, made from data: an element to place
//   Parts.deck(host, {title, screens, sources})   screens paged one at a time in the whole
//                           window; returns draw({title, screens, sources}) to call again
//
// Labels are text, never markup: every one is escaped.
var Parts =
  window.Parts ||
  (() => {
    const W = 300, H = 180;
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const fit = (s, n) => esc((s = String(s ?? "")).length > n ? s.slice(0, n - 1) + "…" : s);
    const svg = (body, label) => `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${body}</svg>`;
    const spread = (n, size, gap) => {
      const total = n * size + (n - 1) * gap;
      return Array.from({ length: n }, (_, i) => (W - total) / 2 + i * (size + gap));
    };
    const wrap = (s, n) => {
      const out = [""];
      for (const w of String(s).split(" ")) {
        if ((out.at(-1) + " " + w).trim().length > n) out.push(w);
        else out[out.length - 1] = (out.at(-1) + " " + w).trim();
      }
      return out;
    };
    const rect = (x, y, w, h, cls, rx = 2) => `<rect class="${cls}" x="${x}" y="${y}" width="${Math.max(0, w)}" height="${Math.max(0, h)}" rx="${rx}"/>`;
    const bar = (x, y, w) => rect(x, y, w, 1.5, "lq", 0.75);
    /** Text centred on x: what the label is made of, already fitted or escaped. */
    const mid = (cls, x, y, inner) => `<text class="${cls}" x="${x}" y="${y}" text-anchor="middle">${inner}</text>`;

    const kinds = {};
    const h = { W, H, esc, fit, svg, spread, wrap, rect, bar, mid };

    function figure(spec) {
      const f = make("figure", "fig");
      draw(f, spec);
      return f;
    }
    function draw(f, spec) {
      const kind = spec && kinds[spec.kind];
      f.innerHTML = kind ? kind(spec, h) : svg("", "");
    }

    function tree(entries) {
      const host = make("div", "tree");
      grow(host, entries);
      return host;
    }
    function grow(host, entries) {
      const root = { kids: new Map() };
      for (const e of entries || []) {
        const names = String(e.path).split("/").filter(Boolean);
        let node = root;
        names.forEach((name, i) => {
          if (!node.kids.has(name)) node.kids.set(name, { name, dir: i < names.length - 1 || e.path.endsWith("/"), kids: new Map(), path: names.slice(0, i + 1).join("/") });
          node = node.kids.get(name);
        });
        Object.assign(node, { note: e.note, tag: e.tag, text: e.text });
      }
      const view = make("div");
      view.hidden = true;
      view.setAttribute("aria-live", "polite");
      let pressed = null;
      const label = (row, node) => {
        row.append(make("b", "", node.name + (node.dir ? "/" : "")), make("small", "", node.note || ""));
        if (node.tag) row.append(make("span", "tag", node.tag));
      };
      const list = (node) => {
        const ul = make("ul");
        for (const kid of [...node.kids.values()].sort((a, b) => b.dir - a.dir)) {
          const li = make("li");
          if (kid.dir && kid.kids.size) {
            const d = make("details"), s = make("summary", "row");
            d.open = node === root; // the top folders start open
            label(s, kid);
            d.append(s, list(kid));
            li.append(d);
          } else if (kid.dir) {
            const row = make("div", "row");
            label(row, kid);
            li.append(row);
          } else {
            const b = make("button", "row");
            b.type = "button";
            b.setAttribute("aria-pressed", "false");
            label(b, kid);
            b.onclick = () => {
              if (pressed) pressed.setAttribute("aria-pressed", "false");
              const again = pressed === b;
              pressed = again ? null : b;
              view.hidden = again;
              if (again) return;
              b.setAttribute("aria-pressed", "true");
              view.replaceChildren(make("b", "", kid.path), make(kid.text ? "pre" : "p", "", kid.text || "No preview for this file."));
            };
            li.append(b);
          }
          ul.append(li);
        }
        return ul;
      };
      host.replaceChildren(list(root), view);
    }

    // Draw what the page wrote as markup: now, and again once the document is whole.
    const read = (el, attr) => {
      try {
        return JSON.parse(el.getAttribute(attr));
      } catch {
        return null;
      }
    };
    function scan() {
      for (const f of document.querySelectorAll("figure[data-figure]:not([data-drawn])")) {
        f.dataset.drawn = "";
        draw(f, read(f, "data-figure"));
      }
      for (const t of document.querySelectorAll("[data-tree]:not([data-drawn])")) {
        t.dataset.drawn = "";
        grow(t, (read(t, "data-tree") || {}).entries);
      }
    }
    queueMicrotask(scan);
    document.addEventListener("DOMContentLoaded", scan);

    // A deck: screens paged one at a time, filling the window, after the Mobile Presentation
    // pager. One filled button (Continue) moves on; Back, the progress marks, swipes, the arrow
    // keys and #s<n> in the address move too. Words are text: `code` and *accent* are the only
    // marks read in them.
    const DECK_CSS = `
.deck{--dk-side:color-mix(in oklch,var(--bg) 96%,black);--dk-ink2:color-mix(in oklch,var(--ink) 82%,var(--bg));--dk-line2:color-mix(in oklch,var(--line) 55%,var(--bg));--dk-okbg:color-mix(in oklch,var(--ok) 16%,var(--bg));position:fixed;inset:0;z-index:1;display:flex;align-items:center;justify-content:center;background:var(--dk-side);overscroll-behavior:none}
.deck button{min-height:0;min-width:0;padding:0;border:0;border-radius:0;background:none;font-weight:inherit}
.dk-app{position:relative;width:100%;height:100%;max-width:430px;background:var(--bg);overflow:hidden;display:flex;flex-direction:column}
@media (min-width:520px) and (min-height:700px){.dk-app{width:390px;height:min(844px,calc(100% - 32px));border-radius:28px;border:1px solid var(--line);box-shadow:0 24px 60px -24px oklch(.35 .04 280/.18)}}
.dk-top{height:72px;flex:none;padding:0 12px;display:grid;grid-template-columns:48px 1fr 48px;align-items:center;gap:8px}
.deck .dk-back{width:48px;height:48px;border-radius:50%;background:var(--well);display:grid;place-items:center}
.dk-back svg{width:18px;height:18px}.deck .dk-back:disabled{visibility:hidden}
.dk-ttl{display:flex;flex-direction:column;align-items:center;line-height:1.2;min-width:0;text-align:center}
.dk-ttl b{font-size:16px;font-weight:600;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dk-ttl span,.dk-foot{font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.dk-sq{display:flex;gap:4px;align-items:center;justify-content:center;height:44px;margin:-10px 16px 0;padding:0 4px;flex:none;border-radius:12px;cursor:pointer;touch-action:none;user-select:none}
.dk-sq:focus-visible{outline-offset:-2px}
.dk-sq i{flex:1;max-width:28px;height:4px;border-radius:99px;background:var(--line);transition:background .25s,transform .15s}
.dk-sq.held i.now{transform:scaleY(2)}
.dk-sq i.was{background:var(--accent);opacity:.45}.dk-sq i.now{background:var(--accent)}
.dk-screen{flex:1;display:flex;flex-direction:column;justify-content:safe center;gap:16px;padding:12px 16px;min-height:0;overflow-y:auto;outline:none}
.dk-kick{padding:0 8px;font-size:12px;font-weight:500;letter-spacing:.48px;text-transform:uppercase;color:var(--muted)}
.dk-say{padding:0 8px;font-weight:500;font-size:26px;line-height:1.2;letter-spacing:-.5px;color:var(--dk-ink2);text-wrap:pretty;white-space:pre-line}
.dk-say.small{font-size:20px;line-height:1.3;letter-spacing:-.2px}
.dk-say.hero{font-size:38px;line-height:1.1;letter-spacing:-1px}
.dk-say em{font-style:normal;font-weight:700;color:var(--accent)}
.dk-say code{font:500 .86em var(--mono);color:var(--ink);background:var(--well);border-radius:6px;padding:0 4px}
.dk-say.sub{font-size:16px;line-height:1.5;letter-spacing:0;color:var(--muted)}
.deck .fig{flex:none;width:100%;aspect-ratio:300/180;max-height:30vh;display:grid;place-items:center;overflow:hidden;padding:6px;border:1px solid var(--dk-line2);border-radius:24px;background:var(--panel)}
.deck .fig svg{height:100%}
.deck pre.dk-ex{flex:none;margin:0;max-height:34vh;overflow:auto;padding:18px 20px;border:1px solid var(--dk-line2);border-radius:24px;background:var(--panel);font:12.5px/1.65 var(--mono);color:var(--dk-ink2);white-space:pre;font-variant-ligatures:none}
.dk-ex .c{color:var(--muted)}
.dk-card{flex:none;min-width:0;border:1px solid var(--dk-line2);border-radius:24px;background:var(--panel)}
.dk-card.tree{padding:6px 10px}.dk-card.tree>div:last-child:not([hidden]){padding:8px;display:flex;flex-direction:column;gap:6px}
.dk-lines{list-style:none;margin:0;padding:0 20px}
.dk-lines li{display:grid;grid-template-columns:28px 1fr auto;gap:10px;align-items:center;min-height:56px;padding:8px 0;border-top:1px solid var(--dk-line2);font-size:16px;font-weight:500;line-height:1.3}
.dk-lines li:first-child{border-top:0}.dk-lines li>div{min-width:0}
.dk-n{width:24px;height:24px;border-radius:50%;background:var(--soft);color:var(--accent);font-size:11.5px;font-weight:700;display:grid;place-items:center;font-variant-numeric:tabular-nums}
.dk-dot li{grid-template-columns:1fr auto}
.dk-lines small{display:block;margin-top:2px;font:400 13px/1.45 var(--font);color:var(--muted)}
.dk-lines a{color:inherit;text-decoration-color:var(--accent);text-underline-offset:3px}
.dk-tag{font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:4px 8px;border-radius:99px;white-space:nowrap;background:var(--soft)}
.dk-tag.ok{background:var(--dk-okbg);color:var(--ok)}.dk-tag.no{background:none;border:1px dashed var(--line);color:var(--muted)}
.dk-recap{display:flex;flex-wrap:wrap;gap:6px;padding:0 4px}
.deck .dk-recap button{min-width:44px;min-height:44px;padding:0 14px;border-radius:24px;border:1px solid var(--dk-line2);background:var(--panel);font-size:15px;font-variant-numeric:tabular-nums}
.dk-bottom{flex:none;padding:8px 16px calc(16px + env(safe-area-inset-bottom,0px))}
.deck .dk-go{width:100%;min-height:56px;border-radius:16px;background:var(--accent);color:var(--on-accent);display:grid;grid-template-columns:1fr auto;align-items:center;gap:12px;padding:8px 20px;text-align:left;transition:transform .08s}
.dk-go b{display:block;font-size:17px;font-weight:600}.dk-go small{display:block;margin-top:2px;font-size:12.5px;color:inherit;opacity:.8}
.dk-go svg{width:20px;height:20px;transition:transform .2s}.dk-go:hover svg{transform:translateX(3px)}.dk-go:active{transform:scale(.985)}
.dk-hint{margin-top:10px;text-align:center;font-size:12px;color:var(--muted)}
@media (prefers-reduced-motion:no-preference){.dk-in>*{animation:dk-rise .42s cubic-bezier(.2,.8,.2,1) both}
.dk-in>:nth-child(2){animation-delay:.06s}.dk-in>:nth-child(3){animation-delay:.12s}.dk-in>:nth-child(4){animation-delay:.18s}.dk-in>:nth-child(5){animation-delay:.24s}}
@keyframes dk-rise{from{opacity:.001;transform:translateY(12px)}to{opacity:1;transform:none}}
@media (max-height:680px){.deck .fig{max-height:24vh}.deck pre.dk-ex{max-height:26vh}.dk-say{font-size:22px}.dk-say.hero{font-size:32px}}`;
    const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h15M13 6l6 6-6 6"/></svg>';
    const BACK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>';
    const make = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    };
    // `code` and *accent* in words that are otherwise text.
    const marked = (e, s) => {
      for (const bit of String(s ?? "").split(/(`[^`\n]+`|\*[^*\n]+\*)/)) {
        if (/^`.+`$/.test(bit)) e.append(make("code", "", bit.slice(1, -1)));
        else if (/^\*.+\*$/.test(bit)) e.append(make("em", "", bit.slice(1, -1)));
        else if (bit) e.append(bit);
      }
      return e;
    };
    const web = (u) => /^https?:\/\//i.test(String(u || ""));

    function deck(host, { title = "", screens = [], sources = [] } = {}) {
      if (!document.getElementById("parts-deck")) document.head.append(Object.assign(make("style", ""), { id: "parts-deck", textContent: DECK_CSS }));
      host.classList.add("deck");
      host.innerHTML = `<div class="dk-app"><header class="dk-top"><button type="button" class="dk-back" aria-label="Previous screen">${BACK}</button><div class="dk-ttl"><b></b><span aria-live="polite"></span></div><span></span></header><div class="dk-sq" role="slider" tabindex="0" aria-label="Screen" aria-valuemin="1"></div><div class="dk-screen" tabindex="-1"></div><div class="dk-bottom"><button type="button" class="dk-go"><span><b></b><small></small></span>${ARROW}</button><div class="dk-hint">Swipe, or use the arrow keys</div></div></div>`;
      const $ = (sel) => host.querySelector(sel), screen = $(".dk-screen"), squares = $(".dk-sq");
      /** The screen the address names (#s3 is the third), else null. */
      const hashScreen = () => {
        const m = /^#s(\d+)$/.exec((typeof location !== "undefined" && location.hash) || "");
        return m ? +m[1] - 1 : null;
      };
      let all = [], at = hashScreen() ?? 0;

      function lines(s) {
        const card = make("div", "dk-card"), ul = make("ul", "dk-lines" + (s.numbered ? "" : " dk-dot"));
        s.lines.forEach((l, n) => {
          const li = make("li"), body = make("div");
          if (s.numbered) li.append(make("span", "dk-n", String(n + 1).padStart(2, "0")));
          li.append(body);
          if (web(l.url)) body.append(Object.assign(make("a", "", l.text), { href: l.url, target: "_blank", rel: "noopener" }));
          else marked(body, l.text);
          if (l.note) body.append(make("small", "", l.note));
          li.append(l.tag ? make("span", "dk-tag " + (l.tone || ""), l.tag) : make("span"));
          ul.append(li);
        });
        card.append(ul);
        return card;
      }

      function show(i, focus) {
        $(".dk-bottom").hidden = $(".dk-back").hidden = !all.length;
        if (!all.length) return screen.replaceChildren(make("p", "empty", "No screens yet. Ask the agent to write them."));
        at = i = Math.min(Math.max(i, 0), all.length - 1);
        const s = all[i], last = i === all.length - 1, end = last && all.length > 2, hero = i === 0 && all.length > 1;
        const parts = [make("div", "dk-kick", s.kicker || "")];
        if (s.figure) parts.push(figure(s.figure));
        if (s.code) {
          const pre = make("pre", "dk-ex");
          for (const line of String(s.code).split("\n")) pre.append(/^\s*(#|\/\/)/.test(line) ? make("span", "c", line) : line, "\n");
          parts.push(pre);
        }
        const busy = s.figure || s.code || s.lines?.length || s.tree?.length || String(s.text || "").length > 150;
        parts.push(marked(make("p", "dk-say" + (hero ? " hero" : busy ? " small" : "")), s.text));
        if (s.sub) parts.push(marked(make("p", "dk-say sub"), s.sub));
        if (s.tree?.length) {
          const t = tree(s.tree);
          t.classList.add("dk-card");
          for (const d of t.querySelectorAll("details")) d.open = true; // a deck's tree is small: show every file
          parts.push(t);
        }
        if (s.lines?.length) parts.push(lines(s));
        if (end) {
          const recap = make("div", "dk-recap");
          all.forEach((o, n) => {
            if (n === i) return;
            const b = make("button", "", String(n + 1));
            b.type = "button";
            b.setAttribute("aria-label", `Back to screen ${n + 1}: ${o.kicker || o.text}`);
            b.onclick = () => show(n, true);
            recap.append(b);
          });
          parts.push(recap);
          const cited = (sources || []).filter((c) => c && c.title);
          if (cited.length) parts.push(make("div", "dk-kick", "Sources"), lines({ lines: cited.map((c) => ({ text: c.title, note: c.note, url: c.url })) }));
        }
        screen.replaceChildren(...parts);
        screen.classList.remove("dk-in");
        if (!squares.classList.contains("held")) {
          void screen.offsetWidth;
          screen.classList.add("dk-in");
        }
        [...squares.children].forEach((q, n) => {
          q.className = n < i ? "was" : n === i ? "now" : "";
        });
        squares.setAttribute("aria-valuemax", all.length);
        squares.setAttribute("aria-valuenow", i + 1);
        squares.setAttribute("aria-valuetext", `Screen ${i + 1} of ${all.length}: ${s.kicker || s.text}`);
        $(".dk-ttl b").textContent = title;
        $(".dk-ttl span").textContent = `${i + 1} of ${all.length}`;
        $(".dk-back").disabled = i === 0;
        $(".dk-go b").textContent = last ? "Start over" : i === 0 ? "Begin" : "Continue";
        $(".dk-go small").textContent = last ? "back to screen 1" : `next · ${String(all[i + 1].kicker || "").toLowerCase()}`.replace(/ · $/, "");
        $(".dk-go").setAttribute("aria-label", last ? "Start over from the first screen" : `Continue to screen ${i + 2}`);
        $(".dk-hint").hidden = i > 1;
        screen.scrollTop = 0;
        try {
          history.replaceState(null, "", "#s" + (i + 1));
        } catch {}
        if (focus) screen.focus({ preventScroll: true });
      }

      $(".dk-go").onclick = () => show(at === all.length - 1 ? 0 : at + 1);
      $(".dk-back").onclick = () => show(at - 1);
      document.addEventListener("keydown", (e) => {
        const t = e.target?.closest?.("input, textarea, select") ? "field" : e.target?.closest?.("button, a, summary") ? "control" : "";
        if (!host.isConnected || t === "field" || (t === "control" && e.key === " ")) return;
        if (e.key === "ArrowRight" || e.key === " ") {
          e.preventDefault();
          show(at + 1);
        }
        if (e.key === "ArrowLeft") show(at - 1);
      });
      // The marks are one slider: tap a mark, or slide along them, to go to that screen.
      const markAt = (x) => {
        const centres = [...squares.children].map((q) => {
          const r = q.getBoundingClientRect();
          return r.left + r.width / 2;
        });
        let best = 0;
        centres.forEach((c, n) => {
          if (Math.abs(x - c) < Math.abs(x - centres[best])) best = n;
        });
        return best;
      };
      const go = (e) => {
        const n = markAt(e.clientX);
        if (n !== at) show(n);
      };
      squares.addEventListener("pointerdown", (e) => {
        if (!all.length) return;
        squares.setPointerCapture?.(e.pointerId);
        squares.classList.add("held");
        go(e);
      });
      squares.addEventListener("pointermove", (e) => {
        if (squares.classList.contains("held")) go(e);
      });
      for (const ev of ["pointerup", "pointercancel"]) squares.addEventListener(ev, () => squares.classList.remove("held"));
      squares.addEventListener("keydown", (e) => {
        if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          show(e.key === "Home" ? 0 : all.length - 1);
        }
      });
      addEventListener("hashchange", () => {
        const n = hashScreen();
        if (n !== null && n !== at) show(n);
      });
      let x0 = null, y0 = 0;
      screen.addEventListener("touchstart", (e) => ([x0, y0] = [e.touches[0].clientX, e.touches[0].clientY]), { passive: true });
      screen.addEventListener("touchend", (e) => {
        if (x0 == null) return;
        const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
        x0 = null;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) show(at + (dx < 0 ? 1 : -1));
      }, { passive: true });

      // Draw the deck from new screens, keeping the screen shown.
      return (next) => {
        ({ title = title, screens = [], sources = [] } = next || {});
        all = (screens || []).filter((s) => s && (s.text || s.kicker));
        squares.replaceChildren(...all.map(() => make("i")));
        show(at);
      };
    }

    return { kinds, figure, tree, deck };
  })();
