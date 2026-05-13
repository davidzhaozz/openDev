import { useEffect, useRef, useState } from 'react';

export function InstallNodePrompt({ hasBrew, onDismiss }: { hasBrew: boolean; onDismiss: () => void }) {
  const [installing, setInstalling] = useState(false);
  const [output, setOutput] = useState('');
  const [done, setDone] = useState<{ ok: boolean; error?: string } | null>(null);
  const outRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const off = window.opendev.tools.onInstallLog((chunk) => {
      setOutput((o) => {
        const next = o + chunk;
        return next.length > 80_000 ? next.slice(-80_000) : next;
      });
    });
    return off;
  }, []);

  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [output]);

  const install = async () => {
    setInstalling(true);
    setDone(null);
    const r = await window.opendev.tools.installNode();
    setDone(r);
    setInstalling(false);
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (!installing) { onDismiss(); } e.stopPropagation(); }}>
      <div className="modal" style={{ width: 640 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-input" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Node / npm not detected</div>
          <div style={{ fontSize: 12, color: 'var(--fg-2)' }}>
            Most services in your workspace use <code>npm</code>, but it isn't on your PATH. Without it, "Start Service Here" and similar commands will fail with{' '}
            <code>command not found</code>.
          </div>
        </div>
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {!hasBrew ? (
            <div style={{ fontSize: 12, color: 'var(--fg-1)' }}>
              Homebrew isn't installed either. Install it first:
              <pre className="mcp-snippet" style={{ marginTop: 6 }}>{'/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'}</pre>
              Then click <strong>Re-check</strong> below.
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--fg-1)' }}>
              Homebrew is available. Install Node with one click:
              <pre className="mcp-snippet" style={{ marginTop: 6 }}>brew install node</pre>
            </div>
          )}

          {installing && (
            <pre ref={outRef} className="mcp-snippet" style={{ maxHeight: 240 }}>{output || 'Installing…'}</pre>
          )}
          {done && !done.ok && (
            <div className="db-test-error" style={{ padding: 8 }}>{done.error || 'Install failed.'}</div>
          )}
          {done && done.ok && (
            <div className="db-test-result ok" style={{ padding: 8 }}>
              <strong>✓ Installed.</strong> You may need to restart openDev for the new PATH to take effect.
            </div>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 12, borderTop: '1px solid var(--border-solid)' }}>
          <button onClick={onDismiss} disabled={installing}>I'll handle it</button>
          <button
            onClick={async () => {
              const r = await window.opendev.tools.check();
              if (r.npm) onDismiss();
            }}
            disabled={installing}
          >Re-check</button>
          {hasBrew && (
            <button className="primary" onClick={install} disabled={installing}>
              {installing ? 'Installing…' : 'Install via Homebrew'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
