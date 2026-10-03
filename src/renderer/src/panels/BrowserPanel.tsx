import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import type { SavedLogin } from '../../../shared/types';
import {
  CANCEL_LOGIN_SCRIPT,
  DRAIN_LOGIN_SCRIPT,
  WATCH_LOGIN_SCRIPT,
  autofillScript
} from '../browser/loginScripts';


// Runs inside the webview. Resolves with the picked element payload (or null
// on Escape). The host awaits the executeJavaScript promise — no IPC bridge
// or window.postMessage hopping required.
const PICKER_SCRIPT = `
new Promise((resolveFn) => {
  // A picker left over from a previous invocation has to be torn down, not
  // just refused — bailing out early used to leave its overlay on the page
  // with nothing able to remove it.
  if (window.__odPickerActive && window.__odPickerCancel) window.__odPickerCancel();
  window.__odPickerActive = true;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;pointer-events:auto;';
  const hi = document.createElement('div');
  hi.style.cssText = 'position:fixed;border:2px solid #1177bb;background:rgba(17,119,187,0.15);pointer-events:none;z-index:2147483647;';
  const banner = document.createElement('div');
  banner.textContent = 'Pick mode — click any element, or click Pick again to cancel';
  banner.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1177bb;color:white;padding:6px 14px;border-radius:4px;font:13px -apple-system,sans-serif;pointer-events:none;';
  document.body.appendChild(overlay);
  document.body.appendChild(hi);
  document.body.appendChild(banner);
  let target = null;
  function cssPath(el) {
    if (!(el instanceof Element)) return '';
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 8) {
      let sel = el.nodeName.toLowerCase();
      if (el.id) { sel += '#' + el.id; parts.unshift(sel); break; }
      if (el.className && typeof el.className === 'string') sel += '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.');
      parts.unshift(sel);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }
  function cleanup() {
    window.__odPickerActive = false;
    window.__odPickerCancel = null;
    overlay.remove(); hi.remove(); banner.remove();
    document.removeEventListener('keydown', onKey, true);
  }
  // The host calls this to exit pick mode from its own toolbar. Escape only
  // fires when the guest page has keyboard focus, which it does not after a
  // click on the IDE's chrome — so the host needs a way in that isn't a key.
  window.__odPickerCancel = function () { cleanup(); resolveFn(null); };
  function move(e) {
    overlay.style.pointerEvents = 'none';
    const t = document.elementFromPoint(e.clientX, e.clientY);
    overlay.style.pointerEvents = 'auto';
    if (!t) return;
    target = t;
    const r = t.getBoundingClientRect();
    hi.style.left = r.left + 'px'; hi.style.top = r.top + 'px';
    hi.style.width = r.width + 'px'; hi.style.height = r.height + 'px';
  }
  function pick(e) {
    e.preventDefault(); e.stopPropagation();
    if (!target) { cleanup(); resolveFn(null); return; }
    const r = target.getBoundingClientRect();
    const cs = getComputedStyle(target);
    const styles = {};
    for (const k of ['display','color','backgroundColor','fontSize','fontWeight','width','height','padding','margin','border','borderRadius','textAlign']) styles[k] = cs[k];
    const payload = {
      cssPath: cssPath(target),
      outerHTML: target.outerHTML.slice(0, 2000),
      styles,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height }
    };
    cleanup();
    resolveFn(payload);
  }
  function onKey(e) {
    if (e.key === 'Escape') { cleanup(); resolveFn(null); }
  }
  overlay.addEventListener('mousemove', move, true);
  overlay.addEventListener('click', pick, true);
  document.addEventListener('keydown', onKey, true);
})
`;

// Tears down an in-flight picker from the host side, resolving its pending
// promise with null. Returns false when no picker was up (page navigated away,
// script never ran) so the host can still drop out of pick mode.
const CANCEL_SCRIPT = `(function () {
  if (window.__odPickerCancel) { window.__odPickerCancel(); return true; }
  return false;
})()`;

