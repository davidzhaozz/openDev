import { useEffect, useMemo, useState } from 'react';
import type { NetEntry } from '../../../shared/types';
import { JsonTree } from '../components/JsonTree';
import { useStore } from '../state/store';

// Center-tab detail view for one captured call. Four sub-tabs mirroring the
// shape people already know from DevTools and the REST workspace: an
// at-a-glance summary, the two header bags, and each body pretty-printed.

type View = 'summary' | 'request' | 'response' | 'headers';

function looksJson(contentType?: string, body?: string): boolean {
  if (contentType && /\b(json|\+json)\b/i.test(contentType)) return true;
  const t = body?.trim();
  return !!t && (t.startsWith('{') || t.startsWith('[')) && t.length < 2_000_000;
}

function fmtSize(n?: number): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function statusTone(e: NetEntry): string {
  if (e.error) return 'err';
  if (e.status == null) return 'pending';
  if (e.status >= 500) return 'err';
  if (e.status >= 400) return 'warn';
  if (e.status >= 300) return 'redir';
  return 'ok';
}

export function NetworkWorkspace({ entryId }: { entryId: string }) {
  const [entry, setEntry] = useState<NetEntry | null>(null);
  const [missing, setMissing] = useState(false);
  const [view, setView] = useState<View>('summary');
  const showToast = useStore((s) => s.showToast);

  useEffect(() => {
    let alive = true;
    setEntry(null);
    setMissing(false);
    window.opendev.network.get(entryId)
      .then((e) => { if (!alive) return; if (e) setEntry(e); else setMissing(true); })
      .catch(() => { if (alive) setMissing(true); });
    return () => { alive = false; };
  }, [entryId]);

  // A row still in flight has no response yet; re-read when it finishes.
  useEffect(() => {
    if (!entry?.pending) return;
    const off = window.opendev.network.onEntry((s) => {
      if (s.id !== entryId || s.pending) return;
      window.opendev.network.get(entryId).then((e) => { if (e) setEntry(e); }).catch(() => {});
    });
    return off;
  }, [entry?.pending, entryId]);

  const copy = (label: string, text: string) => {
    navigator.clipboard.writeText(text)
      .then(() => showToast(`${label} copied`, 1800))
      .catch(() => showToast('Clipboard unavailable', 2500));
  };

  /** The call as a runnable curl — the thing you actually want at 2am. */
  const asCurl = useMemo(() => {
    if (!entry) return '';
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const parts = [`curl -X ${entry.method} ${q(entry.url)}`];
    for (const [k, v] of Object.entries(entry.requestHeaders || {})) {
      parts.push(`  -H ${q(`${k}: ${v}`)}`);
    }
    if (entry.requestBody) parts.push(`  --data-raw ${q(entry.requestBody)}`);
    return parts.join(' \\\n');
  }, [entry]);

  if (missing) {
    return (
      <div className="net-ws-empty">
        This call has aged out of the log.
        <div className="net-ws-empty-sub">The panel keeps the most recent 500 calls.</div>
      </div>
    );
  }
  if (!entry) return <div className="net-ws-empty">Loading…</div>;

  return (
    <div className="net-ws">
      <div className="net-ws-head">
        <span className={`net-ws-status ${statusTone(entry)}`}>
          {entry.error ? 'ERR' : entry.status ?? '···'}
        </span>
        <span className="net-ws-method">{entry.method}</span>
        <span className="net-ws-url" title={entry.url}>{entry.url}</span>
        <span className="grow" />
        <button onClick={() => copy('curl command', asCurl)} title="Copy as a curl command">Copy as curl</button>
      </div>

      {entry.error && <div className="net-ws-error">{entry.error}</div>}

      <div className="net-ws-tabs">
        {(['summary', 'request', 'response', 'headers'] as const).map((k) => (
          <div
            key={k}
            className={`net-ws-tab ${view === k ? 'active' : ''}`}
            onClick={() => setView(k)}
          >
            {k[0].toUpperCase() + k.slice(1)}
          </div>
        ))}
      </div>

      <div className="net-ws-body">
        {view === 'summary' && <Summary entry={entry} />}
        {view === 'request' && (
          <Body
            title="Request body"
            body={entry.requestBody}
            truncated={entry.requestBodyTruncated}
            contentType={entry.requestHeaders?.['content-type'] || entry.requestHeaders?.['Content-Type']}
            onCopy={(t) => copy('Request body', t)}
            emptyNote="This request had no body."
          />
        )}
        {view === 'response' && (
          <Body
            title="Response body"
            body={entry.responseBody}
            truncated={entry.responseBodyTruncated}
            contentType={entry.contentType}
            onCopy={(t) => copy('Response body', t)}
            emptyNote={entry.pending ? 'Still in flight…' : 'This response had no body.'}
          />
        )}
        {view === 'headers' && (
          <div className="net-ws-headers">
            <HeaderTable title="Request headers" headers={entry.requestHeaders} />
            <HeaderTable title="Response headers" headers={entry.responseHeaders} />
          </div>
        )}
      </div>
    </div>
  );
}

