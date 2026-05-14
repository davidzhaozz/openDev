import { useEffect, useRef, useState } from 'react';
import type { AgentRunStatus } from '../../../shared/types';

type Props = {
  runId: string;
  agentSlug: string;
  name: string;
  target: string;
};

// Renderer-side cap so a runaway agent doesn't blow up the React tree.
const MAX_OUTPUT = 4 * 1024 * 1024;

// A center tab showing one agent run. Subscribes to the agent stream
// filtered by runId. If the agent's stdout starts with a full HTML
// document, render it in a sandboxed iframe; otherwise stream it as a
// plain monospace log.
export function AgentRunWorkspace({ runId, agentSlug, name, target }: Props) {
  const [out, setOut] = useState('');
  const [status, setStatus] = useState<AgentRunStatus>('running');
  const bodyRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const off = window.opendev.agents.onStream((m) => {
      if (m.streamId !== runId) return;
      if (m.chunk) {
        setOut((o) => {
          const next = o + m.chunk;
          if (next.length > MAX_OUTPUT) {
            if (o.endsWith('[…truncated…]')) return o;
            return next.slice(0, MAX_OUTPUT) + '[…truncated…]';
          }
          return next;
        });
      }
      if (m.done) setStatus(m.status ?? 'stopped');
    });
    return off;
  }, [runId]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [out]);

  const stop = () => { window.opendev.agents.stop(runId); };

  const trimmed = out.trimStart().toLowerCase();
  const isHtml = trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html');

  return (
    <div className="agent-run">
      <div className="agent-run-head">
        <span className="agent-run-name">{name}</span>
        <span className="agent-run-slug">{agentSlug}</span>
        {target !== 'local' && <span className="agent-run-target">running on {target}</span>}
        <span className={`agent-run-status ${status}`}>{status}</span>
        <span style={{ flex: 1 }} />
        {status === 'running' && <button onClick={stop}>Stop</button>}
      </div>
      {isHtml ? (
        <iframe
          className="agent-run-frame"
          title={name}
          // allow-scripts so visual artifacts (graphs) can run their own JS;
          // no allow-same-origin — the document stays sandboxed from the app.
          sandbox="allow-scripts"
          srcDoc={out}
        />
      ) : (
        <pre ref={bodyRef} className="agent-run-body">
          {out || (status === 'running' ? '' : '(no output)')}
        </pre>
      )}
    </div>
  );
}
