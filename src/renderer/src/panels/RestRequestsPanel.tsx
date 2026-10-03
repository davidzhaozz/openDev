import { useEffect, useState } from 'react';
import { useStore, emptyRestSpec } from '../state/store';
import type { RestRequestSpec, RestSavedRequest } from '../../../shared/types';

// Right-panel REST tab. Lists saved requests grouped by folder. Click a
// row → opens the (singleton) REST center tab pre-loaded. The "+" button
// opens a fresh request in the center workspace; the user can save it
// from there to make it appear in this list.

// Order within a folder: by path, so one endpoint's verbs sit together, then
// by verb in CRUD order.
const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return url.replace(/[?#].*$/, ''); }
}

export function RestRequestsPanel() {
  const [items, setItems] = useState<RestSavedRequest[]>([]);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const openRestTab = useStore(s => s.openRestTab);
  const showToast = useStore(s => s.showToast);
  const triggerRestRun = useStore(s => s.triggerRestRun);
  const activeId = useStore(s => s.restSavedId);

  const refresh = async () => {
    try {
      const list = await window.opendev.rest.listSaved();
      setItems(list);
    } catch (e: any) {
      showToast(`Couldn't load saved requests: ${e?.message || e}`, 3500);
    }
  };

  useEffect(() => {
    refresh();
    // Main pings on every collection write — AI bulk saves, the workspace's
    // Save button, another window.
    return window.opendev.rest.onChanged(() => { refresh(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleFolder = (f: string) => setCollapsed(prev => {
    const next = new Set(prev);
    if (next.has(f)) next.delete(f); else next.add(f);
    return next;
  });

  const openNew = () => {
    openRestTab({ spec: emptyRestSpec(), name: 'New request', savedId: undefined });
  };

  const openSaved = (r: RestSavedRequest, andSend = false) => {
    const spec: RestRequestSpec = {
      method: r.method,
      url: r.url,
      headers: r.headers,
      params: r.params,
      body: r.body,
      auth: r.auth,
      description: r.description
    };
    openRestTab({ spec, name: r.name || r.url || 'REST', savedId: r.id });
    if (andSend) triggerRestRun();
  };

  const remove = async (r: RestSavedRequest) => {
    if (!confirm(`Delete saved request "${r.name || r.url}"?`)) return;
    try {
      const list = await window.opendev.rest.delete(r.id);
      setItems(list);
      showToast(`Deleted ${r.name || r.url}`, 2000);
    } catch (e: any) {
      showToast(`Delete failed: ${e?.message || e}`, 3500);
    }
  };

  const visible = filter.trim()
    ? items.filter(r => {
        const f = filter.toLowerCase();
        return (r.name || '').toLowerCase().includes(f) || r.url.toLowerCase().includes(f) || r.method.toLowerCase().includes(f)
          || (r.folder || '').toLowerCase().includes(f) || (r.description || '').toLowerCase().includes(f);
      })
    : items;

  // Group by folder; entries without a folder live under an implicit root.
  const groups = new Map<string, RestSavedRequest[]>();
  for (const r of visible) {
    const k = r.folder || '';
    const arr = groups.get(k);
    if (arr) arr.push(r); else groups.set(k, [r]);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => pathOf(a.url).localeCompare(pathOf(b.url))
      || METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method));
  }
  const sortedFolders = [...groups.keys()].sort((a, b) => {
    if (a === '' && b !== '') return -1;
    if (b === '' && a !== '') return 1;
    return a.localeCompare(b);
  });

  return (
    <div className="rest-panel">
      <div className="rest-panel-head">
        <input
          className="rest-filter"
          placeholder="Filter saved requests…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="rest-new" title="New request" onClick={openNew}>+ New</button>
      </div>
      <div className="rest-list">
        {items.length === 0 && (
          <div className="rest-empty">
            No saved requests yet. Hit <b>+ New</b> to start one, then use <b>Save</b> in the workspace.
          </div>
        )}
        {sortedFolders.map(folder => (
          <div key={folder || '__root'} className="rest-folder">
            {folder && (
              <div className="rest-folder-name" onClick={() => toggleFolder(folder)}>
                <span className="rest-folder-caret">{collapsed.has(folder) ? '▸' : '▾'}</span>
                {folder}
                <span className="rest-folder-count">{groups.get(folder)!.length}</span>
              </div>
            )}
            {!collapsed.has(folder) && groups.get(folder)!.map(r => (
              <div
                key={r.id}
                className={`rest-row ${activeId === r.id ? 'active' : ''}`}
                onClick={() => openSaved(r)}
                onDoubleClick={() => openSaved(r, true)}
                title={r.description ? `${r.method} ${r.url}\n\n${r.description}` : `${r.method} ${r.url}`}
              >
                <span className={`rest-method m-${r.method.toLowerCase()}`}>{r.method}</span>
                <span className="rest-row-text">
                  <span className="rest-row-name">{r.name || '(unnamed)'}</span>
                  <span className="rest-row-url">{r.url || '—'}</span>
                </span>
                <button
                  className="rest-row-del"
                  title="Delete"
                  onClick={(e) => { e.stopPropagation(); remove(r); }}
                >×</button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
