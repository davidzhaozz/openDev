import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import type { AgentInfo, AgentRun, PeerInfo, PeersStatus } from '../../../shared/types';

// A readable random link key — three short tokens, easy to type on a second
// machine but not guessable.
function generateLinkKey(): string {
  const part = () => Math.random().toString(36).slice(2, 7);
  return `${part()}-${part()}-${part()}`;
}

// Bottom-right panel: lists the workspace's AI agents, each with a Run/Stop
// button. Running an agent opens its streamed output as a center tab. New
// agents can be scaffolded (blank) or imported from existing code; the AI
// chat can also author them by writing files (the main-process folder
// watcher picks them up and fires onChanged).
export function AgentsPanel() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [runs, setRuns] = useState<Record<string, AgentRun>>({});
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [linkOpen, setLinkOpen] = useState(false);
  const [peerStatus, setPeerStatus] = useState<PeersStatus | null>(null);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [linkKeyDraft, setLinkKeyDraft] = useState('');
  const [pushing, setPushing] = useState<string | null>(null);
  // Per-agent run target: 'local' or a peer machineId.
  const [targets, setTargets] = useState<Record<string, string>>({});
  const openAgentRunTab = useStore((s) => s.openAgentRunTab);
  const openAiChatTab = useStore((s) => s.openAiChatTab);
  const showToast = useStore((s) => s.showToast);

  const refresh = () => { window.opendev.agents.list().then(setAgents).catch(() => {}); };
  const refreshPeers = () => {
    window.opendev.peers.status().then(setPeerStatus).catch(() => {});
    window.opendev.peers.list().then(setPeers).catch(() => {});
  };

  useEffect(() => {
    refresh();
    refreshPeers();
    const offChanged = window.opendev.agents.onChanged(refresh);
    const offPeers = window.opendev.peers.onChanged(refreshPeers);
    const offStream = window.opendev.agents.onStream((m) => {
      if (!m.done) return;
      // Mark the matching run done so the row button flips back to Run.
      setRuns((prev) => {
        const entry = Object.entries(prev).find(([, r]) => r.streamId === m.streamId);
        if (!entry) return prev;
        return { ...prev, [entry[0]]: { ...entry[1], status: m.status ?? 'stopped' } };
      });
    });
    return () => { offChanged(); offPeers(); offStream(); };
  }, []);

  const submitCreate = async () => {
    if (!newName.trim()) { showToast('Enter an agent name.', 2000); return; }
    const prompt = newDesc.trim();
    try {
      // Scaffold the folder + manifest first so the agent exists immediately.
      const info = await window.opendev.agents.create({ name: newName.trim(), description: prompt });
      setNewName(''); setNewDesc(''); setCreating(false);
      // If the user described what the agent should do, hand that prompt to
      // the AI in a fresh chat tab so it writes the agent's code. The folder
      // watcher refreshes this panel as the AI writes files.
      if (prompt) {
        openAiChatTab({
          name: `Build: ${info.name}`,
          initialPrompt:
            `Build the AI agent at \`.opendev/agents/${info.slug}/\`. It already has an \`agent.json\` ` +
            `manifest and a starter \`index.js\`. Replace the entry file (and add any other files or ` +
            `bundled deps it needs) so the agent does the following:\n\n${prompt}\n\n` +
            `Follow the agent runtime contract from your instructions: cwd is the workspace root, ` +
            `\`OPENDEV_WORKSPACE_ROOT\` / \`OPENDEV_AGENT_DIR\` are in env, and results go to stdout ` +
            `(emit a full HTML document for a visual artifact, otherwise plain text).`
        });
      }
    } catch (err) {
      showToast(`Create failed: ${(err as Error).message}`, 4000);
    }
  };

  const doImport = async () => {
    try {
      const r = await window.opendev.agents.importPick();
      if (r) showToast(`Imported "${r.name}".`, 2500);
    } catch (err) {
      showToast(`Import failed: ${(err as Error).message}`, 4000);
    }
  };

  const runAgent = async (a: AgentInfo) => {
    const target = targets[a.slug] || 'local';
    try {
      const r = await window.opendev.agents.run(a.slug, target);
      setRuns((prev) => ({ ...prev, [a.slug]: r }));
      // Show the peer's friendly name in the run tab, not its machineId.
      const targetLabel = target === 'local'
        ? 'local'
        : (peers.find((p) => p.machineId === target)?.name ?? target);
      openAgentRunTab({ runId: r.runId, agentSlug: a.slug, name: a.name, target: targetLabel });
    } catch (err) {
      showToast(`Run failed: ${(err as Error).message}`, 4500);
    }
  };

  const pushRepoTo = async (p: PeerInfo) => {
    setPushing(p.machineId);
    try {
      await window.opendev.peers.pushRepo(p.machineId);
      showToast(`Repo pushed to ${p.name}.`, 2500);
    } catch (err) {
      showToast(`Push failed: ${(err as Error).message}`, 4500);
    } finally {
      setPushing(null);
    }
  };

  const stopAgent = async (a: AgentInfo) => {
    const r = runs[a.slug];
    if (!r) return;
    await window.opendev.agents.stop(r.runId);
    setRuns((prev) => ({ ...prev, [a.slug]: { ...r, status: 'stopped' } }));
  };

  const removeAgent = async (a: AgentInfo) => {
    await window.opendev.agents.delete(a.slug);
  };

  const saveLinkKey = async () => {
    await window.opendev.peers.setLinkKey(linkKeyDraft.trim());
    setLinkKeyDraft('');
    refreshPeers();
  };
  const toggleLinking = async () => {
    if (!peerStatus) return;
    await window.opendev.peers.setEnabled(!peerStatus.linkingEnabled);
    refreshPeers();
  };

  return (
    <div className="agents-panel">
      <div className="agents-head">
        <span className="agents-title">AI Agents</span>
        <span style={{ flex: 1 }} />
        <button className="agents-btn" onClick={() => setCreating((v) => !v)}>+ New</button>
        <button className="agents-btn" onClick={doImport}>Import</button>
        <button
          className={`agents-btn ${peerStatus?.linkingEnabled ? 'on' : ''}`}
          onClick={() => setLinkOpen((v) => !v)}
          title="Link another machine on your network"
        >
          Link{peers.length > 0 ? ` (${peers.length})` : ''}
        </button>
      </div>

      {linkOpen && peerStatus && (
        <div className="agents-link">
          <div className="agents-link-row">
            <span className="agents-link-label">This machine</span>
            <span className="agents-link-val">{peerStatus.machineName}</span>
          </div>
          <div className="agents-link-row">
            <span className="agents-link-label">Link key</span>
            <input
              className="agents-link-key"
              placeholder={peerStatus.hasLinkKey ? '•••••• (set)' : 'shared key'}
              value={linkKeyDraft}
              onChange={(e) => setLinkKeyDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveLinkKey(); }}
            />
            <button onClick={() => setLinkKeyDraft(generateLinkKey())} title="Generate a key">⚄</button>
            <button onClick={saveLinkKey} disabled={!linkKeyDraft.trim()}>Set</button>
          </div>
          <div className="agents-link-row">
            <button
              className={peerStatus.linkingEnabled ? 'agents-link-toggle on' : 'agents-link-toggle'}
              onClick={toggleLinking}
              disabled={!peerStatus.hasLinkKey}
            >
              {peerStatus.linkingEnabled ? 'Linking ON' : 'Linking OFF'}
            </button>
            <span className="agents-link-hint">
              {peerStatus.hasLinkKey
                ? 'Enter the same key on another machine to link it.'
                : 'Set a key first. Linking lets trusted peers run code here.'}
            </span>
          </div>
          {peerStatus.linkingEnabled && (
            <div className="agents-peers">
              {peers.length === 0 && <div className="agents-peers-empty">No peers found yet…</div>}
              {peers.map((p) => (
                <div key={p.machineId} className="agents-peer">
                  <span className={`agents-peer-dot ${p.online ? 'on' : ''}`} />
                  <span className="agents-peer-name">{p.name}</span>
                  <span className="agents-peer-addr">{p.address}</span>
                  <span style={{ flex: 1 }} />
                  <button
                    className="agents-peer-push"
                    onClick={() => pushRepoTo(p)}
                    disabled={pushing === p.machineId}
                  >
                    {pushing === p.machineId ? 'Pushing…' : 'Push repo'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {creating && (
        <div className="agents-create">
          <input
            placeholder="Agent name (e.g. Test Runner)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            autoFocus
          />
          <textarea
            className="agents-create-prompt"
            placeholder="Describe what the agent should do — this prompt is handed to the AI to write the agent's code. e.g. &quot;Run the test suite and summarize pass/fail counts&quot;, or &quot;Analyze imports across the codebase and emit an HTML dependency graph&quot;."
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            rows={5}
          />
          <div className="agents-create-actions">
            <button className="primary" onClick={submitCreate}>
              {newDesc.trim() ? 'Create & build with AI' : 'Create blank'}
            </button>
            <button onClick={() => { setCreating(false); setNewName(''); setNewDesc(''); }}>Cancel</button>
          </div>
        </div>
      )}

      <div className="agents-list">
        {agents.length === 0 && (
          <div className="agents-empty">Loading agents…</div>
        )}
        {agents.map((a) => {
          const running = runs[a.slug]?.status === 'running';
          return (
            <div key={a.slug} className="agent-row">
              <div className="agent-row-main">
                <span className="agent-row-name">
                  {a.name}
                  {a.createdBy === 'builtin' && <span className="agent-builtin-badge">built-in</span>}
                </span>
                {a.description && <span className="agent-row-desc">{a.description}</span>}
                <span className="agent-row-meta">{a.runtime} · {a.entry}</span>
              </div>
              <div className="agent-row-actions">
                {peers.length > 0 && (
                  <select
                    className="agent-target"
                    value={targets[a.slug] || 'local'}
                    onChange={(e) => setTargets((prev) => ({ ...prev, [a.slug]: e.target.value }))}
                    title="Where to run this agent"
                  >
                    <option value="local">This machine</option>
                    {peers.map((p) => <option key={p.machineId} value={p.machineId}>{p.name}</option>)}
                  </select>
                )}
                {running
                  ? <button className="agent-stop" onClick={() => stopAgent(a)}>Stop</button>
                  : <button className="agent-run-btn" onClick={() => runAgent(a)}>Run</button>}
                {a.createdBy !== 'builtin' && (
                  <button className="agent-del" title="Delete agent" onClick={() => removeAgent(a)}>✕</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
