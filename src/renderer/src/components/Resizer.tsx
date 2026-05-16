import { useEffect, useRef } from 'react';

type Props = {
  orientation: 'vertical' | 'horizontal'; // vertical = a column resizer (drag left/right); horizontal = drag up/down
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  invert?: boolean; // when true, dragging right/down decreases the value (used for the right column)
};

export function Resizer({ orientation, value, onChange, min = 100, max = 1200, invert = false }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef({ value, onChange, min, max, invert });
  stateRef.current = { value, onChange, min, max, invert };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let startPos = 0;
    let startVal = 0;
    let dragging = false;
    // Full-window scrim added during a drag. The browser webview and any
    // other native child surface (xterm, etc.) swallow mouse events when the
    // cursor passes over them — without this overlay, mouseup never reaches
    // us and the resizer gets stuck following the cursor forever.
    let scrim: HTMLDivElement | null = null;

    const teardown = () => {
      dragging = false;
      document.body.style.userSelect = '';
      if (scrim) {
        scrim.removeEventListener('mousemove', onMove);
        scrim.removeEventListener('mouseup', onUp);
        scrim.remove();
        scrim = null;
      }
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
    };

    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const { onChange, min, max, invert } = stateRef.current;
      const delta = (orientation === 'vertical' ? e.clientX - startPos : e.clientY - startPos) * (invert ? -1 : 1);
      const next = Math.max(min, Math.min(max, startVal + delta));
      onChange(next);
    };
    const onUp = () => { teardown(); };
    const onDown = (e: MouseEvent) => {
      e.preventDefault();
      dragging = true;
      startPos = orientation === 'vertical' ? e.clientX : e.clientY;
      startVal = stateRef.current.value;
      document.body.style.userSelect = 'none';

      scrim = document.createElement('div');
      scrim.style.cssText = `position:fixed;inset:0;z-index:2147483647;cursor:${orientation === 'vertical' ? 'col-resize' : 'row-resize'};background:transparent;`;
      scrim.addEventListener('mousemove', onMove);
      scrim.addEventListener('mouseup', onUp);
      document.body.appendChild(scrim);
      // Window-level fallbacks: if the OS yanks focus (cmd-tab, etc.) mid-drag
      // we still want to release. `blur` covers that; the window-level
      // mouseup is belt-and-braces in case the scrim somehow misses it.
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('blur', onUp);
    };
    el.addEventListener('mousedown', onDown);
    return () => {
      el.removeEventListener('mousedown', onDown);
      teardown();
    };
  }, [orientation]);

  return <div ref={ref} className={`resizer ${orientation}`} role="separator" aria-orientation={orientation === 'vertical' ? 'vertical' : 'horizontal'} />;
}
