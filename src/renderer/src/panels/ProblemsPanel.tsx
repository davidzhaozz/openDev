import { useEffect, useState } from 'react';

type Diag = { uri: string; range: { start: { line: number; character: number } }; severity?: number; message: string; source?: string };

const sevName = (n?: number) => n === 1 ? 'error' : n === 2 ? 'warn' : n === 3 ? 'info' : 'hint';

export function ProblemsPanel({ onJump }: { onJump: (path: string, line: number, col: number) => void }) {
  const [items, setItems] = useState<Record<string, Diag[]>>({});

  useEffect(() => {
    const off = window.opendev.lsp.onDiagnostics((params: any) => {
      const uri: string = params.uri;
      const diags: Diag[] = params.diagnostics || [];
      setItems(prev => ({ ...prev, [uri]: diags }));
    });
    return off;
  }, []);

  const flat = Object.entries(items).flatMap(([uri, ds]) => ds.map(d => ({ uri, d })));

  return (
    <div className="panel">
      <div className="panel-header"><span>Problems ({flat.length})</span></div>
      <div className="panel-body">
        {flat.map((row, i) => {
          const path = row.uri.replace(/^file:\/\//, '');
          return (
            <div key={i} className="tree-row" onClick={() => onJump(path, row.d.range.start.line, row.d.range.start.character)}>
              <span className="icon" style={{ color: row.d.severity === 1 ? 'var(--danger)' : 'var(--warn)' }}>●</span>
              <span style={{ flex: 1 }}>{row.d.message}</span>
              <span style={{ color: 'var(--fg-3)', fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>{path.split('/').pop()}:{row.d.range.start.line + 1}</span>
            </div>
          );
        })}
        {!flat.length && <div style={{ padding: 12, color: 'var(--fg-3)' }}>No problems detected.</div>}
      </div>
    </div>
  );
}
