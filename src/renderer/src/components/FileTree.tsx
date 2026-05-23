import { useCallback, useEffect, useState } from 'react';
import type { FileNode } from '../../../shared/types';
import { useStore } from '../state/store';

type FlatRow = { node: FileNode; depth: number };

type Props = {
  root: string;
  onOpen: (path: string) => void;
};

export function FileTree({ root, onOpen }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set([root]));
  const [childrenCache, setChildrenCache] = useState<Record<string, FileNode[]>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | undefined>();
  const [ctx, setCtx] = useState<{ x: number; y: number; node: FileNode } | null>(null);
  const showToast = useStore(s => s.showToast);
  const openTerminalTab = useStore(s => s.openTerminalTab);
  const setModal = useStore(s => s.setModal);
  const [branchPicker, setBranchPicker] = useState<{ path: string; name: string; current: string; branches: string[] } | null>(null);

  const loadDir = useCallback(async (dir: string) => {
    const items = await window.opendev.fs.list(dir);
    setChildrenCache(prev => ({ ...prev, [dir]: items }));
  }, []);

  useEffect(() => {
    setExpanded(new Set([root]));
    setChildrenCache({});
    loadDir(root);
  }, [root, loadDir]);

  useEffect(() => {
    const off = window.opendev.fs.onWatch((ev) => {
      const parent = ev.path.split('/').slice(0, -1).join('/');
      // Refresh any directory we've already loaded — keeps cached children
      // honest with what's on disk after rename/create/delete.
      if (childrenCache[parent]) loadDir(parent);
      else if (parent === root) loadDir(root);
    });
    return off;
  }, [childrenCache, loadDir, root]);

  useEffect(() => {
    const onClick = () => setCtx(null);
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, []);

  const toggle = async (node: FileNode) => {
    if (!node.isDir) return;
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(node.path)) {
        next.delete(node.path);
        // Stop watching when collapsed to keep file-descriptor usage in check.
        window.opendev.fs.unwatch(node.path).catch(() => {});
      } else {
        next.add(node.path);
        if (!childrenCache[node.path]) loadDir(node.path);
        // Watch so we hear about new/renamed/deleted files inside this folder.
        window.opendev.fs.watch(node.path).catch(() => {});
      }
      return next;
    });
  };

  const refreshAll = useCallback(() => {
    // Clear cache + reload every currently-visible directory.
    setChildrenCache({});
    loadDir(root);
    for (const dir of expanded) {
      if (dir !== root) loadDir(dir);
    }
  }, [root, expanded, loadDir]);

  // Expose a refresh affordance via window event so the panel header can fire it.
  useEffect(() => {
    const h = () => refreshAll();
    window.addEventListener('opendev:filetree-refresh', h);
    return () => window.removeEventListener('opendev:filetree-refresh', h);
  }, [refreshAll]);

  const [rootGitInfo, setRootGitInfo] = useState<FileNode['gitInfo'] | undefined>();
  useEffect(() => {
    let alive = true;
    // The workspace root itself isn't returned by fs.list — fetch its git info
    // separately by listing its parent and matching, OR just check via a small
    // helper. We synthesize gitInfo on the root node here.
    (async () => {
      try {
        const parent = root.split('/').slice(0, -1).join('/');
        const siblings = parent ? await window.opendev.fs.list(parent) : [];
        const me = siblings.find(s => s.path === root);
        if (alive) setRootGitInfo(me?.gitInfo);
      } catch {}
    })();
    return () => { alive = false; };
  }, [root]);

  const rows: FlatRow[] = [];
  const rootNode: FileNode = { name: root.split('/').pop() || root, path: root, isDir: true, gitInfo: rootGitInfo };
  function walk(node: FileNode, depth: number) {
    rows.push({ node, depth });
    if (node.isDir && expanded.has(node.path)) {
      const kids = childrenCache[node.path] || [];
      for (const k of kids) walk(k, depth + 1);
    }
  }
  walk(rootNode, 0);

  return (
    <div className="tree" onContextMenu={(e) => e.preventDefault()}>
      {rows.map(({ node, depth }, i) => {
        const isExpandedDir = node.isDir && expanded.has(node.path);
        const gitLabel = node.isDir && node.gitInfo?.branch ? node.gitInfo.branch : null;
        const isSelected = selected.has(node.path);
        // Dotfiles/dotdirs (.env, .gitignore, .idea, .vscode, etc.) are
        // "hidden" by Unix convention. We still show them, but dimmed so
        // the eye lands on real source first.
        const isHidden = node.name.startsWith('.');
        return (
          <div
            key={node.path}
            className={`tree-row ${isSelected ? 'selected' : ''} ${isHidden ? 'hidden' : ''}`}
            style={{ paddingLeft: 6 + depth * 12 }}
            onClick={(e) => {
              if (e.shiftKey && anchor) {
                // Range select between anchor and clicked, in flat visible order
                const anchorIdx = rows.findIndex(r => r.node.path === anchor);
                if (anchorIdx >= 0) {
                  const lo = Math.min(anchorIdx, i);
                  const hi = Math.max(anchorIdx, i);
                  const range = new Set<string>();
                  for (let j = lo; j <= hi; j++) range.add(rows[j].node.path);
                  setSelected(range);
                  return;
                }
              }
              if (e.metaKey || e.ctrlKey) {
                // Toggle this one in/out
                setSelected(prev => {
                  const next = new Set(prev);
                  if (next.has(node.path)) next.delete(node.path); else next.add(node.path);
                  return next;
                });
                setAnchor(node.path);
                return;
              }
              // Plain click — single select + open/toggle
              setSelected(new Set([node.path]));
              setAnchor(node.path);
              if (node.isDir) toggle(node);
              else onOpen(node.path);
            }}
            onDoubleClick={() => { if (!node.isDir) onOpen(node.path); }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              // If right-clicked node isn't in selection, narrow to just that one.
              if (!selected.has(node.path)) {
                setSelected(new Set([node.path]));
                setAnchor(node.path);
              }
              setCtx({ x: e.clientX, y: e.clientY, node });
            }}
          >
            <span className="tree-chev">{node.isDir ? (isExpandedDir ? '▾' : '▸') : ''}</span>
            <span className="tree-glyph">{node.isDir ? (isExpandedDir ? '▣' : '▢') : '·'}</span>
            <span className="tree-name">{node.name}</span>
            {gitLabel && <span className="tree-git">{gitLabel}</span>}
          </div>
        );
      })}
      {branchPicker && (
        <BranchPicker
          info={branchPicker}
          onClose={() => setBranchPicker(null)}
          onPick={async (branch) => {
            const r = await window.opendev.git.checkoutAt(branchPicker.path, branch);
            if (r.ok) {
              showToast(`Switched ${branchPicker.name} to ${branch}`, 2500);
              setBranchPicker(null);
              // Refresh tree to update git label
              const parent = branchPicker.path.split('/').slice(0, -1).join('/');
              if (parent) loadDir(parent);
            } else {
              showToast(`Checkout failed: ${r.error}`, 5000);
            }
          }}
        />
      )}
      {ctx && (
        <div className="ctx-menu" style={{ left: ctx.x, top: ctx.y }} onClick={(e) => e.stopPropagation()}>
          {!ctx.node.isDir && <div className="item" onClick={() => { onOpen(ctx.node.path); setCtx(null); }}>Open</div>}
          {ctx.node.isDir && <div className="item" onClick={async () => {
            const target = ctx.node.path;
            setCtx(null);
            try {
              const draft = await window.opendev.services.deriveFromDir(target);
              const saved = await window.opendev.services.save({ id: '', ...draft });
              await window.opendev.services.start(saved.id);
              showToast(`Started ${saved.name}`, 2500);
            } catch (e: any) {
              showToast(`Couldn't start service: ${e?.message || e}`, 4000);
            }
          }}>Start Service Here</div>}
          {ctx.node.isDir && <div className="item" onClick={() => {
            const target = ctx.node.path;
            openTerminalTab({ cwd: target, name: ctx.node.name });
            setCtx(null);
          }}>Start Terminal Here</div>}
          {ctx.node.isDir && <div className="item" onClick={async () => {
            const target = ctx.node.path;
            setCtx(null);
            const det = await window.opendev.packages.detect(target);
            if (!det) {
              showToast('No Maven (pom.xml) or .NET (.csproj) project in this folder.', 3500);
              return;
            }
            setModal('add-package', { dir: target });
          }}>Add Package…</div>}
          {ctx.node.isDir && ctx.node.gitInfo && (
            <div className="item" onClick={async () => {
              const target = ctx.node.path;
              const name = ctx.node.name;
              setCtx(null);
              const r = await window.opendev.git.branchesAt(target);
              if ('error' in r) { showToast(`Couldn't list branches: ${r.error}`, 4000); return; }
              setBranchPicker({ path: target, name, current: r.current, branches: r.all });
            }}>Switch Branch…</div>
          )}
          {ctx.node.isDir && <div className="sep" />}
          <div className="item" onClick={async () => {
            const name = prompt('New file name:');
            if (!name) return setCtx(null);
            const dir = ctx.node.isDir ? ctx.node.path : ctx.node.path.split('/').slice(0, -1).join('/');
            await window.opendev.fs.create(`${dir}/${name}`, false);
            loadDir(dir);
            setCtx(null);
          }}>New File</div>
          <div className="item" onClick={async () => {
            const name = prompt('New folder name:');
            if (!name) return setCtx(null);
            const dir = ctx.node.isDir ? ctx.node.path : ctx.node.path.split('/').slice(0, -1).join('/');
            await window.opendev.fs.create(`${dir}/${name}`, true);
            loadDir(dir);
            setCtx(null);
          }}>New Folder</div>
          <div className="sep" />
          <div className="item" onClick={async () => {
            const name = prompt('Rename to:', ctx.node.name);
            if (!name) return setCtx(null);
            const dir = ctx.node.path.split('/').slice(0, -1).join('/');
            await window.opendev.fs.rename(ctx.node.path, `${dir}/${name}`);
            loadDir(dir);
            setCtx(null);
          }}>Rename</div>
          <div className="item" onClick={async () => {
            const paths = selected.size > 1 && selected.has(ctx.node.path)
              ? [...selected]
              : [ctx.node.path];
            const label = paths.length === 1
              ? paths[0].split('/').pop() || paths[0]
              : `${paths.length} items`;
            if (!confirm(`Delete ${label}?`)) return setCtx(null);
            const dirs = new Set<string>();
            for (const p of paths) {
              try { await window.opendev.fs.delete(p); } catch (e: any) { showToast(`Delete failed: ${e?.message || e}`, 4000); }
              dirs.add(p.split('/').slice(0, -1).join('/'));
            }
            for (const d of dirs) loadDir(d);
            setSelected(new Set());
            setCtx(null);
          }}>Delete{selected.size > 1 && selected.has(ctx.node.path) ? ` ${selected.size} items` : ''}</div>
          <div className="sep" />
          <div className="item" onClick={() => { navigator.clipboard.writeText(ctx.node.path); setCtx(null); }}>Copy Path</div>
          <div className="item" onClick={() => { window.opendev.fs.reveal(ctx.node.path); setCtx(null); }}>Reveal in Finder</div>
        </div>
      )}
    </div>
  );
}

function BranchPicker({ info, onClose, onPick }: {
  info: { path: string; name: string; current: string; branches: string[] };
  onClose: () => void;
  onPick: (branch: string) => void;
}) {
  const [q, setQ] = useState('');
  const filtered = info.branches.filter(b => !q || b.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-input" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Switch branch in {info.name}</div>
          <div style={{ fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>currently on {info.current}</div>
          <input autoFocus placeholder="Filter branches…" value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }} />
        </div>
        <div className="modal-list">
          {filtered.map(b => (
            <div key={b}
              className={`modal-row ${b === info.current ? 'active' : ''}`}
              onClick={() => onPick(b)}>
              <span>{b.replace(/^remotes\//, '')}</span>
              <span className="relpath">{b === info.current ? 'current' : b.startsWith('remotes/') ? 'remote' : ''}</span>
            </div>
          ))}
          {filtered.length === 0 && <div className="modal-row" style={{ color: 'var(--fg-3)' }}>No matching branches</div>}
        </div>
      </div>
    </div>
  );
}
