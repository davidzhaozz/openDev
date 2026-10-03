// JIRA panel — real Atlassian tickets parked as AI tasks.
//
// Each row is one ticket: key, title, run state, and Start/Stop. Starting
// spawns a Claude run scoped to that ticket in the workspace; when it finishes
// the main process posts a summary comment back to Jira and transitions the
// issue. Expanding a row tails that run's output.
//
// The tickets come from one board — a `.opendev/jira*.json` file — picked in
// the dropdown at the top. Everything below it (add, refresh, run) applies to
// the board currently loaded.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JiraBoard, JiraRunState, JiraTask } from '../../../shared/types';
import { boardFileFor } from '../../../shared/jiraBoards';
import { useStore } from '../state/store';
import {
  RUN_ORDER, PAGE_SIZE, clampPage, filterTasks, pageCount, pageRange, pageSlice, sortTasks,
  type SortKey
} from './jiraSort';

// The panel unmounts whenever the user switches right-panel tabs, so these
// two choices have to live outside component state or they reset constantly.
const FILTER_STORE = 'opendev.jira.filter';
const SORT_STORE = 'opendev.jira.sort';
const load = (k: string, fallback: string): string => {
  try { return localStorage.getItem(k) || fallback; } catch { return fallback; }
};
const save = (k: string, v: string): void => {
  try { localStorage.setItem(k, v); } catch { /* private mode */ }
};

const DOT: Record<JiraRunState, string> = {
  idle: '',
  queued: 'queued',
  running: 'running',
  done: 'done',
  failed: 'error',
  stopped: ''
};

const LABEL: Record<JiraRunState, string> = {
  idle: 'to do',
  queued: 'queued',
  running: 'running',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped'
};

