import { useStore } from '../state/store';
import { LogPanel } from '../panels/LogPanel';
import { DebugPanel } from '../panels/DebugPanel';
import { RunPanel } from '../panels/RunPanel';

// Application bottom bar — hosts LOG and DEBUG panels that used to live in
// the right column. Collapsing leaves only the tab strip visible so the
// user can keep the workspace at full height when the panels are idle.

export function BottomBar() {
  const tab = useStore(s => s.bottomTab);
  const setTab = useStore(s => s.setBottomTab);
  const collapsed = useStore(s => s.bottomCollapsed);
  const toggle = useStore(s => s.toggleBottom);

  return (
    <div className={`bottom-bar ${collapsed ? 'collapsed' : ''}`}>
      <div className="bottom-tabs">
        {(['log', 'debug', 'run'] as const).map(k => (
          <div
            key={k}
            className={`bottom-tab ${tab === k ? 'active' : ''}`}
            onClick={() => {
              if (tab === k) toggle();
              else { setTab(k); if (collapsed) toggle(); }
            }}
            title={tab === k ? (collapsed ? 'Expand' : 'Collapse') : `Show ${k.toUpperCase()}`}
          >
            {k === 'log' ? 'LOG' : k === 'debug' ? 'DEBUG' : 'RUN'}
          </div>
        ))}
        <span className="grow" />
        <button
          className="bottom-collapse"
          onClick={toggle}
          title={collapsed ? 'Expand panel' : 'Collapse panel'}
        >{collapsed ? '▲' : '▼'}</button>
      </div>
      {!collapsed && (
        <div className="bottom-body">
          <div style={{ height: '100%', display: tab === 'log' ? 'flex' : 'none', flexDirection: 'column' }}>
            <LogPanel />
          </div>
          <div style={{ height: '100%', display: tab === 'debug' ? 'flex' : 'none', flexDirection: 'column' }}>
            <DebugPanel />
          </div>
          <div style={{ height: '100%', display: tab === 'run' ? 'flex' : 'none', flexDirection: 'column' }}>
            <RunPanel />
          </div>
        </div>
      )}
    </div>
  );
}
