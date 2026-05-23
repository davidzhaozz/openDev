import { useEffect, useRef, useState } from 'react';
import { useStore } from './state/store';
import { FileTree } from './components/FileTree';
import { CodeEditor } from './components/Editor';
import { TerminalView } from './components/Terminal';
import { FuzzyFinder } from './components/FuzzyFinder';
import { FindInFiles } from './components/FindInFiles';
import { NewProjectModal } from './components/NewProjectModal';
import { AddPackageModal } from './components/AddPackageModal';
import { Resizer } from './components/Resizer';
import { Welcome } from './components/Welcome';
import { Settings, applyAppearanceSettings } from './components/Settings';
import { InstallNodePrompt } from './components/InstallNodePrompt';
import { ServicesPanel } from './panels/ServicesPanel';
import { AIChat } from './panels/AIChat';
import { ConversationsList } from './panels/ConversationsList';
import { BrowserPanel } from './panels/BrowserPanel';
import { DiffWorkspace } from './panels/DiffWorkspace';
import { AiTaskWorkspace } from './panels/AiTaskWorkspace';
import { DesignProposalsWorkspace } from './panels/DesignProposalsWorkspace';
import { AgentsPanel } from './panels/AgentsPanel';
import { AgentRunWorkspace } from './panels/AgentRunWorkspace';
import { DbConnectionsPanel } from './panels/DbConnectionsPanel';
import { SqlWorkspace } from './panels/SqlWorkspace';
import { EsWorkspace } from './panels/EsWorkspace';
import { RestWorkspace } from './panels/RestWorkspace';
import { RestRequestsPanel } from './panels/RestRequestsPanel';
import { MlxPanel } from './panels/MlxPanel';
import { LlmPanel } from './panels/LlmPanel';
import { PipPanel } from './panels/PipPanel';
import { PythonPicker } from './components/PythonPicker';
import { RunBar } from './components/RunBar';
import { BottomBar } from './components/BottomBar';

