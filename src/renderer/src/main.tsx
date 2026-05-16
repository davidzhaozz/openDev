import { createRoot } from 'react-dom/client';
import App from './App';
import { Popout } from './Popout';
import { PopoutAi } from './PopoutAi';
import './styles/global.css';

const root = createRoot(document.getElementById('root')!);
const params = new URLSearchParams(location.search);
const popoutFlag = params.get('popout');
const popoutPath = popoutFlag === '1' ? params.get('path') : null;
const popoutAi = popoutFlag === 'ai';

function ApiMissing() {
  return (
    <div style={{
      padding: 40, color: '#d4d4d4', background: '#1e1e1e', height: '100vh',
      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif'
    }}>
      <h2 style={{ color: '#f48771' }}>Preload bridge not loaded</h2>
      <p>The renderer started but <code>window.opendev</code> is undefined. This means the preload script failed to load. Check the main process log for <code>[preload error]</code>.</p>
      <p style={{ color: '#969696', fontFamily: 'monospace', fontSize: 12 }}>UA: {navigator.userAgent}</p>
    </div>
  );
}

window.addEventListener('error', (e) => {
  console.error('[renderer error]', e.error || e.message);
});

if (typeof (window as unknown as { opendev?: unknown }).opendev === 'undefined') {
  root.render(<ApiMissing />);
} else if (popoutPath) {
  root.render(<Popout path={popoutPath} />);
} else if (popoutAi) {
  root.render(
    <PopoutAi
      conversationId={params.get('convId') || undefined}
      initialName={params.get('name') || undefined}
      initialPrompt={params.get('prompt') || undefined}
    />
  );
} else {
  root.render(<App />);
}
