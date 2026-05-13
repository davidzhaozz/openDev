import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { Resizer } from '../components/Resizer';
import { JsonTree } from '../components/JsonTree';

function parseRequest(text: string): { method: string; path: string; body?: unknown; parseError?: string } {
  const trimmed = text.trim();
  let method = 'GET';
  let path = '/_search';
  let bodyText = trimmed;
  // Detect "GET /_search" or "POST /index/_search" as the first line
  const firstNl = trimmed.indexOf('\n');
  const firstLine = (firstNl === -1 ? trimmed : trimmed.slice(0, firstNl)).trim();
  const m = firstLine.match(/^(GET|POST|PUT|DELETE|HEAD)\s+(\/[^\s]*)\s*$/i);
  if (m) {
    method = m[1].toUpperCase();
    path = m[2];
    bodyText = firstNl === -1 ? '' : trimmed.slice(firstNl + 1).trim();
  }
  if (!bodyText) return { method, path };
  try { return { method, path, body: JSON.parse(bodyText) }; }
  catch (e: any) { return { method, path, parseError: `JSON parse error: ${e?.message}` }; }
}

export function EsWorkspace() {
  const esText = useStore(s => s.esText);
  const setEsText = useStore(s => s.setEsText);
  const esResult = useStore(s => s.esResult);
  const setEsResult = useStore(s => s.setEsResult);
  const sqlConnId = useStore(s => s.sqlConnId);
  const esRunRequest = useStore(s => s.esRunRequest);
  const layout = useStore(s => s.layout);
  const setLayout = useStore(s => s.setLayout);
  const [running, setRunning] = useState(false);
  const lastRunRequest = useRef(0);

  const run = async () => {
    if (!sqlConnId) { setEsResult({ error: 'Pick an ES connection on the right panel first.' }); return; }
    const parsed = parseRequest(esText);
    if (parsed.parseError) { setEsResult({ error: parsed.parseError }); return; }
    setRunning(true);
    try {
      const r = await window.opendev.db.esRequest(sqlConnId, { method: parsed.method, path: parsed.path, body: parsed.body });
      setEsResult(r);
    } catch (e: any) {
      setEsResult({ error: e?.message || String(e) });
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    if (esRunRequest > lastRunRequest.current && !running) {
      lastRunRequest.current = esRunRequest;
      run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [esRunRequest]);

  const isError = esResult && 'error' in esResult;
  const result = esResult && !('error' in esResult) ? esResult : null;
  const parsed = parseRequest(esText);

  return (
    <div className="sql-workspace">
      <div className="sql-toolbar">
        <button className="primary" disabled={running || !sqlConnId} onClick={run}>{running ? 'Running…' : 'Send ⌘↵'}</button>
        <span className="es-meta">{parsed.method} {parsed.path}</span>
        <span className="grow" />
        <span className="sql-status">
          {sqlConnId ? `connected · ${sqlConnId.slice(0, 8)}` : 'no connection'}
          {result && ` · ${result.status} · ${result.durationMs} ms`}
        </span>
      </div>

      <div className="sql-results">
        <div className="sql-results-body es-results-body">
          {!esResult && <div className="sql-empty es-empty">Send a request to see the response here.</div>}
          {isError && <div className="db-test-error" style={{ padding: 12 }}>{(esResult as { error: string }).error}</div>}
          {result && <JsonTree data={result.body} defaultDepth={2} />}
        </div>
      </div>

      <Resizer orientation="horizontal" value={layout.sqlSplit} min={120} max={800}
        onChange={(v) => setLayout({ sqlSplit: v })} invert />

      <textarea
        className="sql-editor"
        value={esText}
        spellCheck={false}
        onChange={(e) => setEsText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
        }}
        placeholder={`GET /_search\n{\n  "query": { "match_all": {} },\n  "size": 10\n}`}
        style={{ height: layout.sqlSplit, flex: `0 0 ${layout.sqlSplit}px` }}
      />
    </div>
  );
}
