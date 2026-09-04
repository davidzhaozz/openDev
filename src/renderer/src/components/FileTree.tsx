import { useCallback, useEffect, useState } from 'react';
import type { FileNode } from '../../../shared/types';
import { useStore } from '../state/store';
import { baseName, dirName } from '@shared/paths';

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
  const setTreeExpanded = useStore(s => s.setTreeExpanded);
  const setTreeSelected = useStore(s => s.setTreeSelected);
  const [branchPicker, setBranchPicker] = useState<{ path: string; name: string; current: string; branches: string[] } | null>(null);
  // Electron / Chromium silently disable window.prompt(), so a fallback
  // modal is the only way these context-menu inputs ever appear.
  const [namePrompt, setNamePrompt] = useState<{
    title: string;
    initial: string;
    confirmLabel: string;
    onConfirm: (value: string) => void | Promise<void>;
  } | null>(null);

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
      const parent = dirName(ev.path);
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

  // Mirror the live expansion + selection sets into the store so the MCP
  // ide_tree_state tool can read them without prop-drilling.
  useEffect(() => { setTreeExpanded([...expanded]); }, [expanded, setTreeExpanded]);
  useEffect(() => { setTreeSelected([...selected]); }, [selected, setTreeSelected]);

  // MCP-driven tree control. Each command arrives as a CustomEvent dispatched
  // by App.tsx after it receives the corresponding mcp:command. We re-use the
  // already-cached fs.list / loadDir flow so the visible state matches what
  // a manual click would produce (children loaded, watcher attached).
  useEffect(() => {
    const collectAncestors = (target: string): string[] => {
      if (!target.startsWith(root)) return [];
      const out: string[] = [];
      let cur = target;
      while (cur && cur !== root && cur.length > root.length) {
        const parent = dirName(cur);
        if (!parent) break;
        out.push(parent);
        cur = parent;
      }
      return out;
    };

    const onReveal = async (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string; select?: boolean }>).detail || {};
      const path = detail.path;
      if (!path || !path.startsWith(root)) return;
      const ancestors = collectAncestors(path);
      // Expand ancestors top-down and load their children before adding the
      // next layer, so each newly-visible row has its kids ready.
      const next = new Set(expanded);
      for (const dir of [...ancestors].reverse()) {
        if (!next.has(dir)) {
          next.add(dir);
          await loadDir(dir);
          window.opendev.fs.watch(dir).catch(() => {});
        }
      }
      setExpanded(next);
      if (detail.select) setSelected(new Set([path]));
      // Defer the scroll one frame so the newly-expanded rows are in the DOM.
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-tree-path="${CSS.escape(path)}"]`);
        if (el && typeof (el as HTMLElement).scrollIntoView === 'function') {
          (el as HTMLElement).scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      });
    };

    const onExpand = async (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string; recursive?: boolean }>).detail || {};
      const path = detail.path;
      if (!path || !path.startsWith(root)) return;
      const next = new Set(expanded);
      next.add(path);
      await loadDir(path);
      window.opendev.fs.watch(path).catch(() => {});
      if (detail.recursive) {
        // BFS the loaded subtree, expanding every directory we encounter.
        const queue: string[] = [path];
        while (queue.length) {
          const dir = queue.shift()!;
          const kids = (await window.opendev.fs.list(dir)).filter(k => k.isDir);
          for (const k of kids) {
            next.add(k.path);
            queue.push(k.path);
          }
        }
      }
      setExpanded(next);
    };

    const onCollapse = (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string; all?: boolean }>).detail || {};
      if (detail.all) { setExpanded(new Set([root])); return; }
      const path = detail.path;
      if (!path) return;
      setExpanded(prev => {
        const next = new Set(prev);
        // Collapse the target and everything beneath it.
        for (const p of next) { if (p === path || p.startsWith(path + '/')) next.delete(p); }
        return next;
      });
    };

    const onFocus = () => {
      const el = document.querySelector('.tree') as HTMLElement | null;
      if (el) { el.setAttribute('tabindex', '-1'); el.focus({ preventScroll: false }); }
    };

    window.addEventListener('opendev:filetree-reveal', onReveal as EventListener);
    window.addEventListener('opendev:filetree-expand', onExpand as EventListener);
    window.addEventListener('opendev:filetree-collapse', onCollapse as EventListener);
    window.addEventListener('opendev:filetree-focus', onFocus);
    return () => {
      window.removeEventListener('opendev:filetree-reveal', onReveal as EventListener);
      window.removeEventListener('opendev:filetree-expand', onExpand as EventListener);
      window.removeEventListener('opendev:filetree-collapse', onCollapse as EventListener);
      window.removeEventListener('opendev:filetree-focus', onFocus);
    };
  }, [root, expanded, loadDir]);

  const [rootGitInfo, setRootGitInfo] = useState<FileNode['gitInfo'] | undefined>();
  useEffect(() => {
    let alive = true;
    // The workspace root itself isn't returned by fs.list — fetch its git info
    // separately by listing its parent and matching, OR just check via a small
    // helper. We synthesize gitInfo on the root node here.
    (async () => {
      try {
        const parent = dirName(root);
        const siblings = parent ? await window.opendev.fs.list(parent) : [];
        const me = siblings.find(s => s.path === root);
        if (alive) setRootGitInfo(me?.gitInfo);
      } catch {}
    })();
    return () => { alive = false; };
  }, [root]);

  const rows: FlatRow[] = [];
  const rootNode: FileNode = { name: baseName(root) || root, path: root, isDir: true, gitInfo: rootGitInfo };
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
            data-tree-path={node.path}
            className={`tree-row ${isSelected ? 'selected' : ''} ${isHidden ? 'hidden' : ''} ${isExpandedDir ? 'dir-expanded' : ''}`}
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
              const parent = dirName(branchPicker.path);
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
          <div className="item" onClick={() => {
            const node = ctx.node;
            setCtx(null);
            const dir = node.isDir ? node.path : dirName(node.path);
            setNamePrompt({
              title: 'New file',
              initial: '',
              confirmLabel: 'Create',
              onConfirm: async (name) => {
                try {
                  await window.opendev.fs.create(`${dir}/${name}`, false);
                  loadDir(dir);
                } catch (e: any) {
                  showToast(`Create failed: ${e?.message || e}`, 4000);
                }
              }
            });
          }}>New File</div>
          <div className="item" onClick={() => {
            const node = ctx.node;
            setCtx(null);
            const dir = node.isDir ? node.path : dirName(node.path);
            setNamePrompt({
              title: 'New folder',
              initial: '',
              confirmLabel: 'Create',
              onConfirm: async (name) => {
                try {
                  await window.opendev.fs.create(`${dir}/${name}`, true);
                  loadDir(dir);
                } catch (e: any) {
                  showToast(`Create failed: ${e?.message || e}`, 4000);
                }
              }
            });
          }}>New Folder</div>
          <div className="sep" />
          <div className="item" onClick={() => {
            const node = ctx.node;
            setCtx(null);
            const dir = dirName(node.path);
            setNamePrompt({
              title: `Rename ${node.isDir ? 'folder' : 'file'}`,
              initial: node.name,
              confirmLabel: 'Rename',
              onConfirm: async (name) => {
                if (name === node.name) return;
                try {
                  await window.opendev.fs.rename(node.path, `${dir}/${name}`);
                  loadDir(dir);
                } catch (e: any) {
                  showToast(`Rename failed: ${e?.message || e}`, 4000);
                }
              }
            });
          }}>Rename</div>
          <div className="item" onClick={async () => {
            const paths = selected.size > 1 && selected.has(ctx.node.path)
              ? [...selected]
              : [ctx.node.path];
            const label = paths.length === 1
              ? baseName(paths[0]) || paths[0]
              : `${paths.length} items`;
            if (!confirm(`Delete ${label}?`)) return setCtx(null);
            const dirs = new Set<string>();
            for (const p of paths) {
              try { await window.opendev.fs.delete(p); } catch (e: any) { showToast(`Delete failed: ${e?.message || e}`, 4000); }
              dirs.add(dirName(p));
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
      {namePrompt && (
        <NamePromptModal
          title={namePrompt.title}
          initial={namePrompt.initial}
          confirmLabel={namePrompt.confirmLabel}
          onCancel={() => setNamePrompt(null)}
          onConfirm={async (v) => {
            const trimmed = v.trim();
            if (!trimmed) { setNamePrompt(null); return; }
            const cb = namePrompt.onConfirm;
            setNamePrompt(null);
            await cb(trimmed);
          }}
        />
      )}
    </div>
  );
}

function NamePromptModal({ title, initial, confirmLabel, onCancel, onConfirm }: {
  title: string;
  initial: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: (value: string) => void | Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-solid-1)', border: '1px solid var(--border-solid)',
          borderRadius: 6, padding: 16, minWidth: 320, boxShadow: '0 8px 32px rgba(0,0,0,0.4)'
        }}
      >
        <div style={{ fontSize: 13, marginBottom: 10, color: 'var(--fg-0)' }}>{title}</div>
        <input
          autoFocus
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); onConfirm(value); }
            else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          }}
          onFocus={(e) => {
            // Select the basename (everything before the final extension) on
            // open — matches the VSCode rename UX so users can replace just
            // the name without retyping ".tsx" / ".py" / etc.
            const dot = value.lastIndexOf('.');
            if (dot > 0) e.currentTarget.setSelectionRange(0, dot);
            else e.currentTarget.select();
          }}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '6px 8px',
            background: 'var(--bg-solid-0)', color: 'var(--fg-0)',
            border: '1px solid var(--border-solid)', borderRadius: 4, fontSize: 13
          }}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button onClick={onCancel}>Cancel</button>
          <button
            onClick={() => onConfirm(value)}
            style={{ background: 'var(--accent-hi)', color: '#fff', borderColor: 'var(--accent-hi)' }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
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
