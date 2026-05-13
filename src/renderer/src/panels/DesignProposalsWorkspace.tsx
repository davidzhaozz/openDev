import { useMemo, useState } from 'react';
import { useStore, type DesignProposal } from '../state/store';

type Props = {
  tabId: string;
  proposals: DesignProposal[];
  targetPath?: string;
};

// Renders each AI-proposed design in its own sandboxed iframe so they sit
// side-by-side in the center tab and the user can compare them visually.
// Picking one fires a follow-up message back into the active chat — the
// claude-cli session is resumed (see ai.ts), so the model already has all
// the proposal context and can apply the chosen one.
export function DesignProposalsWorkspace({ tabId, proposals, targetPath }: Props) {
  const [zoom, setZoom] = useState(1);
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const showToast = useStore(s => s.showToast);
  const setRightTab = useStore(s => s.setRightTab);

  const cards = focusIdx == null ? proposals : [proposals[focusIdx]];

  const pickedHandler = (p: DesignProposal) => {
    const detail = {
      name: p.name,
      targetPath,
      tabId
    };
    window.dispatchEvent(new CustomEvent('opendev:design-chosen', { detail }));
    setRightTab('ai');
    window.dispatchEvent(new Event('opendev:focus-chat'));
    showToast(`Picked "${p.name}". Tell Claude to apply it (or just press Enter).`);
  };

  const colCount = useMemo(() => {
    if (focusIdx != null) return 1;
    return Math.min(3, Math.max(1, proposals.length));
  }, [focusIdx, proposals.length]);

  return (
    <div className="dp-root">
      <div className="dp-header">
        <div className="dp-title">
          {focusIdx != null ? `Focused: ${proposals[focusIdx].name}` : `${proposals.length} design proposals`}
          {targetPath && <span className="dp-target"> → {targetPath}</span>}
        </div>
        <span style={{ flex: 1 }} />
        {focusIdx != null && (
          <button className="dp-chip" onClick={() => setFocusIdx(null)}>← Back to grid</button>
        )}
        <span className="dp-zoom">
          <button onClick={() => setZoom(z => Math.max(0.4, z - 0.1))} title="Zoom out">−</button>
          <span>{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom(z => Math.min(2, z + 0.1))} title="Zoom in">+</button>
        </span>
      </div>

      <div className="dp-grid" style={{ gridTemplateColumns: `repeat(${colCount}, minmax(0, 1fr))` }}>
        {cards.map((p, i) => {
          const realIdx = focusIdx != null ? focusIdx : i;
          return (
            <div className="dp-card" key={`${p.name}-${realIdx}`}>
              <div className="dp-card-head">
                <span className="dp-card-name">{String.fromCharCode(65 + realIdx)}. {p.name}</span>
                <button className="dp-card-focus" onClick={() => setFocusIdx(focusIdx == null ? realIdx : null)}
                  title="Focus this design">{focusIdx == null ? '⛶' : '×'}</button>
              </div>
              <div className="dp-frame-wrap">
                <iframe
                  className="dp-frame"
                  title={p.name}
                  // sandbox without `allow-scripts` to prevent any pasted
                  // script from running. The proposal is inline HTML/CSS;
                  // we don't need JS for visual comparison.
                  sandbox=""
                  srcDoc={p.html}
                  style={{
                    transform: `scale(${zoom})`,
                    transformOrigin: 'top left',
                    width: `${100 / zoom}%`,
                    height: `${100 / zoom}%`
                  }}
                />
              </div>
              <div className="dp-card-foot">
                <button className="dp-pick" onClick={() => pickedHandler(p)}>
                  Choose this →
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
