import { useEffect, useMemo, useRef, useState } from 'react';
import type { GrepHit } from '../../../shared/types';
import { useStore } from '../state/store';
import { baseName, toPosix } from '@shared/paths';

// Full-text search over the workspace, or over one folder when opened from
// the file tree's "Find in Folder…". Results are grouped by file, because the
// question being asked is "which documents contain this?" — the matching
// lines are the detail underneath that answer.

export type FindInFilesPayload = { dir?: string; name?: string };

type FileGroup = { path: string; hits: GrepHit[] };

export function FindInFiles() {
  const setModal = useStore(s => s.setModal);
  const openFile = useStore(s => s.openFileTab);
  const showToast = useStore(s => s.showToast);
  const workspaceRoot = useStore(s => s.workspaceRoot);
  const payload = useStore(s => s.modalPayload) as FindInFilesPayload | undefined;

  // The folder to search. Cleared with the × on the scope chip, which widens
  // the search back out to the whole workspace.
  const [dir, setDir] = useState<string | undefined>(payload?.dir);
  const [q, setQ] = useState('');
  const [glob, setGlob] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [hits, setHits] = useState<GrepHit[]>([]);
  const [running, setRunning] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [searched, setSearched] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Each search gets a token that ripgrep's hits carry back. Typing restarts
  // the search often, and without this the tail of the previous stream lands
  // in the new result list.
  const token = useRef('');

  useEffect(() => {
    const off1 = window.opendev.search.onHit((h) => {
      if (h.token !== token.current) return;
      setHits(prev => [...prev, h]);
    });
    const off2 = window.opendev.search.onDone((info) => {
      if (info?.token !== token.current) return;
      setRunning(false);
      setTruncated(!!info?.truncated);
      setError(info?.error);
    });
    return () => { off1(); off2(); };
  }, []);

  const run = async (text: string) => {
    const query = text.trim();
    const mine = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    token.current = mine;
    setHits([]);
    setTruncated(false);
    setError(undefined);
    setCollapsed(new Set());
    setSearched(query);
    if (!query) { setRunning(false); return; }
    setRunning(true);
    try {
      await window.opendev.search.grep(query, {
        dir,
        glob: glob.trim() || undefined,
        caseSensitive,
        wholeWord,
        regex,
        token: mine
      });
    } catch (e: any) {
      if (mine === token.current) {
        setRunning(false);
        showToast(`Search failed: ${e?.message || e}`, 4000);
      }
    }
  };

  // Search as you type, one search per pause. Two characters is the floor —
  // a single letter matches most of the tree and tells you nothing.
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      token.current = '';
      setHits([]); setSearched(''); setRunning(false);
      return;
    }
    const t = setTimeout(() => run(q), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, dir, glob, caseSensitive, wholeWord, regex]);

  const groups: FileGroup[] = useMemo(() => {
    const byFile = new Map<string, GrepHit[]>();
    for (const h of hits) {
      const list = byFile.get(h.path);
      if (list) list.push(h);
      else byFile.set(h.path, [h]);
    }
    return Array.from(byFile, ([path, list]) => ({ path, hits: list }));
  }, [hits]);

  const relative = (p: string): string => {
    const base = dir || workspaceRoot;
    if (base && toPosix(p).toLowerCase().startsWith(toPosix(base).toLowerCase() + '/')) {
      return toPosix(p).slice(base.length + 1);
    }
    return toPosix(p);
  };

  const open = async (h: GrepHit) => {
    try {
      const content = await window.opendev.fs.read(h.path);
      openFile(h.path, content);
      setModal(null);
    } catch (e: any) {
      showToast(`Couldn't open ${baseName(h.path)}: ${e?.message || e}`, 4000);
    }
  };

  const toggleGroup = (path: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const scopeLabel = dir ? relativeToRoot(dir, workspaceRoot) : (workspaceRoot ? baseName(workspaceRoot) : 'workspace');

  return (
    <div className="modal-overlay" onMouseDown={() => setModal(null)}>
      <div className="modal find-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="find-head">
          <div className="find-row">
            <input
              autoFocus
              className="find-query"
              placeholder={dir ? `Find in ${baseName(dir)}…` : 'Find in workspace…'}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); run(q); }
                if (e.key === 'Escape') { e.preventDefault(); setModal(null); }
              }}
            />
            <div className="find-toggles">
              <button
                className={`find-toggle${caseSensitive ? ' on' : ''}`}
                title="Match case"
                onClick={() => setCaseSensitive(v => !v)}
              >Aa</button>
              <button
                className={`find-toggle${wholeWord ? ' on' : ''}`}
                title="Whole word"
                onClick={() => setWholeWord(v => !v)}
              >ab|</button>
              <button
                className={`find-toggle${regex ? ' on' : ''}`}
                title="Regular expression (off = literal text)"
                onClick={() => setRegex(v => !v)}
              >.*</button>
            </div>
          </div>
          <div className="find-row find-row-sub">
            <span className="find-scope" title={dir || workspaceRoot}>
              in <strong>{scopeLabel}</strong>
              {dir && (
                <button className="find-scope-clear" title="Search the whole workspace instead"
                  onClick={() => setDir(undefined)}>×</button>
              )}
            </span>
            <input
              className="find-glob"
              placeholder="filter by glob, e.g. *.ts"
              value={glob}
              onChange={(e) => setGlob(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setModal(null); }}
            />
            <span className="grow" />
            <span className="find-count">
              {running
                ? 'Searching…'
                : searched
                  ? `${hits.length}${truncated ? '+' : ''} match${hits.length === 1 ? '' : 'es'} in ${groups.length} file${groups.length === 1 ? '' : 's'}`
                  : 'Type at least 2 characters'}
            </span>
          </div>
        </div>

        <div className="find-results">
          {error && <div className="find-error">{error}</div>}
          {groups.map(g => {
            const isCollapsed = collapsed.has(g.path);
            return (
              <div key={g.path} className="find-group">
                <div className="find-file" onClick={() => toggleGroup(g.path)}>
                  <span className="find-caret">{isCollapsed ? '▸' : '▾'}</span>
                  <span className="find-file-name">{baseName(g.path)}</span>
                  <span className="find-file-dir">{relative(g.path)}</span>
                  <span className="grow" />
                  <span className="find-file-count">{g.hits.length}</span>
                </div>
                {!isCollapsed && g.hits.map((h, i) => (
                  <div key={i} className="find-hit" onClick={() => open(h)} title={`${h.path}:${h.line}`}>
                    <span className="find-line">{h.line}</span>
                    <span className="find-preview">{h.preview.length > 400 ? h.preview.slice(0, 400) + '…' : h.preview}</span>
                  </div>
                ))}
              </div>
            );
          })}
          {truncated && (
            <div className="find-note">Stopped at the first {hits.length} matches — narrow the query or add a glob.</div>
          )}
          {!running && searched && !error && groups.length === 0 && (
            <div className="find-note">No file under {scopeLabel} contains “{searched}”.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function relativeToRoot(p: string, root?: string): string {
  if (!root) return toPosix(p);
  const a = toPosix(p);
  const b = toPosix(root);
  if (a.toLowerCase() === b.toLowerCase()) return baseName(root);
  if (a.toLowerCase().startsWith(b.toLowerCase() + '/')) return a.slice(b.length + 1);
  return a;
}