export default function App() {
  const [root, setRoot] = useState<string | undefined>();
  const setWorkspaceRoot = useStore(s => s.setWorkspaceRoot);
  const tabs = useStore(s => s.centerTabs);
  const activeId = useStore(s => s.activeCenterId);
  const openFile = useStore(s => s.openFileTab);
  const openTerm = useStore(s => s.openTerminalTab);
  const closeTab = useStore(s => s.closeCenterTab);
  const setActive = useStore(s => s.setActiveCenterTab);
  const updateContent = useStore(s => s.updateFileContent);
  const markSaved = useStore(s => s.markFileSaved);
  const renameCenterTab = useStore(s => s.renameCenterTab);
  const [tabCtx, setTabCtx] = useState<{ x: number; y: number; id: string } | null>(null);
  const [renamingTabId, setRenamingTabId] = useState<string | undefined>();
  const [renameDraft, setRenameDraft] = useState('');
  const modal = useStore(s => s.modal);
  const setModal = useStore(s => s.setModal);
  const rightTab = useStore(s => s.rightTab);
  const setRightTab = useStore(s => s.setRightTab);
  const openSqlTab = useStore(s => s.openSqlTab);
  const openEsTab = useStore(s => s.openEsTab);
  const toast = useStore(s => s.toast);
  const layout = useStore(s => s.layout);
  const setLayout = useStore(s => s.setLayout);
  const bottomCollapsed = useStore(s => s.bottomCollapsed);
  const bottomTab = useStore(s => s.bottomTab);
  const [showSettings, setShowSettings] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<{ hasBrew: boolean } | null>(null);
  const [mlxDetected, setMlxDetected] = useState(false);
  const tabDragRef = useRef<
    | { kind: 'file'; id: string; path: string; startX: number; startY: number; outside: boolean }
    | { kind: 'ai'; id: string; conversationId?: string; name: string; startX: number; startY: number; outside: boolean }
    | null
  >(null);

  // Track when a drag leaves/enters the IDE window. `dragleave` on the
  // document with `relatedTarget === null` is the Chromium signal that the
  // cursor has crossed the window edge entirely.
  useEffect(() => {
    const onLeave = (e: DragEvent) => {
      if (e.relatedTarget == null && tabDragRef.current) {
        tabDragRef.current.outside = true;
      }
    };
    const onEnter = () => { if (tabDragRef.current) tabDragRef.current.outside = false; };
    document.addEventListener('dragleave', onLeave, true);
    document.addEventListener('dragenter', onEnter, true);
    return () => {
      document.removeEventListener('dragleave', onLeave, true);
      document.removeEventListener('dragenter', onEnter, true);
    };
  }, []);

  // Detect missing Node/npm when a workspace becomes active — services
  // won't be able to start without it, so offer to install via Homebrew.
  useEffect(() => {
    if (!root) return;
    let alive = true;
    (async () => {
      const r = await window.opendev.tools.check();
      if (alive && !r.npm) setInstallPrompt({ hasBrew: r.brew });
    })();
    return () => { alive = false; };
  }, [root]);

  // Probe for an MLX-LM project on workspace change. When found, the ML
  // right-panel tab becomes available and is auto-selected on first detect.
  // When NOT found, also snap rightTab off 'ml' so a stale session-restored
  // value doesn't leave the right column blank.
  useEffect(() => {
    if (!root) {
      setMlxDetected(false);
      if (useStore.getState().rightTab === 'ml') useStore.getState().setRightTab('ai');
      return;
    }
    let alive = true;
    (async () => {
      const info = await window.opendev.mlx.detect();
      if (!alive) return;
      const found = !!info;
      setMlxDetected(found);
      const cur = useStore.getState().rightTab;
      if (found && cur === 'ai') {
        useStore.getState().setRightTab('ml');
      } else if (!found && cur === 'ml') {
        useStore.getState().setRightTab('ai');
      }
    })();
    return () => { alive = false; };
  }, [root]);

  useEffect(() => {
    (async () => {
      const r = await window.opendev.workspace.current();
      setRoot(r); setWorkspaceRoot(r);
    })();
    const off = window.opendev.workspace.onChanged((p) => { setRoot(p); setWorkspaceRoot(p); });
    return off;
  }, [setWorkspaceRoot]);

  // Surface main-process memory pressure as a toast. Only fires when the
  // watchdog flips state (not on every sample) so it stays unobtrusive.
  useEffect(() => {
    const sys = (window.opendev as any).system;
    if (!sys?.onMemoryWarning) return;
    return sys.onMemoryWarning((m: { level: 'ok' | 'warn' | 'critical'; message: string }) => {
      if (m.level === 'ok' || !m.message) return;
      useStore.getState().showToast(m.message, m.level === 'critical' ? 8000 : 4000);
    });
  }, []);

  // Session restore: when a workspace becomes active, load tabs/cursor/etc.
  // from <workspace>/.opendev/session.json. Only restores if there's no tab
  // already open (avoids clobbering during fast-switch).
  const sessionLoadedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!root) return;
    if (sessionLoadedFor.current === root) return;
    sessionLoadedFor.current = root;
    (async () => {
      const s = await window.opendev.session.load();
      if (!s) return;
      // Only restore if the current tab list is empty — never overwrite live state.
      if (useStore.getState().centerTabs.length > 0) return;
      for (const t of s.tabs || []) {
        if (t.kind === 'file' && t.path) {
          try { const content = await window.opendev.fs.read(t.path); useStore.getState().openFileTab(t.path, content); }
          catch {}
        } else if (t.kind === 'terminal') {
          useStore.getState().openTerminalTab({ cwd: t.cwd, name: t.name });
        } else if (t.kind === 'browser' && t.url) {
          useStore.getState().openBrowserTab(t.url, t.name);
        } else if (t.kind === 'sql') {
          useStore.getState().openSqlTab();
        } else if (t.kind === 'es') {
          useStore.getState().openEsTab();
        } else if (t.kind === 'ai') {
          useStore.getState().openAiChatTab({ conversationId: t.conversationId, name: t.name });
        } else if (t.kind === 'pip') {
          useStore.getState().openPipTab();
        }
      }
      // Validate the restored tab against the current set; fall back to
      // 'ai' if the saved value is from a previous layout. (LOG/DEBUG used
      // to live here too — those sessions now restore as 'ai'.)
      const validTabs = ['ai', 'db', 'es', 'rest', 'ml', 'llm'] as const;
      const restoredTab = validTabs.includes(s.rightTab as any) ? s.rightTab : 'ai';
      useStore.getState().setRightTab(restoredTab as 'ai' | 'db' | 'es' | 'rest' | 'ml' | 'llm');
      if (s.sqlConnId) useStore.getState().setSqlConnId(s.sqlConnId);
      if (s.sqlText) useStore.getState().setSqlText(s.sqlText);
      if (s.esText) useStore.getState().setEsText(s.esText);
      if (s.activeIndex != null) {
        const tabs = useStore.getState().centerTabs;
        const target = tabs[s.activeIndex];
        if (target) useStore.getState().setActiveCenterTab(target.id);
      }
    })();
  }, [root]);

  // Session save: debounce writes whenever interesting state changes.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!root) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const state = useStore.getState();
      type SessionTab = { kind: string; name?: string; path?: string; cwd?: string; url?: string; conversationId?: string };
      const tabs = state.centerTabs.flatMap((t): SessionTab[] => {
        if (t.kind === 'file') return [{ kind: 'file', path: t.path }];
        if (t.kind === 'terminal') return [{ kind: 'terminal', name: t.name, cwd: t.cwd }];
        if (t.kind === 'browser') return [{ kind: 'browser', name: t.name, url: t.url }];
        if (t.kind === 'ai') return [{ kind: 'ai', name: t.name, conversationId: t.conversationId }];
        // design-proposals and agent-run are ephemeral — don't persist them.
        if (t.kind === 'design-proposals' || t.kind === 'agent-run') return [];
        return [{ kind: t.kind, name: t.name }];
      });
      const activeIndex = state.activeCenterId ? state.centerTabs.findIndex(t => t.id === state.activeCenterId) : -1;
      const session = {
        tabs,
        activeIndex: activeIndex >= 0 ? activeIndex : undefined,
        rightTab: state.rightTab,
        sqlConnId: state.sqlConnId,
        sqlText: state.sqlText,
        esText: state.esText
      };
      window.opendev.session.save(session).catch(() => {});
    }, 600);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
    // We only need to react to changes the user can make to the workspace shape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, tabs, activeId, rightTab]);

  useEffect(() => {
    const name = root ? (root.split('/').filter(Boolean).pop() || 'OpenDev IDE') : 'OpenDev IDE';
    document.title = name;
  }, [root]);

  // Apply persisted appearance settings at startup
  useEffect(() => {
    window.opendev.settings.get().then(applyAppearanceSettings);
  }, []);

  // Bridge debugger events from the main process into the global store. One
  // subscription for the whole app — the DebugPanel may not be mounted, but
  // the store needs to stay current (e.g. so the editor's paused-line
  // decoration shows up immediately).
  useEffect(() => {
    const s = useStore.getState();
    const off = window.opendev.debug.onEvent((e) => {
      const cur = useStore.getState();
      switch (e.kind) {
        case 'session-started':
          cur.setDebugSession({ sessionId: e.sessionId, lang: e.lang, status: 'running' });
          // Push every existing breakpoint into the new session.
          for (const [path, lines] of Object.entries(cur.breakpoints)) {
            window.opendev.debug.request('setBreakpoints', { path, lines }).catch(() => {});
          }
          // Auto-open the bottom DEBUG panel so the user sees it immediately.
          cur.setBottomTab('debug');
          if (cur.bottomCollapsed) cur.toggleBottom();
          break;
        case 'paused':
          cur.setDebugPaused({ reason: e.reason, frames: e.frames });
          if (cur.debugSession) cur.setDebugSession({ ...cur.debugSession, status: 'paused' });
          break;
        case 'resumed':
          cur.setDebugPaused(undefined);
          if (cur.debugSession) cur.setDebugSession({ ...cur.debugSession, status: 'running' });
          break;
        case 'output':
          cur.appendDebugConsole(e.text);
          break;
        case 'terminated':
          cur.setDebugPaused(undefined);
          cur.setDebugSession(undefined);
          break;
      }
    });
    void s;
    return off;
  }, []);

  // Pick the right center workspace based on which right-panel tab is open.
  useEffect(() => {
    if (rightTab === 'db') openSqlTab();
    else if (rightTab === 'es') openEsTab();
  }, [rightTab, openSqlTab, openEsTab]);

  // Listen for native menu events
  useEffect(() => {
    const off = window.opendev.menu.onEvent(async (action) => {
      if (action === 'open-project') {
        const r = await window.opendev.workspace.pick();
        if (r) { setRoot(r); setWorkspaceRoot(r); }
      } else if (action === 'close-project') {
        await window.opendev.workspace.close();
        setRoot(undefined); setWorkspaceRoot(undefined);
      } else if (action === 'settings') {
        setShowSettings(true);
      } else if (action === 'new-project') {
        // Folder picker first, then the form modal pre-filled with the dest.
        const dest = await window.opendev.projects.pickDir();
        if (dest) setModal('new-project', { dest });
      }
    });
    return off;
  }, [setWorkspaceRoot]);

  useEffect(() => {
    const dismiss = () => setTabCtx(null);
    window.addEventListener('click', dismiss);
    return () => window.removeEventListener('click', dismiss);
  }, []);

  // Push an editor-state snapshot to the main process so the MCP server can
  // answer "what is the user looking at right now" without a renderer
  // roundtrip. Snapshot whenever tabs/active change.
  useEffect(() => {
    const active = tabs.find(t => t.id === activeId);
    const snap = {
      workspaceRoot: root,
      activeTab: active ? { id: active.id, kind: active.kind, name: active.name, path: active.kind === 'file' ? active.path : undefined } : null,
      openTabs: tabs.map(t => ({
        id: t.id, kind: t.kind, name: t.name,
        path: t.kind === 'file' ? t.path : undefined,
        modified: t.kind === 'file' ? t.modified : undefined
      })),
      activeFileContent: active && active.kind === 'file' ? (active.dirtyContent ?? active.content) : undefined,
      rightTab,
      bottomTab,
      bottomCollapsed
    };
    try { window.opendev.mcp.pushEditorSnapshot(snap); } catch {}
  }, [tabs, activeId, root, rightTab, bottomTab, bottomCollapsed]);

  // Listen for MCP-initiated commands (e.g. an AI asking the IDE to open a file).
  useEffect(() => {
    const handler = (cmd: { kind: string; path?: string; line?: number; col?: number; tab?: 'ai' | 'db' | 'es' | 'rest' | 'ml' | 'llm' | 'log' | 'debug'; savedId?: string; send?: boolean }) => {
      if (cmd?.kind === 'open-file' && cmd.path) {
        openFileFromPath(cmd.path).then(() => {
          if (cmd.line != null) setPendingJump({ path: cmd.path!, line: cmd.line, col: cmd.col ?? 0 });
        });
      } else if (cmd?.kind === 'set-right-tab' && cmd.tab) {
        const t = cmd.tab as 'ai' | 'db' | 'es' | 'rest' | 'ml' | 'llm';
        if (['ai', 'db', 'es', 'rest', 'ml', 'llm'].includes(t)) setRightTab(t);
      } else if (cmd?.kind === 'set-bottom-tab' && cmd.tab) {
        const t = cmd.tab as 'log' | 'debug';
        if (['log', 'debug'].includes(t)) {
          useStore.getState().setBottomTab(t);
          if (useStore.getState().bottomCollapsed) useStore.getState().toggleBottom();
        }
      } else if (cmd?.kind === 'open-rest-saved' && cmd.savedId) {
        window.opendev.rest.listSaved().then(list => {
          const r = list.find(x => x.id === cmd.savedId);
          if (!r) return;
          useStore.getState().openRestTab({
            spec: { method: r.method, url: r.url, headers: r.headers, params: r.params, body: r.body, auth: r.auth },
            name: r.name || r.url || 'REST',
            savedId: r.id
          });
          if (cmd.send) useStore.getState().triggerRestRun();
        }).catch(() => {});
      }
    };
    const off = (window.opendev as any).mcp?.onCommand?.(handler);
    return () => { try { off && off(); } catch {} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && e.key.toLowerCase() === 'p' && e.shiftKey) { e.preventDefault(); setModal('fuzzy'); }
      else if (cmd && e.key.toLowerCase() === 'p') { e.preventDefault(); setModal('fuzzy'); }
      else if (cmd && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setModal('find'); }
      else if (cmd && e.key === '`') { e.preventDefault(); openTerm(); }
      else if (cmd && e.key === 'o' && e.shiftKey) { e.preventDefault(); setModal('fuzzy'); }
      else if (e.key === 'Escape' && modal) { setModal(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal, openTerm, setModal]);

  const pickWorkspace = async () => {
    const r = await window.opendev.workspace.pick();
    if (r) { setRoot(r); setWorkspaceRoot(r); }
  };
  const openPath = async (p: string) => {
    const r = await window.opendev.workspace.open(p);
    if (r) { setRoot(r); setWorkspaceRoot(r); }
  };

  const openFileFromPath = async (path: string) => {
    try { const content = await window.opendev.fs.read(path); openFile(path, content); }
    catch (e: any) { console.error(e); }
  };

  const setPendingJump = useStore(s => s.setPendingJump);
  const references = useStore(s => s.references);
  const setReferences = useStore(s => s.setReferences);
  const jumpTo = async (path: string, line: number, col: number) => {
    const already = tabs.find(t => t.kind === 'file' && t.path === path);
    if (!already) {
      try {
        const content = await window.opendev.fs.read(path);
        openFile(path, content);
      } catch (e: any) {
        console.error('jumpTo failed to read', path, e);
        return;
      }
    } else {
      setActive(already.id);
    }
    setPendingJump({ path, line, col });
  };

  const active = tabs.find(t => t.id === activeId);

  if (!root) {
    return (
      <div className="app" style={{ gridTemplateRows: '36px 1fr' }}>
        <div className="titlebar">
          <span className="title">OpenDev IDE</span>
          <span className="path">v{window.opendev.app.version()} · (no workspace open)</span>
          <div className="actions">
            <button onClick={() => setShowSettings(true)}>Settings</button>
          </div>
        </div>
        <Welcome onOpen={openPath} onPick={pickWorkspace} />
        {showSettings && <Settings onClose={() => setShowSettings(false)} />}
        {installPrompt && (
          <InstallNodePrompt hasBrew={installPrompt.hasBrew} onDismiss={() => setInstallPrompt(null)} />
        )}
        {/* Modals are reachable from the Welcome screen too — without these
            here, clicking "New Project" before opening a workspace would flip
            the state but never render anything (the main render branch below
            is gated on `root`). */}
        {modal === 'new-project' && (() => {
          const dest = (useStore.getState().modalPayload as { dest?: string } | undefined)?.dest;
          return <NewProjectModal initialDest={dest} onClose={() => setModal(null)} />;
        })()}
        {toast && <div className="toast">{toast}</div>}
      </div>
    );
  }

  const projectName = root.split('/').filter(Boolean).pop() || 'project';
  const projectParent = root.split('/').slice(0, -1).join('/').replace(/^\/Users\/[^/]+/, '~');

  return (
    <div className="app">
      <div className="titlebar">
        <span className="title">{projectName}</span>
        <span className="path">{projectParent} · v{window.opendev.app.version()}</span>
      </div>

      <div className="workspace">
        <div className="workspace-row">
        {/* LEFT: Project tree on top, Services on bottom */}
        <div className="col-left" style={{ width: layout.leftW, flex: `0 0 ${layout.leftW}px`, display: 'flex', flexDirection: 'column' }}>
          <div className="panel left-files" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div className="panel-header">
              <span>Project</span>
              <span className="grow" />
              <PythonPicker />
              <button className="icon" title="Refresh file tree" onClick={() => window.dispatchEvent(new Event('opendev:filetree-refresh'))}>↻</button>
            </div>
            <div className="panel-body" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <FileTree root={root} onOpen={openFileFromPath} />
            </div>
          </div>

          <Resizer orientation="horizontal" value={layout.servicesH} min={120} max={900}
            onChange={(v) => setLayout({ servicesH: v })} invert />

          <div className="left-services" style={{ height: layout.servicesH, flex: `0 0 ${layout.servicesH}px`, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <ServicesPanel />
          </div>
        </div>

        <Resizer orientation="vertical" value={layout.leftW} min={180} max={600}
          onChange={(v) => setLayout({ leftW: v })} />

        <div className="col-center">
          <div className="center-editor">
            <div className="tabs">
              {tabs.map(t => {
                const icon = t.kind === 'terminal' ? '⌨ ' : t.kind === 'browser' ? '🌐 ' : t.kind === 'sql' ? '⚡ ' : t.kind === 'es' ? '🔍 ' : t.kind === 'rest' ? '⇆ ' : t.kind === 'diff' ? '⇄ ' : t.kind === 'ai-task' ? '✦ ' : t.kind === 'ai' ? '🤖 ' : t.kind === 'design-proposals' ? '◫ ' : '';
                const isRenaming = renamingTabId === t.id;
                return (
                  <div
                    key={t.id}
                    className={`tab ${activeId === t.id ? 'active' : ''}`}
                    draggable={!isRenaming && (t.kind === 'file' || t.kind === 'ai')}
                    onClick={() => !isRenaming && setActive(t.id)}
                    onDragStart={(e) => {
                      if (t.kind === 'file') {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/uri-list', `file://${t.path}`);
                        tabDragRef.current = { kind: 'file', id: t.id, path: t.path, startX: e.screenX, startY: e.screenY, outside: false };
                      } else if (t.kind === 'ai') {
                        e.dataTransfer.effectAllowed = 'move';
                        // Some non-empty payload is needed for Electron to
                        // actually fire dragend/dragleave events reliably.
                        e.dataTransfer.setData('text/plain', t.name);
                        tabDragRef.current = { kind: 'ai', id: t.id, conversationId: t.conversationId, name: t.name, startX: e.screenX, startY: e.screenY, outside: false };
                      }
                    }}
                    onDragEnd={(e) => {
                      const state = tabDragRef.current;
                      tabDragRef.current = null;
                      if (!state) return;
                      const traveled = Math.hypot(
                        (e.screenX || state.startX) - state.startX,
                        (e.screenY || state.startY) - state.startY
                      );
                      // Tear off when the cursor actually left the window and
                      // we moved more than a tiny twitch. The dragleave flag
                      // is more reliable than coord math on Electron/macOS.
                      const shouldTear = state.outside && traveled > 40;
                      if (!shouldTear) return;
                      const id = state.id;
                      // Defer so Electron finishes tearing down the drag image
                      // before we spawn a window and unmount the editor.
                      setTimeout(() => {
                        try {
                          if (state.kind === 'file') {
                            window.opendev.window.popoutFile(state.path);
                          } else {
                            window.opendev.window.popoutAi({
                              conversationId: state.conversationId,
                              name: state.name
                            });
                          }
                          closeTab(id);
                        } catch (err) {
                          console.error('popout failed', err);
                        }
                      }, 0);
                    }}
                    onDoubleClick={(e) => {
                      if (t.kind === 'file') return;
                      e.stopPropagation();
                      setRenamingTabId(t.id); setRenameDraft(t.name);
                    }}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setTabCtx({ x: e.clientX, y: e.clientY, id: t.id }); }}
                  >
                    {isRenaming ? (
                      <input
                        autoFocus
                        className="tab-rename"
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { renameCenterTab(t.id, renameDraft.trim() || t.name); setRenamingTabId(undefined); }
                          else if (e.key === 'Escape') { setRenamingTabId(undefined); }
                        }}
                        onBlur={() => { renameCenterTab(t.id, renameDraft.trim() || t.name); setRenamingTabId(undefined); }}
                      />
                    ) : (
                      <span>{icon}{t.name}</span>
                    )}
                    {t.kind === 'file' && t.modified ? <span className="modified">●</span> : null}
                    {t.kind === 'file' && (
                      <span
                        className="tab-detach"
                        title="Open in new window"
                        draggable={false}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          const path = t.path;
                          const id = t.id;
                          window.opendev.window.popoutFile(path);
                          closeTab(id);
                        }}
                      >⎘</span>
                    )}
                    {t.kind === 'ai' && (
                      <span
                        className="tab-detach"
                        title="Open in new window"
                        draggable={false}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          const convId = t.conversationId;
                          const name = t.name;
                          const id = t.id;
                          window.opendev.window.popoutAi({ conversationId: convId, name });
                          closeTab(id);
                        }}
                      >⎘</span>
                    )}
                    <span
                      className="close"
                      draggable={false}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                    >×</span>
                  </div>
                );
              })}
              {tabs.length === 0 && <div style={{ padding: '8px 12px', color: 'var(--fg-3)', fontSize: 11 }}>Cmd+P to find a file • Cmd+` for terminal</div>}
            </div>
            <DebugToolbar active={active} />
            <RunBar activeFilePath={active?.kind === 'file' ? active.path : undefined} />
            <div style={{ flex: 1, minHeight: 0, minWidth: 0, background: 'var(--bg-0)' }}>
              {!active && (
                <div className="empty-state">
                  <h2>{root.split('/').filter(Boolean).pop()}</h2>
                  <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{root}</p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => setModal('fuzzy')}>Find File (⌘P)</button>
                    <button onClick={() => openTerm()}>New Terminal (⌘`)</button>
                  </div>
                </div>
              )}
              {tabs.map(t => (
                <div key={t.id} style={{ height: '100%', display: activeId === t.id ? 'block' : 'none' }}>
                  {t.kind === 'file' && (
                    <CodeEditor
                      path={t.path}
                      value={t.dirtyContent ?? t.content}
                      onChange={(s) => updateContent(t.id, s)}
                      onSave={async () => {
                        await window.opendev.fs.write(t.path, t.dirtyContent ?? t.content);
                        markSaved(t.id);
                      }}
                      onJumpTo={jumpTo}
                    />
                  )}
                  {t.kind === 'terminal' && <TerminalView cwd={t.cwd} />}
                  {t.kind === 'browser' && <BrowserPanel initialUrl={t.url} />}
                  {t.kind === 'sql' && <SqlWorkspace />}
                  {t.kind === 'es' && <EsWorkspace />}
                  {t.kind === 'rest' && <RestWorkspace tabId={t.id} />}
                  {t.kind === 'pip' && <PipPanel />}
                  {t.kind === 'diff' && <DiffWorkspace filePath={t.filePath} hash={t.hash} diff={t.diff} />}
                  {t.kind === 'ai-task' && <AiTaskWorkspace />}
                  {t.kind === 'ai' && (
                    <AIChat tabId={t.id} initialConversationId={t.conversationId} active={activeId === t.id} initialPrompt={t.initialPrompt} />
                  )}
                  {t.kind === 'design-proposals' && (
                    <DesignProposalsWorkspace tabId={t.id} proposals={t.proposals} targetPath={t.targetPath} />
                  )}
                  {t.kind === 'agent-run' && (
                    <AgentRunWorkspace runId={t.runId} agentSlug={t.agentSlug} name={t.name} target={t.target} />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* RIGHT: AI / DB / ES tabbed panel */}
        <Resizer orientation="vertical" value={layout.rightW} min={220} max={600}
          onChange={(v) => setLayout({ rightW: v })} invert />

        <div className="col-right" style={{ width: layout.rightW, flex: `0 0 ${layout.rightW}px`, display: 'flex', flexDirection: 'column' }}>
          <div className="right-tabs">
            {([
              ['ai', 'AI'],
              ['db', 'DB'],
              ['es', 'ES'],
              ['rest', 'REST'],
              ['llm', 'LLM'],
              ...(mlxDetected ? [['ml', 'ML'] as const] : [])
            ] as const).map(([k, label]) => (
              <div key={k}
                className={`right-tab ${rightTab === k ? 'active' : ''}`}
                onClick={() => setRightTab(k as 'ai' | 'db' | 'es' | 'rest' | 'ml' | 'llm')}>{label}</div>
            ))}
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {/* Lazy-mount right-panel children — only the active tab is in
                the DOM. Inactive panels unmount, dropping their IPC
                subscriptions and React state. Trade-off: switching away
                from LLM/ML loses the in-panel log buffer (server-side
                state persists; the next mount just starts a fresh tail).
                Worth it on a memory-constrained MLX workstation. */}
            {rightTab === 'ai' && (
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <ConversationsList />
              </div>
            )}
            {rightTab === 'db' && (
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <DbConnectionsPanel drivers={['mysql', 'postgres']} title="SQL Connections" />
              </div>
            )}
            {rightTab === 'es' && (
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <DbConnectionsPanel drivers={['elasticsearch']} title="ES / OpenSearch" />
              </div>
            )}
            {rightTab === 'rest' && (
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <RestRequestsPanel />
              </div>
            )}
            {rightTab === 'llm' && (
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <LlmPanel />
              </div>
            )}
            {mlxDetected && rightTab === 'ml' && (
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <MlxPanel />
              </div>
            )}
          </div>
          {/* Bottom-of-right-column: AI Agents panel, vertically split off.
              Suppressed entirely for ML projects — agents aren't relevant to
              MLX-LM training regardless of which right-tab is in focus, and
              the panel just steals vertical space from the loss chart and
              adapter list. */}
          {!mlxDetected && (
            <>
              <Resizer orientation="horizontal" value={layout.agentsH} min={120} max={600}
                onChange={(v) => setLayout({ agentsH: v })} invert />
              <div style={{ height: layout.agentsH, flex: `0 0 ${layout.agentsH}px`, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <AgentsPanel />
              </div>
            </>
          )}
        </div>

        </div>{/* /.workspace-row */}

        {!bottomCollapsed && (
          <Resizer
            orientation="horizontal"
            value={layout.bottomH}
            min={120}
            max={800}
            invert
            onChange={(v) => setLayout({ bottomH: v })}
          />
        )}
        <div
          className="bottom-bar-wrap"
          style={bottomCollapsed
            ? { flex: '0 0 auto', minHeight: 0 }
            : { height: layout.bottomH, flex: `0 0 ${layout.bottomH}px`, minHeight: 0, display: 'flex', flexDirection: 'column' }}
        >
          <BottomBar />
        </div>
      </div>

      {modal === 'fuzzy' && <FuzzyFinder />}
      {modal === 'find' && <FindInFiles />}
      {modal === 'new-project' && (() => {
        const dest = (useStore.getState().modalPayload as { dest?: string } | undefined)?.dest;
        return <NewProjectModal initialDest={dest} onClose={() => setModal(null)} />;
      })()}
      {modal === 'add-package' && (() => {
        const dir = (useStore.getState().modalPayload as { dir?: string } | undefined)?.dir;
        if (!dir) return null;
        return <AddPackageModal dir={dir} onClose={() => setModal(null)} />;
      })()}
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
      {installPrompt && (
        <InstallNodePrompt hasBrew={installPrompt.hasBrew} onDismiss={() => setInstallPrompt(null)} />
      )}

      {references && references.anchor && (
        <ReferencesPopover
          data={references}
          onJump={(r) => { jumpTo(r.path, r.line, r.col); setReferences(undefined); }}
          onClose={() => setReferences(undefined)}
        />
      )}
      {references && !references.anchor && (
        <div className="modal-overlay" onMouseDown={() => setReferences(undefined)}>
          <div className="modal" style={{ width: 720 }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-input" style={{ fontWeight: 600 }}>
              References{references.symbol ? ` to ${references.symbol}` : ''} ({references.items.length})
            </div>
            <div className="modal-list">
              {references.items.map((r, i) => {
                const file = r.path.split('/').pop();
                return (
                  <div key={i} className="modal-row" onClick={() => {
                    jumpTo(r.path, r.line, r.col);
                    setReferences(undefined);
                  }}>
                    <span>{file}</span>
                    <span className="relpath">{r.path} · L{r.line + 1}:{r.col + 1}</span>
                  </div>
                );
              })}
              {references.items.length === 0 && <div className="modal-row" style={{ color: 'var(--fg-3)' }}>No references found.</div>}
            </div>
          </div>
        </div>
      )}

      {tabCtx && (() => {
        const t = tabs.find(x => x.id === tabCtx.id);
        if (!t) return null;
        const canRename = t.kind !== 'file';
        const canPopout = t.kind === 'file';
        return (
          <div className="ctx-menu" style={{ left: tabCtx.x, top: tabCtx.y }} onClick={(e) => e.stopPropagation()}>
            <div
              className="item"
              style={{ opacity: canRename ? 1 : 0.4 }}
              onClick={() => {
                if (!canRename) return;
                setRenamingTabId(t.id); setRenameDraft(t.name); setTabCtx(null);
              }}
            >Rename…{canRename ? '' : ' (file tabs follow the file)'}</div>
            {canPopout && (
              <div className="item" onClick={() => {
                if (t.kind === 'file') window.opendev.window.popoutFile(t.path);
                setTabCtx(null);
              }}>Open in New Window</div>
            )}
            <div className="sep" />
            <div className="item" onClick={() => { closeTab(t.id); setTabCtx(null); }}>Close</div>
            <div className="item" onClick={() => {
              for (const o of tabs) if (o.id !== t.id) closeTab(o.id);
              setTabCtx(null);
            }}>Close Others</div>
            <div className="item" onClick={() => { for (const o of tabs) closeTab(o.id); setTabCtx(null); }}>Close All</div>
          </div>
        );
      })()}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// Slim toolbar above the editor: a "Debug" button when the active tab is a
// debuggable JS file, and the step controls whenever a session is live.
function DebugToolbar({ active }: { active: ReturnType<typeof useStore.getState>['centerTabs'][number] | undefined }) {
  const session = useStore((s) => s.debugSession);
  const paused = useStore((s) => s.debugPaused);
  const showToast = useStore((s) => s.showToast);
  const setBottomTab = useStore((s) => s.setBottomTab);
  const bottomCollapsed = useStore((s) => s.bottomCollapsed);
  const toggleBottom = useStore((s) => s.toggleBottom);
  const openDebug = () => {
    setBottomTab('debug');
    if (bottomCollapsed) toggleBottom();
  };
  const isJsFile = active?.kind === 'file' && /\.(m?js|cjs)$/i.test(active.path);
  const isPyFile = active?.kind === 'file' && /\.pyi?$/i.test(active.path);
  if (!session && !isJsFile && !isPyFile) return null;
  const startNode = async () => {
    if (!isJsFile || active?.kind !== 'file') return;
    try {
      await window.opendev.debug.start({ lang: 'node', file: active.path });
    } catch (err) {
      showToast(`Debug start failed: ${(err as Error).message}`, 5000);
    }
  };
  const startPython = async () => {
    if (!isPyFile || active?.kind !== 'file') return;
    try {
      await window.opendev.debug.start({ lang: 'python', file: active.path });
    } catch (err) {
      showToast(`Debug start failed: ${(err as Error).message}`, 5000);
    }
  };
  const cmd = (command: string) => () => {
    window.opendev.debug.request(command, {}).catch((e) => showToast(`${command} failed: ${e?.message || e}`, 4000));
  };
  return (
    <div className="debug-toolbar">
      {!session && isJsFile && (
        <button className="dbg-debug" onClick={startNode}>▶ Debug</button>
      )}
      {!session && isPyFile && (
        <button className="dbg-debug" onClick={startPython} title="Debug this .py file via debugpy (install: pip install debugpy)">▶ Debug</button>
      )}
      {session && (
        <>
          <span className={`dbg-status ${session.status}`}>{session.status}</span>
          {paused
            ? <button className="dbg-btn" title="Continue (resume)" onClick={cmd('continue')}>▶</button>
            : <button className="dbg-btn" title="Pause" onClick={cmd('pause')}>⏸</button>}
          <button className="dbg-btn" title="Step Over" onClick={cmd('stepOver')} disabled={!paused}>⤼</button>
          <button className="dbg-btn" title="Step Into" onClick={cmd('stepInto')} disabled={!paused}>⤷</button>
          <button className="dbg-btn" title="Step Out" onClick={cmd('stepOut')} disabled={!paused}>⤴</button>
          <button className="dbg-btn stop" title="Stop" onClick={() => window.opendev.debug.stop()}>⏹</button>
          <span style={{ flex: 1 }} />
          <button className="dbg-btn link" onClick={openDebug}>open DEBUG panel →</button>
        </>
      )}
    </div>
  );
}

// Small popover anchored next to a modifier-click. The viewport-edge
// adjustment keeps it on-screen when the click is near the right or
// bottom; scroll inside the list itself rather than letting the popover
// grow off-screen.
function ReferencesPopover({
  data, onJump, onClose
}: {
  data: { symbol?: string; items: Array<{ path: string; line: number; col: number }>; anchor?: { x: number; y: number } };
  onJump: (r: { path: string; line: number; col: number }) => void;
  onClose: () => void;
}) {
  const anchor = data.anchor!;
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.x + 12, top: anchor.y + 12 });

  // Dismiss on outside click or Escape.
  useEffect(() => {
    const onDown = (ev: MouseEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) onClose();
    };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose(); };
    // mousedown — defer one tick so the click that opened this popover
    // doesn't immediately close it.
    const t = setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  // After first paint we know the popover's real size — nudge it inward
  // if it overflows the viewport's right or bottom edge.
  useEffect(() => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const pad = 8;
    let left = anchor.x + 12;
    let top = anchor.y + 12;
    if (left + r.width > window.innerWidth - pad)  left = Math.max(pad, window.innerWidth - r.width - pad);
    if (top  + r.height > window.innerHeight - pad) top  = Math.max(pad, anchor.y - r.height - 12);
    setPos({ left, top });
  }, [anchor.x, anchor.y]);

  return (
    <div className="lsp-popover" ref={ref} style={{ left: pos.left, top: pos.top }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="lsp-popover-header">
        <span className="lsp-popover-title">References{data.symbol ? <> to <code>{data.symbol}</code></> : null}</span>
        <span className="lsp-popover-count">{data.items.length}</span>
      </div>
      <div className="lsp-popover-list">
        {data.items.map((r, i) => {
          const file = r.path.split('/').pop();
          return (
            <div key={i} className="lsp-popover-row" onClick={() => onJump(r)}>
              <span className="lsp-popover-file">{file}</span>
              <span className="lsp-popover-loc">L{r.line + 1}:{r.col + 1}</span>
            </div>
          );
        })}
        {data.items.length === 0 && (
          <div className="lsp-popover-row empty">No references found.</div>
        )}
      </div>
    </div>
  );
}
