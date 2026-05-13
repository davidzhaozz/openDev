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

    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const { onChange, min, max, invert } = stateRef.current;
      const delta = (orientation === 'vertical' ? e.clientX - startPos : e.clientY - startPos) * (invert ? -1 : 1);
      const next = Math.max(min, Math.min(max, startVal + delta));
      onChange(next);
    };
    const onUp = () => {
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    const onDown = (e: MouseEvent) => {
      e.preventDefault();
      dragging = true;
      startPos = orientation === 'vertical' ? e.clientX : e.clientY;
      startVal = stateRef.current.value;
      document.body.style.cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };
    el.addEventListener('mousedown', onDown);
    return () => {
      el.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [orientation]);

  return <div ref={ref} className={`resizer ${orientation}`} role="separator" aria-orientation={orientation === 'vertical' ? 'vertical' : 'horizontal'} />;
}
