// What AnythingLLM and Puppeteer supply to the skill, as far as the skill uses them: the skill's own
// description, which the bundled puppeteer-core and the tests' stand-in for it both meet.

/** `this` in the handler, as AnythingLLM's agent sets it up. */
export interface HandlerContext {
  super?: {
    handlerProps?: { invocation?: { workspace?: { slug?: string } | null; thread_id?: number | null; uuid?: string | null } };
  };
  /** A line shown in the chat while the skill works. */
  introspect?: (message: string) => void;
  /** The skill's settings (plugin.json's setup_args), as the user set them in AnythingLLM. */
  runtimeArgs?: Record<string, string | undefined>;
  logger?: (message: string) => void;
}

export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

/** A DevTools Protocol session with a page, for its WebAuthn domain (passkey.ts). */
export interface CDPSession {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  on(event: string, fn: (payload: any) => void): unknown;
  detach(): Promise<void>;
}

/** An element on a page. `evaluate` runs `fn` in the page with the element. */
export interface ElementHandle {
  click(options?: { clickCount?: number }): Promise<void>;
  type(text: string, options?: { delay?: number }): Promise<void>;
  focus(): Promise<void>;
  hover(): Promise<void>;
  select(...values: string[]): Promise<unknown>;
  evaluate<T>(fn: (el: any, ...args: any[]) => T, ...args: unknown[]): Promise<Awaited<T>>;
}

export interface Request {
  url(): string;
  isNavigationRequest(): boolean;
  frame(): unknown;
  continue(): Promise<void>;
  abort(reason?: string): Promise<void>;
  isInterceptResolutionHandled?(): boolean;
}

export interface Dialog {
  type(): string;
  message(): string;
  accept(): Promise<void>;
  dismiss(): Promise<void>;
}

type Navigation = { waitUntil?: string; timeout?: number };

export interface Page {
  url(): string;
  title(): Promise<string>;
  goto(url: string, options?: Navigation): Promise<unknown>;
  goBack(options?: Navigation): Promise<unknown>;
  goForward(options?: Navigation): Promise<unknown>;
  reload(options?: Navigation): Promise<unknown>;
  evaluate<T>(fn: (...args: any[]) => T, ...args: unknown[]): Promise<Awaited<T>>;
  evaluateHandle(fn: () => unknown): Promise<ElementHandle>;
  waitForFunction(fn: () => boolean, options?: { timeout?: number }): Promise<unknown>;
  $(selector: string): Promise<ElementHandle | null>;
  screenshot(options: { path: string; type: "jpeg"; quality: number; clip?: { x: number; y: number; width: number; height: number; scale?: number } }): Promise<unknown>;
  viewport(): Viewport | null;
  setViewport(viewport: Viewport): Promise<void>;
  setDefaultTimeout(ms: number): void;
  setDefaultNavigationTimeout(ms: number): void;
  setRequestInterception(on: boolean): Promise<void>;
  mainFrame(): unknown;
  on(event: "request", fn: (request: Request) => void): unknown;
  on(event: "dialog", fn: (dialog: Dialog) => void): unknown;
  on(event: "popup", fn: (page: Page | null) => void): unknown;
  once(event: "close", fn: () => void): unknown;
  isClosed(): boolean;
  close(): Promise<void>;
  target(): { createCDPSession(): Promise<CDPSession> };
  mouse: { click(x: number, y: number): Promise<void>; wheel(delta: { deltaY: number }): Promise<void> };
  keyboard: { press(key: string): Promise<void>; down(key: string): Promise<void>; up(key: string): Promise<void> };
}

export interface Browser {
  newPage(): Promise<Page>;
  target(): { createCDPSession(): Promise<CDPSession> };
  close(): Promise<void>;
  on(event: "disconnected", fn: () => void): unknown;
}

export interface Puppeteer {
  launch(options: Record<string, unknown>): Promise<Browser>;
}
