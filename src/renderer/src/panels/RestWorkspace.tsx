import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { Resizer } from '../components/Resizer';
import { JsonTree } from '../components/JsonTree';
import { QueryHistoryButton } from '../components/QueryHistoryButton';
import type { RestAuth, RestBody, RestHeader, RestMethod, RestParam, RestRequestSpec, RestResponse, RestSavedRequest } from '../../../shared/types';
import { modKey } from '../platformUi';

const METHODS: RestMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

type EditorTab = 'params' | 'headers' | 'body' | 'auth';

function looksJson(ct?: string): boolean {
  if (!ct) return false;
  return /json|\+json/i.test(ct);
}

function tryPrettyJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

export function RestWorkspace({ tabId }: { tabId: string }) {
  const spec = useStore(s => s.restSpec);
  const setSpec = useStore(s => s.setRestSpec);
  const result = useStore(s => s.restResult);
  const setResult = useStore(s => s.setRestResult);
  const savedId = useStore(s => s.restSavedId);
  const setSavedId = useStore(s => s.setRestSavedId);
  const restRunRequest = useStore(s => s.restRunRequest);
  const layout = useStore(s => s.layout);
  const setLayout = useStore(s => s.setLayout);
  const showToast = useStore(s => s.showToast);
  const renameCenterTab = useStore(s => s.renameCenterTab);

  const [tab, setTab] = useState<EditorTab>('params');
  const [running, setRunning] = useState(false);
  const [historyTick, setHistoryTick] = useState(0);
  const [responseView, setResponseView] = useState<'pretty' | 'raw' | 'headers'>('pretty');
  const lastRunRequest = useRef(0);

  const patch = (p: Partial<RestRequestSpec>) => setSpec((prev) => ({ ...prev, ...p }));

  const run = async () => {
    if (!spec.url.trim()) { setResult({ error: 'URL is required' }); return; }
    setRunning(true);
    const startedAt = Date.now();
    let ok = false;
    let status: number | undefined;
    let durationMs: number | undefined;
    try {
      const r = await window.opendev.rest.send(spec);
      setResult(r);
      if (!('error' in r)) {
        ok = r.ok;
        status = r.status;
        durationMs = r.durationMs;
      }
    } catch (e: any) {
      setResult({ error: e?.message || String(e) });
    } finally {
      setRunning(false);
      window.opendev.history.append('rest', {
        id: `h-${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
        text: `${spec.method} ${spec.url}`,
        runAt: startedAt,
        ok,
        durationMs: durationMs ?? (Date.now() - startedAt),
        status,
        restMethod: spec.method,
        restUrl: spec.url
      }).then(() => setHistoryTick((t) => t + 1)).catch(() => {});
    }
  };

  useEffect(() => {
    if (restRunRequest > lastRunRequest.current && !running) {
      lastRunRequest.current = restRunRequest;
      run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restRunRequest]);

  const save = async () => {
    if (!spec.url.trim()) { showToast('URL is required to save', 2500); return; }
    const existingName = savedId ? (await window.opendev.rest.listSaved()).find(r => r.id === savedId)?.name : '';
    const name = prompt('Name for this request:', existingName || `${spec.method} ${spec.url}`);
    if (!name) return;
    const id = savedId || `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record: RestSavedRequest = { id, name, updatedAt: Date.now(), ...spec };
    try {
      await window.opendev.rest.save(record);
      setSavedId(id);
      renameCenterTab(tabId, name);
      showToast(`Saved "${name}"`, 2000);
    } catch (e: any) {
      showToast(`Save failed: ${e?.message || e}`, 3500);
    }
  };

  const restoreFromHistory = (text: string) => {
    const m = text.match(/^([A-Z]+)\s+(.+)$/);
    if (!m) return;
    patch({ method: m[1] as RestMethod, url: m[2] });
  };

  const isError = result && 'error' in result;
  const response = result && !('error' in result) ? (result as RestResponse) : null;

  return (
    <div className="rest-workspace">
      <div className="rest-toolbar">
        <select
          className="rest-method-select"
          value={spec.method}
          onChange={(e) => patch({ method: e.target.value as RestMethod })}
        >
          {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <input
          className="rest-url"
          placeholder="https://api.example.com/endpoint"
          value={spec.url}
          onChange={(e) => patch({ url: e.target.value })}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); } }}
          spellCheck={false}
        />
        <button className="primary" disabled={running} onClick={run}>{running ? 'Sending…' : `Send ${modKey()}↵`}</button>
        <button onClick={save} title={savedId ? 'Update saved request' : 'Save to right-panel collection'}>
          {savedId ? 'Update' : 'Save'}
        </button>
        <QueryHistoryButton kind="rest" refreshKey={historyTick} onPick={restoreFromHistory} />
      </div>

      <div className="rest-tabs">
        {(['params', 'headers', 'body', 'auth'] as EditorTab[]).map(k => (
          <div key={k}
            className={`rest-tab ${tab === k ? 'active' : ''}`}
            onClick={() => setTab(k)}
          >
            {k === 'params' ? 'Params' : k === 'headers' ? 'Headers' : k === 'body' ? 'Body' : 'Auth'}
            {k === 'params' && spec.params.filter(p => (p.enabled ?? true) && p.key).length > 0 && <span className="rest-tab-count">{spec.params.filter(p => (p.enabled ?? true) && p.key).length}</span>}
            {k === 'headers' && spec.headers.filter(h => (h.enabled ?? true) && h.key).length > 0 && <span className="rest-tab-count">{spec.headers.filter(h => (h.enabled ?? true) && h.key).length}</span>}
            {k === 'body' && spec.body.kind !== 'none' && <span className="rest-tab-dot" />}
            {k === 'auth' && spec.auth.kind !== 'none' && <span className="rest-tab-dot" />}
          </div>
        ))}
      </div>

      <div className="rest-editor">
        {tab === 'params' && (
          <KeyValEditor
            rows={spec.params}
            onChange={(rows) => patch({ params: rows })}
            placeholder={['key', 'value']}
          />
        )}
        {tab === 'headers' && (
          <KeyValEditor
            rows={spec.headers}
            onChange={(rows) => patch({ headers: rows })}
            placeholder={['Header-Name', 'value']}
          />
        )}
        {tab === 'body' && (
          <BodyEditor body={spec.body} onChange={(body) => patch({ body })} />
        )}
        {tab === 'auth' && (
          <AuthEditor auth={spec.auth} onChange={(auth) => patch({ auth })} />
        )}
      </div>

      <Resizer
        orientation="horizontal"
        value={layout.restSplit}
        min={140}
        max={1000}
        onChange={(v) => setLayout({ restSplit: v })}
        invert
      />

      <div className="rest-response" style={{ height: layout.restSplit, flex: `0 0 ${layout.restSplit}px` }}>
        <div className="rest-response-head">
          {response && (
            <>
              <span className={`rest-status ${response.ok ? 'ok' : 'bad'}`}>
                {response.status} {response.statusText}
              </span>
              <span className="rest-meta">{response.durationMs} ms · {formatBytes(response.sizeBytes)}</span>
            </>
          )}
          {!result && <span className="rest-meta">No response yet — hit Send.</span>}
          <span className="grow" />
          {response && (
            <div className="rest-resp-tabs">
              <div className={`rest-resp-tab ${responseView === 'pretty' ? 'active' : ''}`} onClick={() => setResponseView('pretty')}>Pretty</div>
              <div className={`rest-resp-tab ${responseView === 'raw' ? 'active' : ''}`} onClick={() => setResponseView('raw')}>Raw</div>
              <div className={`rest-resp-tab ${responseView === 'headers' ? 'active' : ''}`} onClick={() => setResponseView('headers')}>Headers <span className="rest-tab-count">{response.headers.length}</span></div>
            </div>
          )}
        </div>
        <div className="rest-response-body">
          {isError && <div className="rest-err">{(result as { error: string }).error}</div>}
          {response && responseView === 'pretty' && <PrettyBody response={response} />}
          {response && responseView === 'raw' && <pre className="rest-raw">{response.body}</pre>}
          {response && responseView === 'headers' && (
            <table className="rest-headers-table">
              <tbody>
                {response.headers.map(([k, v]) => (
                  <tr key={k}><td className="rest-header-k">{k}</td><td>{v}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function PrettyBody({ response }: { response: RestResponse }) {
  if (looksJson(response.contentType)) {
    try {
      const parsed = JSON.parse(response.body);
      return <JsonTree data={parsed} defaultDepth={2} />;
    } catch {
      // fall through to raw
    }
  }
  return <pre className="rest-raw">{response.body}</pre>;
}

function KeyValEditor({ rows, onChange, placeholder }: {
  rows: Array<{ key: string; value: string; enabled?: boolean }>;
  onChange: (rows: RestHeader[]) => void;
  placeholder: [string, string];
}) {
  // Show one extra empty row at the bottom so the user can always add.
  const display = [...rows, { key: '', value: '', enabled: true }];
  const update = (i: number, patch: Partial<{ key: string; value: string; enabled: boolean }>) => {
    const next = [...rows];
    if (i === rows.length) {
      // Editing the placeholder row promotes it to a real entry.
      next.push({ key: '', value: '', enabled: true, ...patch });
    } else {
      next[i] = { ...next[i], ...patch };
    }
    // Drop wholly-empty trailing entries on every edit.
    while (next.length && !next[next.length - 1].key && !next[next.length - 1].value) {
      next.pop();
    }
    onChange(next);
  };
  const remove = (i: number) => {
    if (i >= rows.length) return;
    const next = rows.filter((_, j) => j !== i);
    onChange(next);
  };
  return (
    <div className="kv-editor">
      <div className="kv-head"><span>✓</span><span>Key</span><span>Value</span><span /></div>
      {display.map((r, i) => (
        <div key={i} className="kv-row">
          <input type="checkbox" checked={r.enabled ?? true} onChange={(e) => update(i, { enabled: e.target.checked })} />
          <input className="kv-input" placeholder={placeholder[0]} value={r.key} onChange={(e) => update(i, { key: e.target.value })} />
          <input className="kv-input" placeholder={placeholder[1]} value={r.value} onChange={(e) => update(i, { value: e.target.value })} />
          {i < rows.length ? <button className="kv-del" onClick={() => remove(i)} title="Remove">×</button> : <span />}
        </div>
      ))}
    </div>
  );
}

function BodyEditor({ body, onChange }: { body: RestBody; onChange: (b: RestBody) => void }) {
  const kind = body.kind;
  return (
    <div className="rest-body-editor">
      <div className="rest-body-modes">
        {(['none', 'json', 'text', 'form'] as const).map(k => (
          <label key={k} className={`rest-body-mode ${kind === k ? 'active' : ''}`}>
            <input
              type="radio"
              name="bodymode"
              checked={kind === k}
              onChange={() => {
                if (k === 'none') onChange({ kind: 'none' });
                else if (k === 'json') onChange({ kind: 'json', text: body.kind === 'json' ? body.text : (body.kind === 'text' ? body.text : '') });
                else if (k === 'text') onChange({ kind: 'text', text: body.kind === 'text' ? body.text : (body.kind === 'json' ? body.text : ''), contentType: body.kind === 'text' ? body.contentType : 'text/plain' });
                else onChange({ kind: 'form', fields: body.kind === 'form' ? body.fields : [] });
              }}
            />
            {k === 'none' ? 'None' : k === 'json' ? 'JSON' : k === 'text' ? 'Raw' : 'Form'}
          </label>
        ))}
        {body.kind === 'json' && (
          <button className="rest-prettify" onClick={() => onChange({ kind: 'json', text: tryPrettyJson(body.text) })}>Beautify</button>
        )}
      </div>
      {body.kind === 'none' && <div className="rest-body-empty">No body will be sent.</div>}
      {body.kind === 'json' && (
        <textarea
          className="rest-body-textarea code-font"
          spellCheck={false}
          value={body.text}
          onChange={(e) => onChange({ kind: 'json', text: e.target.value })}
          placeholder={`{\n  "key": "value"\n}`}
        />
      )}
      {body.kind === 'text' && (
        <>
          <input
            className="rest-content-type"
            placeholder="Content-Type (e.g. text/plain)"
            value={body.contentType || ''}
            onChange={(e) => onChange({ kind: 'text', text: body.text, contentType: e.target.value })}
          />
          <textarea
            className="rest-body-textarea code-font"
            spellCheck={false}
            value={body.text}
            onChange={(e) => onChange({ kind: 'text', text: e.target.value, contentType: body.contentType })}
            placeholder="Request body…"
          />
        </>
      )}
      {body.kind === 'form' && (
        <KeyValEditor
          rows={body.fields}
          onChange={(rows) => onChange({ kind: 'form', fields: rows })}
          placeholder={['field', 'value']}
        />
      )}
    </div>
  );
}

function AuthEditor({ auth, onChange }: { auth: RestAuth; onChange: (a: RestAuth) => void }) {
  return (
    <div className="rest-auth-editor">
      <div className="rest-body-modes">
        {(['none', 'bearer', 'basic'] as const).map(k => (
          <label key={k} className={`rest-body-mode ${auth.kind === k ? 'active' : ''}`}>
            <input
              type="radio"
              name="authmode"
              checked={auth.kind === k}
              onChange={() => {
                if (k === 'none') onChange({ kind: 'none' });
                else if (k === 'bearer') onChange({ kind: 'bearer', token: auth.kind === 'bearer' ? auth.token : '' });
                else onChange({ kind: 'basic', username: auth.kind === 'basic' ? auth.username : '', password: auth.kind === 'basic' ? auth.password : '' });
              }}
            />
            {k === 'none' ? 'None' : k === 'bearer' ? 'Bearer Token' : 'Basic'}
          </label>
        ))}
      </div>
      {auth.kind === 'none' && <div className="rest-body-empty">No auth header will be set.</div>}
      {auth.kind === 'bearer' && (
        <div className="rest-auth-row">
          <label>Token</label>
          <input
            className="rest-auth-input"
            type="password"
            placeholder="eyJhbGciOi…"
            value={auth.token}
            onChange={(e) => onChange({ kind: 'bearer', token: e.target.value })}
          />
        </div>
      )}
      {auth.kind === 'basic' && (
        <>
          <div className="rest-auth-row">
            <label>Username</label>
            <input className="rest-auth-input" value={auth.username} onChange={(e) => onChange({ kind: 'basic', username: e.target.value, password: auth.password })} />
          </div>
          <div className="rest-auth-row">
            <label>Password</label>
            <input className="rest-auth-input" type="password" value={auth.password} onChange={(e) => onChange({ kind: 'basic', username: auth.username, password: e.target.value })} />
          </div>
        </>
      )}
    </div>
  );
}
