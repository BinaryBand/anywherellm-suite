// Stands in for the bundled puppeteer-core in the tests (BROWSER_LEAN_PUPPETEER points
// here): pages are plain objects whose fields are plain JS objects, so the skill's own
// handle.evaluate functions run on them, and a page's snapshot is answered as snapshot.ts would
// read it. `world` is what the tests set up and look at.
const fs = require("fs");

const world = (globalThis.__browserLeanWorld ||= { launched: [], pages: [], sites: {}, apis: {}, fetched: [], authenticators: [] });

/** A DevTools session: a page's, for its WebAuthn domain (each virtual authenticator keeps its
 *  credentials by id, and `emit` plays an event Chrome would send), or the browser's, for its cookies. */
class Session {
  constructor(browser) {
    this.browser = browser;
    this.handlers = {};
    this.credentials = new Map();
  }
  async detach() {}
  on(name, fn) {
    (this.handlers[name] ||= []).push(fn);
  }
  async emit(name, payload) {
    await Promise.all((this.handlers[name] || []).map((fn) => fn(payload)));
    await new Promise((resolve) => setTimeout(resolve, 50)); // what the skill does after, on its own
  }
  async send(method, params = {}) {
    if (method === "WebAuthn.enable") return {};
    if (method === "WebAuthn.addVirtualAuthenticator") {
      this.options = params.options;
      world.authenticators.push(this);
      return { authenticatorId: `auth-${world.authenticators.length}` };
    }
    if (method === "WebAuthn.addCredential") return void this.credentials.set(params.credential.credentialId, { ...params.credential });
    if (method === "WebAuthn.removeCredential") return void this.credentials.delete(params.credentialId);
    if (method === "Storage.getCookies") return { cookies: structuredClone(this.browser.cookies) };
    if (method === "Storage.setCookies") return void this.browser.cookies.push(...structuredClone(params.cookies));
    throw new Error(`the stand-in has no ${method}`);
  }
}

/** A site the stand-in browser opens: its title, text and fields by ref ({ kind, type, name, value,
 *  box: { x, y, w, h } where it shows }), where a click or Enter goes, and the links a search reads
 *  from it ([{ title, href, near }]). */
function site(url, { title = "", text = "", fields = {}, onclick = {}, onenter = null, links = [] } = {}) {
  world.sites[url] = { title, text, fields, onclick, onenter, links };
}

class Handle {
  constructor(page, ref) {
    this.page = page;
    this.ref = ref;
    this.el = page.fields[ref];
  }
  async click() {
    this.page.clicks.push(this.ref);
    const then = this.page.onclick[this.ref];
    if (then) await this.page.goto(then);
  }
  async type(text) {
    this.el.value = (this.el.value || "") + text;
  }
  async focus() {}
  async hover() {}
  async select(value) {
    this.el.value = value;
  }
  async evaluate(fn, ...args) {
    return fn(this.el, ...args);
  }
}

