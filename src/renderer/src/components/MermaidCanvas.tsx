import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { renderMermaid, themeSignature } from '../mermaid/render';
import { annotateSvg, buildSourceIndex, elementsForLine } from '../mermaid/sourceMap';

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const FIT_PADDING = 24;
/** Movement (px) past which a drag stops counting as a click. */
const DRAG_SLOP = 4;

type View = { scale: number; x: number; y: number };

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
const sameView = (a: View, b: View) =>
  Math.abs(a.scale - b.scale) < 0.005 && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;

type Props = {
  /** Mermaid source to draw. */
  code: string;
  /** Don't render while the tab is hidden — getBBox needs a laid-out SVG. */
  active: boolean;
  /** Source line to outline, e.g. the line the editor caret sits on. */
  highlightLine?: number | null;
  /** Fired when an element in the diagram is clicked. */
  onPick?: (line: number, label: string) => void;
  /** Fired when the diagram fails to parse, so the host can badge the tab. */
  onError?: (err: { message: string; line?: number } | null) => void;
  /** Extra controls rendered at the left of the canvas toolbar. */
  toolbarLeft?: ReactNode;
  /** Re-fit whenever this changes (e.g. switching git revisions). */
  fitKey?: string;
};

export function MermaidCanvas({
  code, active, highlightLine, onPick, onError, toolbarLeft, fitKey
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View>({ scale: 1, x: 0, y: 0 });
  const naturalRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const indexRef = useRef(buildSourceIndex(code));
  const needsFitRef = useRef(true);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  const [zoomPct, setZoomPct] = useState(100);
  const [error, setError] = useState<{ message: string; line?: number } | null>(null);
  const [rendering, setRendering] = useState(false);
  const [picked, setPicked] = useState<{ line: number; label: string } | null>(null);
  const [themeSig, setThemeSig] = useState(themeSignature);

  // Viewport history — every settled pan/zoom is one entry, walked with the
  // ← / → buttons. Applying a history entry must not push a new one, hence
  // the suppression flag.
  const histRef = useRef<View[]>([{ scale: 1, x: 0, y: 0 }]);
  const histIdxRef = useRef(0);
  const suppressRef = useRef(false);
  const commitTimer = useRef<ReturnType<typeof setTimeout>>();
  const [histState, setHistState] = useState({ idx: 0, len: 1 });

  const applyView = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const v = viewRef.current;
    stage.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
  }, []);

  const commitHistory = useCallback(() => {
    if (suppressRef.current) return;
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      const v = { ...viewRef.current };
      const hist = histRef.current;
      if (sameView(hist[histIdxRef.current], v)) return;
      // A new move after stepping back discards the forward entries.
      const next = hist.slice(0, histIdxRef.current + 1);
      next.push(v);
      // Keep the stack bounded; the oldest viewport is the least interesting.
      while (next.length > 50) next.shift();
      histRef.current = next;
      histIdxRef.current = next.length - 1;
      setHistState({ idx: histIdxRef.current, len: next.length });
    }, 400);
  }, []);

  const setView = useCallback((v: View, opts?: { record?: boolean }) => {
    viewRef.current = { scale: clampScale(v.scale), x: v.x, y: v.y };
    applyView();
    const pct = Math.round(viewRef.current.scale * 100);
    setZoomPct(prev => (prev === pct ? prev : pct));
    if (opts?.record !== false) commitHistory();
  }, [applyView, commitHistory]);

  const gotoHistory = useCallback((idx: number) => {
    const hist = histRef.current;
    if (idx < 0 || idx >= hist.length) return;
    suppressRef.current = true;
    if (commitTimer.current) clearTimeout(commitTimer.current);
    histIdxRef.current = idx;
    setView(hist[idx], { record: false });
    setHistState({ idx, len: hist.length });
    // Release after the commit debounce would have fired.
    setTimeout(() => { suppressRef.current = false; }, 450);
  }, [setView]);

  const fit = useCallback((record = true) => {
    const wrap = wrapRef.current;
    const { w, h } = naturalRef.current;
    if (!wrap || !w || !h) return;
    const cw = wrap.clientWidth, ch = wrap.clientHeight;
    const scale = clampScale(Math.min((cw - FIT_PADDING * 2) / w, (ch - FIT_PADDING * 2) / h, 2));
    setView({ scale, x: (cw - w * scale) / 2, y: (ch - h * scale) / 2 }, { record });
  }, [setView]);

  const zoomBy = useCallback((factor: number, originX?: number, originY?: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const v = viewRef.current;
    const next = clampScale(v.scale * factor);
    if (next === v.scale) return;
    const px = originX ?? wrap.clientWidth / 2;
    const py = originY ?? wrap.clientHeight / 2;
    const k = next / v.scale;
    setView({ scale: next, x: px - (px - v.x) * k, y: py - (py - v.y) * k });
  }, [setView]);

  const panBy = useCallback((dx: number, dy: number) => {
    const v = viewRef.current;
    setView({ scale: v.scale, x: v.x + dx, y: v.y + dy });
  }, [setView]);

  useEffect(() => () => { if (commitTimer.current) clearTimeout(commitTimer.current); }, []);

  // Theme changes need a full re-render — mermaid bakes colors into the SVG.
  useEffect(() => {
    const onSettings = () => setThemeSig(themeSignature());
    window.addEventListener('opendev:settings-changed', onSettings);
    return () => window.removeEventListener('opendev:settings-changed', onSettings);
  }, []);

  useEffect(() => { needsFitRef.current = true; }, [fitKey]);

  // Debounced render. Keeps the previous SVG on screen while the user types
  // so an in-progress edit doesn't flash the canvas empty.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setRendering(true);
    const t = setTimeout(async () => {
      const result = await renderMermaid(code);
      if (cancelled) return;
      setRendering(false);
      const stage = stageRef.current;
      if (!stage) return;
      if (!result.ok) {
        setError(result.error);
        onError?.(result.error);
        return;
      }
      setError(null);
      onError?.(null);
      stage.innerHTML = result.svg;
      const svg = stage.querySelector('svg');
      if (!svg) return;
      // Mermaid ships a responsive max-width; we size it ourselves so the
      // transform is the only thing that scales the drawing.
      svg.style.maxWidth = 'none';
      svg.style.display = 'block';
      const vb = svg.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
      let w = vb && vb.length === 4 ? vb[2] : 0;
      let h = vb && vb.length === 4 ? vb[3] : 0;
      if (!w || !h) {
        try { const b = (svg as SVGSVGElement).getBBox(); w = b.width; h = b.height; } catch { /* not laid out */ }
      }
      if (w && h) {
        svg.setAttribute('width', String(w));
        svg.setAttribute('height', String(h));
        naturalRef.current = { w, h };
      }
      indexRef.current = buildSourceIndex(code);
      annotateSvg(svg as SVGSVGElement, indexRef.current, result.renderId);
      if (needsFitRef.current) {
        needsFitRef.current = false;
        histRef.current = [{ ...viewRef.current }];
        histIdxRef.current = 0;
        fit(false);
        histRef.current = [{ ...viewRef.current }];
        setHistState({ idx: 0, len: 1 });
      } else {
        applyView();
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
    // onError/onPick are read through the latest render, not dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, active, themeSig]);

  // Fit once the pane first gets a size (a tab opened in the background has
  // zero width until it is shown).
  useLayoutEffect(() => {
    if (!active) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => {
      if (needsFitRef.current && naturalRef.current.w) fit(false);
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [active, fit]);

  // Source → diagram: outline whatever the caret's line drew.
  useEffect(() => {
    const stage = stageRef.current;
    const svg = stage?.querySelector('svg') as SVGSVGElement | null;
    if (!svg) return;
    for (const el of Array.from(svg.querySelectorAll('.mmd-sel'))) el.classList.remove('mmd-sel');
    if (highlightLine == null) return;
    for (const el of elementsForLine(svg, highlightLine)) el.classList.add('mmd-sel');
  }, [highlightLine, code, themeSig, rendering]);

  // Pan by dragging anywhere on the canvas; a drag that barely moves is
  // treated as a click on whatever was under the pointer.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, originX = 0, originY = 0;
    let pointerId = -1;

    const down = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 1) return;
      if (e.button === 1) e.preventDefault();
      dragging = true;
      moved = false;
      pointerId = e.pointerId;
      startX = e.clientX; startY = e.clientY;
      originX = viewRef.current.x; originY = viewRef.current.y;
      wrap.setPointerCapture(e.pointerId);
      wrap.classList.add('mmd-grabbing');
    };
    const move = (e: PointerEvent) => {
      if (!dragging || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
      moved = true;
      viewRef.current = { ...viewRef.current, x: originX + dx, y: originY + dy };
      applyView();
    };
    const up = (e: PointerEvent) => {
      if (!dragging || e.pointerId !== pointerId) return;
      dragging = false;
      wrap.classList.remove('mmd-grabbing');
      try { wrap.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
      if (moved) { commitHistory(); return; }
      const target = e.target as Element | null;
      const hit = target?.closest?.('[data-mmd-line]');
      if (!hit) { setPicked(null); return; }
      const line = Number(hit.getAttribute('data-mmd-line'));
      if (!Number.isFinite(line) || line < 1) return;
      const label = (hit.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
      setPicked({ line, label });
      onPickRef.current?.(line, label);
    };

    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      // Pinch on a trackpad arrives as ctrl+wheel; so does cmd/ctrl+scroll.
      if (e.ctrlKey || e.metaKey) {
        const rect = wrap.getBoundingClientRect();
        zoomBy(Math.exp(-e.deltaY / 300), e.clientX - rect.left, e.clientY - rect.top);
        return;
      }
      if (e.shiftKey) panBy(-(e.deltaY || e.deltaX), 0);
      else panBy(-e.deltaX, -e.deltaY);
    };

    wrap.addEventListener('pointerdown', down);
    wrap.addEventListener('pointermove', move);
    wrap.addEventListener('pointerup', up);
    wrap.addEventListener('pointercancel', up);
    wrap.addEventListener('wheel', wheel, { passive: false });
    return () => {
      wrap.removeEventListener('pointerdown', down);
      wrap.removeEventListener('pointermove', move);
      wrap.removeEventListener('pointerup', up);
      wrap.removeEventListener('pointercancel', up);
      wrap.removeEventListener('wheel', wheel);
    };
  }, [applyView, commitHistory, panBy, zoomBy]);


  const onKeyDown = (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 200 : 60;
    switch (e.key) {
      case '+': case '=': zoomBy(1.2); break;
      case '-': case '_': zoomBy(1 / 1.2); break;
      case '0': fit(); break;
      case '1': setView({ scale: 1, x: viewRef.current.x, y: viewRef.current.y }); break;
      case 'ArrowLeft': panBy(step, 0); break;
      case 'ArrowRight': panBy(-step, 0); break;
      case 'ArrowUp': panBy(0, step); break;
      case 'ArrowDown': panBy(0, -step); break;
      default: return;
    }
    e.preventDefault();
  };

  return (
    <div className="mmd-canvas-root">
      <div className="mmd-toolbar">
        {toolbarLeft}
        <span className="mmd-tb-grow" />
        <span className="mmd-tb-group" title="Viewport history">
          <button disabled={histState.idx <= 0} onClick={() => gotoHistory(histIdxRef.current - 1)}
            title="Previous view">←</button>
          <button disabled={histState.idx >= histState.len - 1} onClick={() => gotoHistory(histIdxRef.current + 1)}
            title="Next view">→</button>
        </span>
        <span className="mmd-tb-group">
          <button onClick={() => zoomBy(1 / 1.2)} title="Zoom out (−)">−</button>
          <span className="mmd-zoom-pct" title="Zoom level">{zoomPct}%</span>
          <button onClick={() => zoomBy(1.2)} title="Zoom in (+)">+</button>
        </span>
        <span className="mmd-tb-group">
          <button onClick={() => fit()} title="Fit to window (0)">Fit</button>
          <button onClick={() => setView({ scale: 1, x: viewRef.current.x, y: viewRef.current.y })}
            title="Actual size (1)">1:1</button>
        </span>
      </div>

      <div
        className="mmd-viewport"
        ref={wrapRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <div className="mmd-stage" ref={stageRef} />
        {error && (
          <div className="mmd-error">
            <div className="mmd-error-title">Diagram didn&apos;t parse</div>
            <pre className="mmd-error-msg">{error.message}</pre>
            {error.line != null && (
              <button onClick={() => onPickRef.current?.(error.line!, '')}>
                Go to line {error.line}
              </button>
            )}
          </div>
        )}
        {rendering && !error && <div className="mmd-spinner">rendering…</div>}
      </div>

      <div className="mmd-statusbar">
        {picked
          ? <span className="mmd-picked">line {picked.line}{picked.label ? ` · ${picked.label}` : ''}</span>
          : <span className="mmd-hint">click an element to jump to its line · drag to pan · ⌘/ctrl+scroll to zoom</span>}
      </div>
    </div>
  );
}
