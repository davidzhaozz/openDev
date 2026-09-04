import { useEffect, useState } from 'react';
import { AIChat } from './panels/AIChat';
import { applyAppearanceSettings } from './components/Settings';
import './styles/global.css';
import { WindowControls, usesFramelessChrome } from './components/WindowControls';

type Props = {
  conversationId?: string;
  initialName?: string;
  initialPrompt?: string;
};

export function PopoutAi({ conversationId, initialName, initialPrompt }: Props) {
  const [title, setTitle] = useState(initialName || 'AI Chat');

  useEffect(() => {
    window.opendev.settings.get().then(applyAppearanceSettings);
    document.title = title;
  }, [title]);

  // If we have a conversationId, the AIChat component will load its messages
  // from disk on mount. Pull the saved name so the title bar matches the
  // conversation, not just whatever the spawning tab was called.
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    window.opendev.ai.conversation(conversationId).then(c => {
      if (!cancelled && c?.title) setTitle(c.title);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [conversationId]);

  // Stable per-window tabId. AIChat uses it to scope its store entry; the
  // popout has no center-tab system, but the component still wants a key.
  const [tabId] = useState(() => `popout-ai-${Math.random().toString(36).slice(2, 10)}`);

  return (
    <div className="app" style={{ gridTemplateRows: '32px 1fr', height: '100vh' }}>
      <div className="titlebar">
        <span className="title">🤖 {title}</span>
        {usesFramelessChrome() && <WindowControls />}
      </div>
      <div style={{ background: 'var(--bg-0)', height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <AIChat
          tabId={tabId}
          initialConversationId={conversationId}
          active={true}
          initialPrompt={initialPrompt}
        />
      </div>
    </div>
  );
}
