import { useState } from 'react';
import { DiffView, type DiffMode } from '../components/DiffView';

type Props = { filePath: string; hash?: string; diff: string };

export function DiffWorkspace({ filePath, hash, diff }: Props) {
  const [mode, setMode] = useState<DiffMode>('split');
  return (
    <div className="diff-workspace">
      <div className="diff-workspace-header">
        <span className="diff-workspace-path">{filePath}</span>
        {hash && <span className="diff-workspace-hash">@ {hash.slice(0, 12)}</span>}
        <span className="grow" />
        <div className="diff-mode-toggle">
          <button className={mode === 'split' ? 'active' : ''} onClick={() => setMode('split')} title="Side-by-side">Split</button>
          <button className={mode === 'unified' ? 'active' : ''} onClick={() => setMode('unified')} title="Unified">Unified</button>
        </div>
        <button
          onClick={() => navigator.clipboard.writeText(diff)}
          title="Copy raw diff"
        >Copy</button>
      </div>
      <div className="diff-workspace-body">
        <DiffView diff={diff} mode={mode} showCommitHeader={false} />
      </div>
    </div>
  );
}