function elapsed(from?: number, to?: number): string {
  if (!from) return '';
  const ms = (to ?? Date.now()) - from;
  if (ms < 0) return '';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

export function JiraPanel() {
  const [tasks, setTasks] = useState<JiraTask[]>([]);
  const [boards, setBoards] = useState<JiraBoard[]>([]);
  const [board, setBoard] = useState('');
  // The inline name row under the picker, for a new board or for renaming the
  // selected one. Undefined means it is closed.
  const [edit, setEdit] = useState<{ mode: 'create' | 'rename'; value: string } | undefined>();
  const [expanded, setExpanded] = useState<string | undefined>();
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [filter, setFilter] = useState(() => load(FILTER_STORE, 'all'));
  const [sort, setSort] = useState<SortKey>(() => load(SORT_STORE, 'added') as SortKey);
  const [page, setPage] = useState(0);
  const [notConfigured, setNotConfigured] = useState<string | null>(null);
  // Re-render once a second so the elapsed timer on a running row ticks.
  const [, setTick] = useState(0);
  const showToast = useStore((s) => s.showToast);
  const logRef = useRef<HTMLPreElement | null>(null);

  const refreshList = useCallback(() => {
    window.opendev.jira.list().then(setTasks).catch(() => {});
  }, []);

  // Board list and ticket counts are re-read alongside the tickets, so a board
  // created or edited outside the app shows up without reopening the panel.
  const refreshBoards = useCallback(() => {
    window.opendev.jira.boards()
      .then((r) => { setBoards(r.boards); setBoard(r.active); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshList();
    refreshBoards();
    const off = window.opendev.jira.onChanged(() => { refreshList(); refreshBoards(); });
    return off;
  }, [refreshList, refreshBoards]);

  // Ask up front whether Jira is usable, and re-ask whenever Settings saves,
  // so the panel says "not configured" instead of waiting for a failed refresh
  // to explain it.
  const recheckConfig = useCallback(() => {
    window.opendev.jira.configured().then(setNotConfigured).catch(() => {});
  }, []);
  useEffect(() => {
    recheckConfig();
    const h = () => recheckConfig();
    window.addEventListener('opendev:settings-changed', h);
    return () => window.removeEventListener('opendev:settings-changed', h);
  }, [recheckConfig]);

  useEffect(() => {
    const off = window.opendev.jira.onLog(({ id, chunk }) => {
      setLogs((prev) => ({ ...prev, [id]: (prev[id] ?? '') + chunk }));
    });
    return off;
  }, []);

  useEffect(() => {
    if (!tasks.some((t) => t.state === 'running')) return;
    const h = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, [tasks]);

  // Pull the buffered log when a row is first expanded — chunks that arrived
  // before expansion are held in the main process, not in this component.
  useEffect(() => {
    if (!expanded || logs[expanded] !== undefined) return;
    window.opendev.jira.log(expanded).then((l) => setLogs((p) => ({ ...p, [expanded]: l })));
  }, [expanded, logs]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, expanded]);

  // Only offer Jira statuses that are actually present, so the dropdown can't
  // filter the list down to nothing on a status no ticket has.
  const jiraStatuses = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) if (t.status) set.add(t.status);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [tasks]);

  const runStates = useMemo(() => {
    const set = new Set<JiraRunState>();
    for (const t of tasks) set.add(t.state);
    return [...set].sort((a, b) => RUN_ORDER[a] - RUN_ORDER[b]);
  }, [tasks]);

  const visible = useMemo(
    () => sortTasks(filterTasks(tasks, filter), sort),
    [tasks, filter, sort]
  );

  // Tickets can disappear from under the current page — a filter change, a
  // removal, or a refresh that moves one to another status. Snap back rather
  // than stranding the user on a blank page.
  const safePage = clampPage(page, visible.length);
  useEffect(() => { if (safePage !== page) setPage(safePage); }, [safePage, page]);
  const pages = pageCount(visible.length);
  const shown = useMemo(() => pageSlice(visible, safePage), [visible, safePage]);
  const range = pageRange(safePage, visible.length);

  // Changing what you're looking at should start you at the top of it.
  const pickFilter = (v: string) => { setFilter(v); save(FILTER_STORE, v); setPage(0); };
  const pickSort = (v: SortKey) => { setSort(v); save(SORT_STORE, v); setPage(0); };

  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try { await fn(); } catch (err: any) { setError(err?.message ?? String(err)); }
    finally { setBusy(false); }
  };

  // Switching board replaces the whole list, so the open row and the page it
  // was on belong to tickets that are no longer here.
  const pickBoard = (file: string) =>
    guard(async () => {
      setTasks(await window.opendev.jira.selectBoard(file));
      setBoard(file);
      setExpanded(undefined);
      setPage(0);
      refreshBoards();
    });

  const submitEdit = () =>
    guard(async () => {
      const name = (edit?.value ?? '').trim();
      if (!edit || !name) return;
      const res = edit.mode === 'create'
        ? await window.opendev.jira.createBoard(name)
        : await window.opendev.jira.renameBoard(board, name);
      setTasks(res.tasks);
      setBoard(res.file);
      setEdit(undefined);
      setExpanded(undefined);
      setPage(0);
      refreshBoards();
    });

  // Show what the typed name will become, since the file — not the label — is
  // what the board actually is, and the same rules reject it either way.
  const editHint = useMemo(() => {
    if (!edit) return '';
    if (!edit.value.trim()) return 'A board is a file: .opendev/jira-<name>.json';
    try { return `→ .opendev/${boardFileFor(edit.value)}`; }
    catch (err: any) { return err?.message ?? 'Unusable name'; }
  }, [edit]);

  const openEdit = (mode: 'create' | 'rename') =>
    setEdit((cur) => (cur?.mode === mode
      ? undefined
      : { mode, value: mode === 'rename' ? (boards.find((b) => b.file === board)?.label ?? '') : '' }));

  const add = () =>
    guard(async () => {
      const keys = adding.trim();
      if (!keys) return;
      const res = await window.opendev.jira.add(keys);
      if (res.errors.length) setError(res.errors.join('\n'));
      if (res.added.length) setAdding('');
      refreshList();
    });

  const refreshAll = () =>
    guard(async () => {
      const res = await window.opendev.jira.refresh();
      setTasks(res.tasks);
      if (res.errors.length) setError(res.errors.join('\n'));
    });

  const start = (t: JiraTask) =>
    guard(async () => {
      setLogs((p) => ({ ...p, [t.id]: '' }));
      setExpanded(t.id);
      await window.opendev.jira.start(t.id);
      refreshList();
    });

  const stop = (t: JiraTask) =>
    guard(async () => {
      await window.opendev.jira.stop(t.id);
      refreshList();
    });

  const remove = (t: JiraTask) =>
    guard(async () => {
      await window.opendev.jira.remove(t.id);
      refreshList();
    });

  const test = () =>
    guard(async () => {
      const res = await window.opendev.jira.testConnection();
      if (res.ok) showToast(`Jira connected as ${res.user}`);
      else setError(res.error);
    });

  return (
    <div className="panel">
      <div className="panel-header">
        <span>Jira</span>
        <span className="grow" />
        <button title="Re-pull every ticket from Jira" disabled={busy} onClick={refreshAll}>↻</button>
        <button title="Test the Jira connection" disabled={busy} onClick={test}>✓</button>
      </div>

      {notConfigured && (
        <div className="jira-setup">
          {notConfigured}
          <div className="jira-setup-sub">
            Tickets below are placeholders until then — Refresh pulls their real summary and status.
          </div>
        </div>
      )}

      {boards.length > 0 && (
        <div className="jira-boards">
          <select
            value={board}
            disabled={busy}
            title="Which board (.opendev/jira*.json) this panel is working in"
            onChange={(e) => pickBoard(e.target.value)}
          >
            {boards.map((b) => (
              <option key={b.file} value={b.file}>{b.label} ({b.count})</option>
            ))}
          </select>
          <button title="Rename this board" disabled={busy} onClick={() => openEdit('rename')}>✎</button>
          <button title="New board" disabled={busy} onClick={() => openEdit('create')}>＋</button>
        </div>
      )}

      {edit && (
        <div className="jira-board-edit">
          <div className="jira-add">
            <input
              autoFocus
              value={edit.value}
              placeholder="board name, e.g. accounting-byz89"
              onChange={(e) => setEdit({ ...edit, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitEdit();
                if (e.key === 'Escape') setEdit(undefined);
              }}
            />
            <button className="primary" disabled={busy || !edit.value.trim()} onClick={submitEdit}>
              {edit.mode === 'create' ? 'Create' : 'Rename'}
            </button>
          </div>
          <div className="jira-board-hint">{editHint}</div>
        </div>
      )}

      <div className="jira-add">
        <input
          value={adding}
          placeholder="BYZ-89, BYZ-90…"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
        />
        <button className="primary" disabled={busy || !adding.trim()} onClick={add}>Add</button>
      </div>

      {tasks.length > 0 && (
        <div className="jira-tools">
          <select value={filter} onChange={(e) => pickFilter(e.target.value)} title="Filter by status">
            <option value="all">All ({tasks.length})</option>
            {jiraStatuses.length > 0 && (
              <optgroup label="Jira status">
                {jiraStatuses.map((s) => (
                  <option key={`jira:${s}`} value={`jira:${s}`}>
                    {s} ({tasks.filter((t) => t.status === s).length})
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Run state">
              {runStates.map((s) => (
                <option key={`run:${s}`} value={`run:${s}`}>
                  {LABEL[s]} ({tasks.filter((t) => t.state === s).length})
                </option>
              ))}
            </optgroup>
          </select>
          <select value={sort} onChange={(e) => pickSort(e.target.value as SortKey)} title="Sort order">
            <option value="key">Ticket ID</option>
            <option value="title">Name</option>
            <option value="status">Status</option>
            <option value="run">Run state</option>
            <option value="recent">Last run</option>
            <option value="added">Added</option>
          </select>
        </div>
      )}

      {error && <div className="jira-error" onClick={() => setError(undefined)}>{error}</div>}

      <div className="panel-body">
        {tasks.length === 0 && (
          <div className="jira-empty">
            No tickets on this board.
            <br />
            Add a key above, or ask the AI: “add BYZ-89 to the jira tab”.
          </div>
        )}

        {tasks.length > 0 && visible.length === 0 && (
          <div className="jira-empty">
            No tickets match this filter.
            <br />
            <a onClick={() => pickFilter('all')}>Show all {tasks.length}</a>
          </div>
        )}

        {shown.map((t) => {
          const open = expanded === t.id;
          const live = t.state === 'running';
          // Queued runs have no process yet, but stopping one is still
          // meaningful (it leaves the queue) and removing it is not.
          const pending = t.state === 'queued';
          return (
            <div key={t.id}>
              <div className="jira-row" onClick={() => setExpanded(open ? undefined : t.id)}>
                <span className={`dot ${DOT[t.state]}`} />
                <div className="jira-main">
                  <div className="jira-title">
                    <span className="jira-key">{t.key}</span>
                    <span className="jira-summary" title={t.title}>{t.title}</span>
                  </div>
                  <div className="jira-meta">
                    <span className={`jira-state ${t.state}`}>{LABEL[t.state]}</span>
                    {t.status && <span className="jira-badge">{t.status}</span>}
                    {(live || t.endedAt) && <span>{elapsed(t.startedAt, t.endedAt)}</span>}
                    {t.reportedAt && !t.reportError && <span className="jira-ok">↑ posted to Jira</span>}
                    {t.reportError && <span className="jira-warn" title={t.reportError}>⚠ {t.reportError}</span>}
                  </div>
                  {t.lastLine && (live || pending) && <div className="jira-last">↳ {t.lastLine}</div>}
                </div>
                <div className="actions" onClick={(e) => e.stopPropagation()}>
                  {live || pending
                    ? <button title={pending ? 'Take this ticket out of the queue' : 'Stop this run'}
                        disabled={busy} onClick={() => stop(t)}>■</button>
                    : <button title={t.state === 'idle' ? 'Start an AI run on this ticket' : 'Run again'}
                        disabled={busy} onClick={() => start(t)}>{t.state === 'idle' ? '▶' : '↻'}</button>}
                  {t.url && <button title="Open in Jira" onClick={() => window.open(t.url, '_blank')}>↗</button>}
                  <button title="Remove from panel" disabled={busy || live || pending} onClick={() => remove(t)}>×</button>
                </div>
              </div>

              {open && (
                <div className="jira-detail">
                  {t.description && <div className="jira-desc">{t.description.slice(0, 1200)}</div>}
                  <pre className="jira-log" ref={logRef}>{logs[t.id] || '(no output yet)'}</pre>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {visible.length > PAGE_SIZE && (
        <div className="jira-pager">
          <button title="First page" disabled={safePage === 0} onClick={() => setPage(0)}>«</button>
          <button title="Previous page" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>‹</button>
          <span className="jira-pager-label">
            {range.from}–{range.to} of {visible.length}
          </span>
          <button title="Next page" disabled={safePage >= pages - 1} onClick={() => setPage(safePage + 1)}>›</button>
          <button title="Last page" disabled={safePage >= pages - 1} onClick={() => setPage(pages - 1)}>»</button>
        </div>
      )}
    </div>
  );
}