function Summary({ entry }: { entry: NetEntry }) {
  const rows: Array<[string, string]> = [
    ['URL', entry.url],
    ['Method', entry.method],
    ['Status', entry.error ? `failed — ${entry.error}` : `${entry.status ?? '—'} ${entry.statusText || ''}`.trim()],
    ['Source', entry.source === 'ide' ? 'openDev (main process)' : 'Browser panel'],
    ['Origin', entry.origin],
    ...(entry.resourceType ? [['Resource type', entry.resourceType] as [string, string]] : []),
    ['Started', new Date(entry.startedAt).toLocaleTimeString()],
    ['Duration', entry.durationMs == null ? '—' : `${entry.durationMs} ms`],
    ['Response size', fmtSize(entry.responseSize)],
    ['Content type', entry.contentType || '—']
  ];
  return (
    <div className="net-ws-summary">
      {rows.map(([k, v]) => (
        <div className="net-ws-srow" key={k}>
          <span className="net-ws-skey">{k}</span>
          <span className="net-ws-sval">{v}</span>
        </div>
      ))}
    </div>
  );
}

function HeaderTable({ title, headers }: { title: string; headers?: Record<string, string> }) {
  const list = Object.entries(headers || {}).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="net-ws-htable">
      <div className="net-ws-htitle">{title} <span className="net-ws-hcount">{list.length}</span></div>
      {list.length === 0 && <div className="net-ws-hempty">None recorded.</div>}
      {list.map(([k, v]) => (
        <div className="net-ws-hrow" key={k}>
          <span className="net-ws-hkey">{k}</span>
          <span className="net-ws-hval">{v}</span>
        </div>
      ))}
    </div>
  );
}

function Body({
  title, body, truncated, contentType, onCopy, emptyNote
}: {
  title: string;
  body?: string;
  truncated?: boolean;
  contentType?: string;
  onCopy: (text: string) => void;
  emptyNote: string;
}) {
  const [raw, setRaw] = useState(false);
  const parsed = useMemo(() => {
    if (raw || !looksJson(contentType, body) || !body) return null;
    try { return JSON.parse(body); } catch { return null; }
  }, [raw, body, contentType]);

  if (!body) return <div className="net-ws-hempty">{emptyNote}</div>;

  return (
    <div className="net-ws-bodywrap">
      <div className="net-ws-bodybar">
        <span className="net-ws-htitle">{title}</span>
        {contentType && <span className="net-ws-ct">{contentType.split(';')[0]}</span>}
        <span className="grow" />
        {looksJson(contentType, body) && (
          <button className="net-ws-mini" onClick={() => setRaw((r) => !r)}>
            {raw ? 'Pretty' : 'Raw'}
          </button>
        )}
        <button className="net-ws-mini" onClick={() => onCopy(body)}>Copy</button>
      </div>
      {truncated && (
        <div className="net-ws-trunc">Body truncated at 256 KB — the rest was not captured.</div>
      )}
      <div className="net-ws-bodyscroll">
        {parsed !== null
          ? <JsonTree data={parsed} defaultDepth={3} />
          : <pre className="net-ws-raw">{body}</pre>}
      </div>
    </div>
  );
}