// Device viewport presets. `null` width = full bleed (the desktop default),
// otherwise we render the webview at a fixed pixel size inside a scrollable
// stage. Sizes match the device's CSS pixels — same numbers Chrome DevTools
// uses for its Device Toolbar.
type DevicePreset = {
  id: string;
  label: string;
  width: number | null;
  height: number | null;
  scale?: number; // for high-DPI hinting in the title bar; not applied to the CSS
};
const DEVICE_PRESETS: DevicePreset[] = [
  { id: 'desktop',       label: 'Desktop (full)',     width: null, height: null },
  { id: 'desktop-1440',  label: 'Desktop 1440×900',   width: 1440, height: 900 },
  { id: 'desktop-1280',  label: 'Laptop 1280×800',    width: 1280, height: 800 },
  { id: 'ipad-pro',      label: 'iPad Pro 1024×1366', width: 1024, height: 1366 },
  { id: 'ipad',          label: 'iPad 820×1180',      width: 820,  height: 1180 },
  { id: 'iphone-14-pro-max', label: 'iPhone 14 Pro Max 430×932', width: 430, height: 932, scale: 3 },
  { id: 'iphone-14-pro', label: 'iPhone 14 Pro 393×852', width: 393, height: 852, scale: 3 },
  { id: 'iphone-se',     label: 'iPhone SE 375×667',  width: 375,  height: 667, scale: 2 },
  { id: 'pixel-7',       label: 'Pixel 7 412×915',    width: 412,  height: 915, scale: 2.625 },
  { id: 'galaxy-s8',     label: 'Galaxy S8+ 360×740', width: 360,  height: 740, scale: 4 }
];

/** Same origin key the main-process credential store uses. */
function originOf(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch { return null; }
}

type LoginCapture = { url: string; username: string; password: string };