class Page {
  constructor() {
    this.closed = false;
    this.clicks = [];
    this.pressed = [];
    this.address = "about:blank";
    this.load({ title: "", text: "", fields: {}, onclick: {} });
    this.keyboard = {
      press: async (k) => {
        this.pressed.push(k);
        if (k === "Enter" && this.onenter) await this.goto(this.onenter);
      },
      down: async () => {},
      up: async () => {},
    };
    this.taps = [];
    this.wheels = [];
    this.navs = [];
    this.mouse = {
      click: async (x, y) => void this.taps.push([x, y]),
      wheel: async ({ deltaY }) => void this.wheels.push(deltaY),
    };
    this.session = null;
    world.pages.push(this);
  }
  load(s) {
    this.titleText = s.title;
    this.text = s.text;
    this.fields = JSON.parse(JSON.stringify(s.fields));
    // Each field as the skill's evaluate functions read it: its tag (an input when it has a type),
    // its attributes (`attrs`), and for a button whose form may not be sent while the fields
    // `blockedBy` (refs) are unmet, that form. A field `behind` a dialog ({ title, buttons: [{ ref,
    // label }] }) is inert under it, as a cookie dialog leaves the page; a date field takes only an
    // ISO date, as Chrome's does.
    for (const f of Object.values(this.fields)) {
      f.tagName = f.type ? "INPUT" : f.kind === "link" ? "A" : "BUTTON";
      f.getAttribute = (name) => f.attrs?.[name] ?? null;
      f.closest = (selector) => (f.behind && selector === "[inert]" ? {} : null);
      f.dispatchEvent = () => true;
      f.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10 });
      const dialogs = [];
      if (f.behind) {
        const { title, buttons } = f.behind;
        dialogs.push({
          closest: () => null,
          getClientRects: () => [{}],
          getAttribute: (name) => (name === "aria-label" ? title : null),
          querySelector: () => null,
          querySelectorAll: () => buttons.map((b) => ({ innerText: b.label, getAttribute: (name) => (name === "data-bw-ref" ? b.ref : null) })),
        });
      }
      f.ownerDocument = { querySelectorAll: () => dialogs, elementFromPoint: () => null };
      if (f.type === "date") {
        let value = f.value || "";
        Object.defineProperty(f, "value", { get: () => value, set: (v) => (value = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ""), enumerable: true });
      }
      if (f.blockedBy) {
        const blocking = f.blockedBy.map((ref) => ({ willValidate: true, checkValidity: () => false, labels: [{ innerText: this.fields[ref].name }], getAttribute: (n) => (n === "data-bw-ref" ? ref : null) }));
        f.form = { checkValidity: () => false, elements: blocking };
      }
    }
    this.onclick = s.onclick;
    this.onenter = s.onenter;
    this.links = s.links || [];
  }
  viewport() {
    return this.screen || { width: 430, height: 932, deviceScaleFactor: 2 };
  }
  async setViewport(screen) {
    this.screen = screen;
  }
  setDefaultTimeout() {}
  setDefaultNavigationTimeout() {}
  async setRequestInterception() {}
  mainFrame() {
    return this;
  }
  target() {
    return {
      createCDPSession: async () => (this.session = new Session(this.browser)),
    };
  }
  on() {}
  once() {}
  isClosed() {
    return this.closed;
  }
  async close() {
    this.closed = true;
  }
  url() {
    return this.address;
  }
  async title() {
    return this.titleText;
  }
  async goto(url) {
    const s = world.sites[url];
    if (!s) throw new Error(`net::ERR_NAME_NOT_RESOLVED at ${url}`);
    this.address = url;
    this.load(s);
  }
  async goBack() {
    this.navs.push("back");
  }
  async goForward() {}
  async reload() {
    this.navs.push("reload");
  }
  async waitForFunction() {}
  async evaluateHandle() {
    // The skill asks a page only for the focused element; nothing here has focus.
    return { evaluate: async (fn, ...args) => fn({ tagName: "BODY", getAttribute: () => null }, ...args) };
  }
  async $(selector) {
    const ref = selector.match(/data-bw-ref="(e\d+)"/)?.[1];
    return ref && this.fields[ref] ? new Handle(this, ref) : null;
  }
  async evaluate(fn, arg) {
    // A call's fetch from this page: answered from world.apis by address.
    if (arg && arg.url && arg.method) {
      world.fetched.push({ from: this.address, ...arg });
      return world.apis[arg.url] || { status: 404, headers: { "content-type": "text/plain" }, text: "not found", cut: false };
    }
    // Whether the page shows a password field.
    if (arg && arg.passwordField) return Object.values(this.fields).some((f) => f.type === "password");
    // A search's links, as research.ts reads them.
    if (arg && arg.links) return this.links;
    if (arg && arg.snapshot) {
      const elements = Object.entries(this.fields).map(([ref, f]) => {
        const line = `[${ref}] ${f.kind || `input[${f.type}]`} "${f.name || ""}"`;
        if (f.type === "password") return f.value ? `${line} (filled)` : line;
        return f.value ? `${line} value="${f.value}"` : line;
      });
      const fields = Object.entries(this.fields)
        .filter(([, f]) => f.box)
        .map(([ref, f]) => ({ ref, ...f.box, kind: f.type || "text", filled: !!f.value }));
      return { elements, text: this.text, more: false, fields };
    }
    throw new Error("the stand-in page evaluates only what the skill sends it");
  }
  async screenshot({ path, clip }) {
    fs.writeFileSync(path, clip ? "card" : "jpeg");
  }
}

class Browser {
  constructor(options) {
    this.options = options;
    this.closed = false;
    this.cookies = [];
  }
  on() {}
  target() {
    return { createCDPSession: async () => new Session(this) };
  }
  async newPage() {
    const page = new Page();
    page.browser = this;
    return page;
  }
  async close() {
    this.closed = true;
  }
}

async function launch(options) {
  const browser = new Browser(options);
  world.launched.push(browser);
  return browser;
}

module.exports = { launch, world, site };
