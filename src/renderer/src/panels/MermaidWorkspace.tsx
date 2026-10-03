import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { CodeEditor } from '../components/Editor';
import { MermaidCanvas } from '../components/MermaidCanvas';
import { useStore } from '../state/store';

type Mode = 'diagram' | 'source' | 'history';

type Commit = { hash: string; date: string; message: string; author_name?: string };

/** Working tree is a pseudo-revision so it sits in the same list as commits. */
const WORKING = '__working__';

type Props = {
  path: string;
  value: string;
  active: boolean;
  onChange: (s: string) => void;
  onSave: () => void;
  onJumpTo?: (path: string, line: number, col: number) => void;
};

function shortHash(h: string) { return h.slice(0, 7); }

function relDate(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * Center-tab view for .mmd files: one pane, toggled between the mermaid
 * source, the rendered diagram, and the diagram as of any commit that
 * touched the file. Clicking an element in the diagram jumps the editor to
 * the line that drew it; moving the caret outlines that line's element.
 */
export function MermaidWorkspace({ path, value, active, onChange, onSave, onJumpTo }: Props) {
  const [mode, setMode] = useState<Mode>('diagram');
  const [caretLine, setCaretLine] = useState<number | null>(null);
  const [errorLine, setErrorLine] = useState<number | null>(null);
  const setPendingJump = useStore(s => s.setPendingJump);
  const showToast = useStore(s => s.showToast);

  // Git history state, loaded the first time History is opened.
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [histError, setHistError] = useState<string | null>(null);
  const [revHash, setRevHash] = useState<string>(WORKING);
  const [revCode, setRevCode] = useState<string>('');
  const [revLoading, setRevLoading] = useState(false);
  const revCache = useRef(new Map<string, string>());

  // Clicking an element in the diagram puts the caret on its line. The
  // panes are toggled rather than split, so we surface the source too —
  // Esc comes straight back to the diagram.
  const pickLine = useCallback((line: number) => {
    setCaretLine(line);
    setMode('source');
    setPendingJump({ path, line: Math.max(0, line - 1), col: 0 });
  }, [path, setPendingJump]);

  const onSourceKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setMode('diagram');
    }
  };

  const loadHistory = useCallback(async () => {
    setHistError(null);
    const r = await window.opendev.git.fileLog(path, 100);
    if ('error' in r) { setHistError(r.error); setCommits([]); return; }
    setCommits(r.commits ?? []);
  }, [path]);

  useEffect(() => {
    if (mode !== 'history' || commits !== null) return;
    loadHistory();
  }, [mode, commits, loadHistory]);

  // A revision change re-reads that version of the file (cached per hash —
  // a commit's content never changes).
  useEffect(() => {
    if (mode !== 'history') return;
    if (revHash === WORKING) { setRevCode(value); return; }
    const cached = revCache.current.get(revHash);
    if (cached !== undefined) { setRevCode(cached); return; }
    let cancelled = false;
    setRevLoading(true);
    window.opendev.git.fileAt(path, revHash).then(r => {
      if (cancelled) return;
      setRevLoading(false);
      if ('error' in r) { setRevCode(''); setHistError(r.error); return; }
      revCache.current.set(revHash, r.content);
      setRevCode(r.content);
    });
    return () => { cancelled = true; };
  }, [mode, revHash, path, value]);

  // The file changing on disk invalidates nothing cached by hash, but the
  // working-tree entry must follow the buffer.
  useEffect(() => {
    if (mode === 'history' && revHash === WORKING) setRevCode(value);
  }, [value, mode, revHash]);

  const modeTabs = (
    <span className="mmd-modes">
      {(['diagram', 'source', 'history'] as Mode[]).map(m => (
        <button
          key={m}
          className={mode === m ? 'active' : ''}
          onClick={() => setMode(m)}
          title={m === 'history' ? 'Render this file as of an earlier commit' : undefined}
        >
          {m === 'diagram' ? 'Diagram' : m === 'source' ? 'Source' : 'History'}
        </button>
      ))}
      {errorLine != null && mode !== 'source' && (
        <button className="mmd-err-chip" onClick={() => pickLine(errorLine)}>
          ⚠ line {errorLine}
        </button>
      )}
    </span>
  );

  const selected = commits?.find(c => c.hash === revHash);

  return (
    <div className="mmd-root">
      {/* Source — kept mounted so the editor keeps its scroll, undo history
          and language-server state while the diagram is on screen. */}
      <div className="mmd-pane" style={{ display: mode === 'source' ? 'flex' : 'none' }} onKeyDown={onSourceKeyDown}>
        <div className="mmd-toolbar mmd-toolbar-source">
          {modeTabs}
          <span className="mmd-tb-grow" />
          <span className="mmd-hint">Esc returns to the diagram</span>
        </div>
        <div className="mmd-editor-host">
          <CodeEditor
            path={path}
            value={value}
            onChange={onChange}
            onSave={onSave}
            onJumpTo={onJumpTo}
            onCaretLine={setCaretLine}
          />
        </div>
      </div>

      {/* Diagram — the working-tree version, live as you type. */}
      <div className="mmd-pane" style={{ display: mode === 'diagram' ? 'flex' : 'none' }}>
        <MermaidCanvas
          code={value}
          active={active && mode === 'diagram'}
          highlightLine={caretLine}
          onPick={pickLine}
          onError={(err) => setErrorLine(err?.line ?? null)}
          toolbarLeft={modeTabs}
        />
      </div>

      {/* History — the same canvas over an older revision of the file. */}
      <div className="mmd-pane mmd-pane-history" style={{ display: mode === 'history' ? 'flex' : 'none' }}>
        <div className="mmd-history-list">
          <div className="mmd-history-head">
            <span>Revisions</span>
            <button className="mmd-refresh" title="Reload history"
              onClick={() => { setCommits(null); revCache.current.clear(); }}>⟳</button>
          </div>
          <div
            className={`mmd-rev ${revHash === WORKING ? 'active' : ''}`}
            onClick={() => setRevHash(WORKING)}
          >
            <span className="mmd-rev-hash">current</span>
            <span className="mmd-rev-msg">Working tree</span>
          </div>
          {commits === null && <div className="mmd-history-empty">loading…</div>}
          {commits?.length === 0 && (
            <div className="mmd-history-empty">{histError ?? 'No commits touch this file.'}</div>
          )}
          {commits?.map(c => (
            <div
              key={c.hash}
              className={`mmd-rev ${revHash === c.hash ? 'active' : ''}`}
              onClick={() => setRevHash(c.hash)}
              title={`${c.message}\n${c.author_name ?? ''} · ${c.date}`}
            >
              <span className="mmd-rev-hash">{shortHash(c.hash)}</span>
              <span className="mmd-rev-msg">{c.message}</span>
              <span className="mmd-rev-date">{relDate(c.date)}</span>
            </div>
          ))}
        </div>
        <div className="mmd-history-canvas">
          {revLoading
            ? <div className="mmd-history-empty">loading revision…</div>
            : (
              <MermaidCanvas
                code={revCode}
                active={active && mode === 'history'}
                fitKey={revHash}
                toolbarLeft={
                  <>
                    {modeTabs}
                    <span className="mmd-rev-badge">
                      {revHash === WORKING
                        ? 'working tree'
                        : `${shortHash(revHash)} · ${selected ? relDate(selected.date) : ''}`}
                    </span>
                    {revHash !== WORKING && (
                      <button
                        className="mmd-copy-rev"
                        title="Replace the working-tree file with this revision (unsaved — ⌘S to keep it)"
                        onClick={() => {
                          onChange(revCode);
                          setMode('source');
                          showToast('Loaded that revision into the editor — save to keep it.');
                        }}
                      >
                        Restore into editor
                      </button>
                    )}
                  </>
                }
              />
            )}
        </div>
      </div>
    </div>
  );
}
