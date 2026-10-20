// motion.js: how an app page moves, a library a page names with <script src="motion.js"></script>
// after app.js. Parts and pages say what happened with App.cue(el, cue); this file alone decides
// whether and how that moves. Without it a cue does nothing.
//
//   done     a day marked, an item ticked          pop
//   added    a new item or entry                   rise
//   reveal   a card turned over                    flip
//   success  a right answer, a card known, a goal  cheer
//   miss     a wrong answer                        shake
//
// <html data-motion="calm"> keeps only success and miss; "off" none. Only the user's own taps move
// (a change from the agent or another tab never does), one motion per part at a time (the strongest),
// nothing on load, nothing for anyone who asks for reduced motion. A part draws again after a change
// and replaces what was tapped, so a cue goes to the element now in its place.
(() => {
  const MOTION = { done: "pop", added: "rise", reveal: "flip", success: "cheer", miss: "shake" };
  const CALM = ["success", "miss"];
  const STRONG = ["success", "miss"];
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  let touched = 0, part = null, queued = null;
  const touch = (e) => ((touched = Date.now()), (part = e.target?.closest?.("[data-part]") || document.body));
  addEventListener("pointerdown", touch, true);
  addEventListener("keydown", touch, true);
  const key = (el) => (el.getAttribute("aria-label") || el.dataset.ref || el.closest("label, li")?.textContent || el.textContent || "").trim();
  const scope = () => (part?.isConnected ? part : document.body);
  const standIn = (tag, k) => [...scope().querySelectorAll(tag)].find((x) => key(x) === k);
  // A part may draw again while a motion plays (when the save is confirmed): the motion moves to the
  // new element and goes on from where it was.
  function play(el, name) {
    const cls = "play-" + name, tag = el.tagName, k = key(el), start = performance.now();
    const on = (x, delay) => {
      x.classList.remove(cls);
      void x.offsetWidth; // so the same motion starts again
      x.style.animationDelay = delay ? -delay + "ms" : "";
      x.classList.add(cls);
      x.addEventListener("animationend", () => (x.classList.remove(cls), (x.style.animationDelay = ""), watch.disconnect()), { once: true });
    };
    const watch = new MutationObserver(() => {
      if (el.isConnected) return;
      el = standIn(tag, k);
      if (el) on(el, performance.now() - start);
    });
    watch.observe(scope(), { childList: true, subtree: true });
    setTimeout(() => watch.disconnect(), 800);
    on(el, 0);
  }
  App.oncue((el, cue) => {
    const mode = document.documentElement.dataset.motion || "lively";
    if (!el || !MOTION[cue] || mode === "off" || (mode === "calm" && !CALM.includes(cue)) || still.matches || Date.now() - touched > 1500) return;
    // the strongest cue of this frame wins
    if (queued && STRONG.includes(queued.cue) && !STRONG.includes(cue)) return;
    const first = !queued;
    queued = { el, cue };
    if (first) requestAnimationFrame(() => {
      const { el: target, cue: what } = queued;
      queued = null;
      const now = target.isConnected ? target : standIn(target.tagName, key(target));
      if (now) play(now, MOTION[what]);
    });
  });
})();
