// <webview> for the browser.
//
// BrowserPanel renders Electron's <webview> tag and drives it with loadURL /
// goBack / goForward / reload / executeJavaScript. An iframe covers all of
// that, but the wiring can't be a custom element: `customElements.define`
// rejects any name without a hyphen, and the tag in the JSX is `webview`. So
// we intercept document.createElement instead and upgrade the element React
// asks for — same effect, and BrowserPanel stays untouched.
//
// The one behaviour that can't be reproduced is executeJavaScript against a
// cross-origin page. Electron runs it inside the guest's own process; a
// browser iframe is walled off by the same-origin policy. Same-origin targets
// still work, and the element says so plainly when they don't.

const CROSS_ORIGIN_HINT =
  'Element picking needs same-origin access to the page. In the desktop app this always works; ' +
  'in the browser it only works for pages served from this origin.';

type WebViewEl = HTMLElement & {
  loadURL(url: string): void;
  getURL(): string;
  reload(): void;
  goBack(): void;
  goForward(): void;
  executeJavaScript(code: string): Promise<unknown>;
};

function upgrade(el: HTMLElement, createIframe: () => HTMLIFrameElement): void {
  const frame = createIframe();
  frame.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#fff';
  frame.setAttribute('allow', 'clipboard-read; clipboard-write');
  el.appendChild(frame);

  // React sets `src` as an attribute on unknown elements, so mirror it onto
  // the iframe whenever it changes. 'about:blank' is BrowserPanel's initial
  // value and means "nothing loaded yet".
  const sync = (): void => {
    const src = el.getAttribute('src');
    if (src && src !== 'about:blank' && frame.src !== src) frame.src = src;
  };
  new MutationObserver(sync).observe(el, { attributes: true, attributeFilter: ['src'] });
  sync();

  const historyGo = (delta: number): void => {
    try { frame.contentWindow?.history.go(delta); } catch { /* cross-origin */ }
  };

  Object.assign(el, {
    loadURL(url: string) { el.setAttribute('src', url); frame.src = url; },
    getURL: () => frame.src,
    reload() {
      try { frame.contentWindow?.location.reload(); }
      catch { frame.src = frame.src; } // cross-origin: re-assign to re-fetch
    },
    goBack: () => historyGo(-1),
    goForward: () => historyGo(1),
    async executeJavaScript(code: string) {
      const win = frame.contentWindow as (Window & { eval(c: string): unknown }) | null;
      if (!win) throw new Error('The browser panel has no page loaded.');
      // Touching a cross-origin document throws here, before the eval runs.
      try { void win.document; } catch { throw new Error(CROSS_ORIGIN_HINT); }
      return await win.eval(code);
    }
  } satisfies Omit<WebViewEl, keyof HTMLElement>);
}

export function installWebviewElement(): void {
  const native = document.createElement.bind(document);
  document.createElement = function (tagName: string, options?: ElementCreationOptions) {
    const el = native(tagName, options);
    if (String(tagName).toLowerCase() === 'webview') {
      upgrade(el as HTMLElement, () => native('iframe') as HTMLIFrameElement);
    }
    return el;
  } as typeof document.createElement;
}
