import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';


// Runs inside the webview. Resolves with the picked element payload (or null
// on Escape). The host awaits the executeJavaScript promise — no IPC bridge
// or window.postMessage hopping required.
const PICKER_SCRIPT = `
new Promise((resolveFn) => {
  if (window.__odPickerActive) { resolveFn(null); return; }
  window.__odPickerActive = true;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;pointer-events:auto;';
  const hi = document.createElement('div');
  hi.style.cssText = 'position:fixed;border:2px solid #1177bb;background:rgba(17,119,187,0.15);pointer-events:none;z-index:2147483647;';
  const banner = document.createElement('div');
  banner.textContent = 'Pick mode — click any element, Esc to cancel';
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
    overlay.remove(); hi.remove(); banner.remove();
    document.removeEventListener('keydown', onKey, true);
  }
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

export function BrowserPanel({ initialUrl, onNavigate }: { initialUrl?: string; onNavigate?: (u: string) => void }) {
  const [url, setUrl] = useState(initialUrl || 'about:blank');
  const [input, setInput] = useState(initialUrl || '');
  const [presetId, setPresetId] = useState<string>('desktop');
  const [rotated, setRotated] = useState(false);
  const wvRef = useRef<any>(null);
  const showToast = useStore(s => s.showToast);
  const addAttachment = useStore(s => s.addAttachment);

  const preset = DEVICE_PRESETS.find(p => p.id === presetId) ?? DEVICE_PRESETS[0];
  const isFullSize = preset.width == null;
  const vw = !isFullSize ? (rotated ? preset.height! : preset.width!) : null;
  const vh = !isFullSize ? (rotated ? preset.width! : preset.height!) : null;

  useEffect(() => {
    if (initialUrl) { setUrl(initialUrl); setInput(initialUrl); }
  }, [initialUrl]);

  // No event-listener bridge anymore — the picker is invoked via
  // executeJavaScript and its Promise resolves with the picked payload
  // directly. See `pick()` below.

  const navigate = (to?: string) => {
    const target = to ?? input;
    if (!target) return;
    const full = /^https?:|^about:|^file:/.test(target) ? target : `http://${target}`;
    setUrl(full); setInput(full);
    onNavigate?.(full);
    wvRef.current?.loadURL?.(full);
  };

  const pick = async () => {
    const wv = wvRef.current;
    if (!wv?.executeJavaScript) return;
    showToast('Click any element in the browser — Esc to cancel');
    let picked: any = null;
    try {
      picked = await wv.executeJavaScript(PICKER_SCRIPT);
    } catch (e: any) {
      console.error('picker failed', e);
      showToast(`Picker failed: ${e?.message || e}`, 4000);
      return;
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
        <button onClick={() => wvRef.current?.reload?.()}>↻</button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && navigate()}
          placeholder="http://localhost:3000"
        />
        <button onClick={() => navigate()}>Go</button>
        <button onClick={pick}>Pick</button>
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