export function BrowserPanel({ initialUrl, onNavigate }: { initialUrl?: string; onNavigate?: (u: string) => void }) {
  // The webview's `src` is only its first page. Changing the attribute later
  // starts a navigation of its own, so every later load goes through
  // loadURL() — setting both used to fire two navigations per Go, the second
  // aborting the first, which is where the blank flashes came from.
  const [url, setUrl] = useState(initialUrl || 'about:blank');
  const [input, setInput] = useState(initialUrl || '');
  const inputFocused = useRef(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<{ url: string; code: number; description: string } | null>(null);
  const [presetId, setPresetId] = useState<string>('desktop');
  const [rotated, setRotated] = useState(false);
  const wvRef = useRef<any>(null);
  const showToast = useStore(s => s.showToast);
  const addAttachment = useStore(s => s.addAttachment);

  const [picking, setPicking] = useState(false);

  // Password manager. Electron bundles none of Chromium's, so the panel
  // runs its own: watch the page for a login going out, offer to save it,
  // and fill it back in on the next visit.
  const [pageUrl, setPageUrl] = useState(initialUrl || '');
  const [savePrompt, setSavePrompt] = useState<LoginCapture | null>(null);
  const [originLogins, setOriginLogins] = useState<SavedLogin[]>([]);
  const [showLogins, setShowLogins] = useState(false);
  const [noEncryption, setNoEncryption] = useState(false);
  /** Invalidates a watcher promise once the page it was armed on is gone. */
  const watchToken = useRef(0);
  /** Captures the user waved off with "Not now", so we stop re-asking. */
  const dismissed = useRef(new Set<string>());
  const preset = DEVICE_PRESETS.find(p => p.id === presetId) ?? DEVICE_PRESETS[0];
  const isFullSize = preset.width == null;
  const vw = !isFullSize ? (rotated ? preset.height! : preset.width!) : null;
  const vh = !isFullSize ? (rotated ? preset.width! : preset.height!) : null;

  useEffect(() => {
    if (!initialUrl) return;
    setInput(initialUrl);
    if (!loadInWebview(initialUrl)) setUrl(initialUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUrl]);

  /** Navigate the live webview. False before it is attached (no dom-ready yet). */
  function loadInWebview(to: string): boolean {
    const wv = wvRef.current;
    try {
      if (!wv?.getWebContentsId?.()) return false;
      setLoadError(null);
      wv.loadURL(to).catch(() => { /* reported through did-fail-load */ });
      return true;
    } catch { return false; }
  }

  // Loading + failure state. Without it a refused connection (a dev server
  // mid-restart, the usual case) is just a white page with no hint whether
  // anything is still happening.
  useEffect(() => {
    const wv = wvRef.current;
    if (!wv) return;
    const onStart = () => { setLoading(true); setLoadError(null); };
    const onStop = () => setLoading(false);
    const onFail = (e: any) => {
      // -3 is ERR_ABORTED: a navigation superseded by another, not a failure.
      if (!e.isMainFrame || e.errorCode === -3) return;
      setLoading(false);
      setLoadError({ url: e.validatedURL || wv.getURL?.() || '', code: e.errorCode, description: e.errorDescription || 'Load failed' });
    };
    wv.addEventListener('did-start-loading', onStart);
    wv.addEventListener('did-stop-loading', onStop);
    wv.addEventListener('did-fail-load', onFail);
    return () => {
      wv.removeEventListener('did-start-loading', onStart);
      wv.removeEventListener('did-stop-loading', onStop);
      wv.removeEventListener('did-fail-load', onFail);
    };
  }, []);

  const reload = () => {
    const wv = wvRef.current;
    if (!wv) return;
    if (loading) { try { wv.stop(); } catch { /* not attached */ } return; }
    // After a failed load the webview sits on an error page, so reload()
    // would just re-show it; go back to the address that failed instead.
    if (loadError?.url) { loadInWebview(loadError.url); return; }
    try { wv.reload(); } catch { /* not attached */ }
  };

  // No event-listener bridge anymore — the picker is invoked via
  // executeJavaScript and its Promise resolves with the picked payload
  // directly. See `pick()` below.

  useEffect(() => {
    window.opendev.passwords.status()
      .then(s => setNoEncryption(!s.encryptionAvailable))
      .catch(() => {});
  }, []);

  const refreshOriginLogins = async (forUrl: string) => {
    const origin = originOf(forUrl);
    if (!origin) { setOriginLogins([]); return; }
    try {
      const all = await window.opendev.passwords.list();
      setOriginLogins(all.filter(l => l.origin === origin));
    } catch { setOriginLogins([]); }
  };

  // Only ask about a login that is actually new — re-signing in with the
  // same credentials should be silent.
  const captureKey = (c: LoginCapture) => `${originOf(c.url)}|${c.username}|${c.password}`;

  const offerToSave = async (capture: LoginCapture) => {
    if (!capture?.password) return;
    const origin = originOf(capture.url);
    if (!origin) return;
    if (dismissed.current.has(captureKey(capture))) return;
    try {
      const status = await window.opendev.passwords.status();
      if (status.neverSave.includes(origin)) return;
      const existing = await window.opendev.passwords.forOrigin(capture.url);
      if (existing.some(e => e.username === capture.username && e.password === capture.password)) return;
    } catch { /* fall through and ask anyway */ }
    setSavePrompt(capture);
  };

  const fillCredential = async (id: string) => {
    const wv = wvRef.current;
    if (!wv?.executeJavaScript) return;
    const creds = await window.opendev.passwords.forOrigin(wv.getURL?.() || pageUrl).catch(() => []);
    const hit = creds.find(c => c.id === id);
    if (!hit) { showToast('That saved login could not be decrypted.', 3000); return; }
    const ok = await wv.executeJavaScript(autofillScript(hit.username, hit.password)).catch(() => false);
    showToast(ok ? `Filled ${hit.username}` : 'No sign-in form found on this page.', 2000);
  };

  useEffect(() => {
    const wv = wvRef.current;
    if (!wv?.addEventListener) return;

    const armWatcher = () => {
      const token = ++watchToken.current;
      wv.executeJavaScript(WATCH_LOGIN_SCRIPT)
        .then((res: LoginCapture | null) => {
          // A newer page armed its own watcher; this one is stale.
          if (token !== watchToken.current) return;
          if (!res?.password) return;
          offerToSave(res);
          // The watcher fires once. Re-arm so a corrected retry on the same
          // page is seen too.
          armWatcher();
        })
        .catch(() => { /* frame torn down mid-navigation */ });
    };

    const onDomReady = async () => {
      const url: string = wv.getURL?.() || '';
      setPageUrl(url);
      // A classic form POST destroys the frame before the watcher's promise
      // can get home, so the capture is parked in sessionStorage first.
      const parked: LoginCapture | null = await wv.executeJavaScript(DRAIN_LOGIN_SCRIPT).catch(() => null);
      await refreshOriginLogins(url);
      if (parked?.password) {
        await offerToSave({ ...parked, url: parked.url || url });
      } else {
        // One saved login fills itself; several wait behind the key button
        // so we never guess which account was meant.
        const creds = await window.opendev.passwords.forOrigin(url).catch(() => []);
        if (creds.length === 1) {
          await wv.executeJavaScript(autofillScript(creds[0].username, creds[0].password)).catch(() => {});
        }
      }
      armWatcher();
    };

    const onNavigated = () => {
      const url: string = wv.getURL?.() || '';
      // Leaving the site drops a prompt that no longer has anywhere to go.
      setSavePrompt(prev => (prev && originOf(prev.url) !== originOf(url) ? null : prev));
      setShowLogins(false);
      setPageUrl(url);
      // Follow link clicks and redirects in the address bar, but never
      // overwrite what the user is in the middle of typing.
      if (url && !inputFocused.current) setInput(url);
      refreshOriginLogins(url);
    };

    wv.addEventListener('dom-ready', onDomReady);
    wv.addEventListener('did-navigate', onNavigated);
    wv.addEventListener('did-navigate-in-page', onNavigated);
    return () => {
      watchToken.current++;
      try { wv.executeJavaScript(CANCEL_LOGIN_SCRIPT).catch(() => {}); } catch { /* gone */ }
      wv.removeEventListener('dom-ready', onDomReady);
      wv.removeEventListener('did-navigate', onNavigated);
      wv.removeEventListener('did-navigate-in-page', onNavigated);
    };
    // Bound once to the webview element, which keeps its identity for the
    // life of the panel (see the note on the single-tree render below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigate = (to?: string) => {
    const target = to ?? input;
    if (!target) return;
    const full = /^https?:|^about:|^file:/.test(target) ? target : `http://${target}`;
    setInput(full);
    onNavigate?.(full);
    if (!loadInWebview(full)) setUrl(full);
  };

  const pick = async () => {
    const wv = wvRef.current;
    if (!wv?.executeJavaScript) return;

    // Second click on Pick = get out. Escape alone was not enough: the key
    // listener lives in the guest page, so it never fires while focus is on
    // the IDE's own chrome — which is exactly where it is after clicking Pick.
    if (picking) {
      // Cancelling resolves the pending PICKER_SCRIPT promise, and that path
      // already reports "Pick cancelled" — don't toast twice.
      try { await wv.executeJavaScript(CANCEL_SCRIPT); } catch { /* page gone */ }
      setPicking(false);
      return;
    }

    setPicking(true);
    // Give the guest page focus so Escape works too, for anyone who reaches
    // for it first.
    try { wv.focus?.(); } catch { /* not attached yet */ }
    showToast('Click any element in the browser — or click Pick again to cancel');
    let picked: any = null;
    try {
      picked = await wv.executeJavaScript(PICKER_SCRIPT);
    } catch (e: any) {
      console.error('picker failed', e);
      showToast(`Picker failed: ${e?.message || e}`, 4000);
      return;
    } finally {
      setPicking(false);
    }
    if (!picked) {
      showToast('Pick cancelled.', 1500);
      return;
    }
    let shot: string | undefined;
    try {
      shot = (await window.opendev.browser.screenshot(picked.rect)) || undefined;
    } catch {}
    addAttachment({
      kind: 'picked-element',
      cssPath: picked.cssPath,
      outerHTML: picked.outerHTML,
      styles: picked.styles,
      screenshotDataUrl: shot
    });
    showToast(`Element attached — type your instruction in chat`);
    // Ensure an AI chat tab is open in the center (and focused) so the
    // attachment lands somewhere visible. focusIfOpen=true means we reuse
    // an existing chat instead of stacking new ones.
    useStore.getState().openAiChatTab({ focusIfOpen: true });
    window.dispatchEvent(new Event('opendev:focus-chat'));
  };

  return (
    <div className="panel">
      <div className="url-bar">
        <button onClick={() => wvRef.current?.goBack?.()}>◀</button>
        <button onClick={() => wvRef.current?.goForward?.()}>▶</button>
        <button onClick={reload} title={loading ? 'Stop loading' : 'Reload'}>{loading ? '✕' : '↻'}</button>
        <input
          value={input}
          onFocus={() => { inputFocused.current = true; }}
          onBlur={() => { inputFocused.current = false; }}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && navigate()}
          placeholder="http://localhost:3000"
        />
        <button onClick={() => navigate()}>Go</button>
        <button
          className={picking ? 'picking' : undefined}
          title={picking ? 'Click again to leave pick mode' : 'Pick an element to attach to chat'}
          onClick={pick}
        >{picking ? 'Cancel' : 'Pick'}</button>
        <button
          className={showLogins ? 'picking' : undefined}
          title={originLogins.length
            ? `${originLogins.length} saved login${originLogins.length > 1 ? 's' : ''} for this site`
            : 'Saved logins'}
          onClick={() => setShowLogins(v => !v)}
        >🔑{originLogins.length > 1 ? ` ${originLogins.length}` : ''}</button>
        <select
          className="device-select"
          value={presetId}
          onChange={(e) => setPresetId(e.target.value)}
          title="Viewport size"
        >
          {DEVICE_PRESETS.map(p => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        {!isFullSize && (
          <button onClick={() => setRotated(r => !r)} title="Rotate viewport">
            {rotated ? '⟲' : '⟳'}
          </button>
        )}
      </div>
      {showLogins && (
        <div className="pw-popover">
          {originLogins.length === 0 ? (
            <div className="pw-empty">
              No saved logins for {originOf(pageUrl) ?? 'this page'}.
            </div>
          ) : originLogins.map(l => (
            <div className="pw-row" key={l.id}>
              <span className="pw-user" title={l.origin}>{l.username || '(no username)'}</span>
              <button onClick={() => { fillCredential(l.id); setShowLogins(false); }}>Fill</button>
              <button
                className="pw-del"
                title="Forget this login"
                onClick={async () => {
                  await window.opendev.passwords.remove(l.id);
                  await refreshOriginLogins(pageUrl);
                  showToast('Login forgotten.', 1500);
                }}
              >Delete</button>
            </div>
          ))}
          {noEncryption && (
            <div className="pw-warn">
              This system offers no credential encryption, so new passwords can&apos;t be saved.
            </div>
          )}
        </div>
      )}

      {savePrompt && (
        <div className="pw-save-bar">
          <span className="pw-save-msg">
            Save the password for <b>{originOf(savePrompt.url)}</b>
            {savePrompt.username ? <> as <b>{savePrompt.username}</b></> : null}?
          </span>
          <span className="grow" />
          <button
            className="pw-primary"
            onClick={async () => {
              const r = await window.opendev.passwords.save(savePrompt);
              setSavePrompt(null);
              if (r.ok) {
                await refreshOriginLogins(savePrompt.url);
                showToast('Password saved.', 2000);
              } else {
                showToast(r.error || 'Could not save that password.', 4000);
              }
            }}
          >Save</button>
          <button
            onClick={() => { dismissed.current.add(captureKey(savePrompt)); setSavePrompt(null); }}
          >Not now</button>
          <button
            onClick={async () => {
              await window.opendev.passwords.neverSave(savePrompt.url);
              setSavePrompt(null);
              await refreshOriginLogins(savePrompt.url);
              showToast('This site will not be offered again.', 2500);
            }}
          >Never for this site</button>
        </div>
      )}

      {/* Single tree so the <webview> keeps its DOM identity across
          desktop ↔ device-emulation switches. Conditionally rendering two
          different parents would unmount/remount the webview, and the
          resulting WebContents teardown + re-attach crashes the renderer
          (reproed switching from Desktop to iPhone 14 Pro Max). */}
      <div className={isFullSize ? 'browser-viewport-full' : 'browser-stage'}>
        <div
          className="browser-frame"
          style={isFullSize
            ? { width: '100%', height: '100%', borderRadius: 0, boxShadow: 'none' }
            : { width: vw!, height: vh! }}
        >
          {!isFullSize && (
            <div className="browser-frame-label">
              {preset.label}{rotated ? ' (landscape)' : ''} · {vw}×{vh}
            </div>
          )}
          {loading && <div className="browser-progress" aria-hidden />}
          {loadError && (
            <div className="browser-error">
              <div className="browser-error-title">Can't load this page</div>
              <div className="browser-error-url">{loadError.url}</div>
              <div className="browser-error-code">{loadError.description} ({loadError.code})</div>
              <button onClick={() => loadInWebview(loadError.url)}>Try again</button>
            </div>
          )}
          <webview
            key="browser-webview"
            ref={wvRef}
            src={url}
            style={{ width: '100%', height: '100%', background: '#fff' }}
            {...({ allowpopups: 'true' } as Record<string, string>)}
          />
        </div>
      </div>
    </div>
  );
}
