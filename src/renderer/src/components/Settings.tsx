import { useEffect, useState } from 'react';
import type { AppSettings } from '../../../shared/types';
import { THEMES, applyTheme, themeById, type Theme } from '../themes';

type Props = { onClose: () => void };

const DEFAULT_TEXT_COLOR = '#d4d4d4';
const TEXT_COLOR_PRESETS: Array<{ name: string; hex: string }> = [
  { name: 'Default', hex: '#d4d4d4' },
  { name: 'White',   hex: '#ffffff' },
  { name: 'Amber',   hex: '#e0b974' },
  { name: 'Mint',    hex: '#9be9c7' },
  { name: 'Sky',     hex: '#86bbff' },
  { name: 'Lilac',   hex: '#c8a8ff' },
  { name: 'Rose',    hex: '#f5a3a3' }
];

const DEFAULT_UI_FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
const DEFAULT_EDITOR_FONT = `'SF Mono', Menlo, Monaco, 'JetBrains Mono', Consolas, 'Courier New', monospace`;
// Each preset's `value` is what gets written to the CSS var. Common system
// fallbacks are appended so the OS picks the next-best match if the user's
// chosen font isn't installed.
const UI_FONT_PRESETS: Array<{ name: string; value: string }> = [
  { name: 'System default', value: DEFAULT_UI_FONT },
  { name: 'SF Pro',        value: `-apple-system, 'SF Pro Text', system-ui, sans-serif` },
  { name: 'Helvetica',     value: `'Helvetica Neue', Helvetica, Arial, sans-serif` },
  { name: 'Inter',         value: `Inter, -apple-system, sans-serif` },
  { name: 'Roboto',        value: `Roboto, -apple-system, sans-serif` },
  { name: 'Georgia',       value: `Georgia, 'Times New Roman', serif` }
];
const EDITOR_FONT_PRESETS: Array<{ name: string; value: string }> = [
  { name: 'SF Mono (default)', value: DEFAULT_EDITOR_FONT },
  { name: 'Menlo',             value: `Menlo, 'SF Mono', monospace` },
  { name: 'Monaco',            value: `Monaco, Menlo, monospace` },
  { name: 'JetBrains Mono',    value: `'JetBrains Mono', 'SF Mono', monospace` },
  { name: 'Fira Code',         value: `'Fira Code', 'SF Mono', monospace` },
  { name: 'Source Code Pro',   value: `'Source Code Pro', 'SF Mono', monospace` },
  { name: 'Cascadia Code',     value: `'Cascadia Code', 'SF Mono', monospace` },
  { name: 'IBM Plex Mono',     value: `'IBM Plex Mono', 'SF Mono', monospace` },
  { name: 'Courier New',       value: `'Courier New', Courier, monospace` }
];

export function Settings({ onClose }: Props) {
  const [displayFont, setDisplayFont] = useState(12);
  const [editorFont, setEditorFont] = useState(13);
  const [transparency, setTransparency] = useState(0); // 0..90 (percent)
  const [textColor, setTextColor] = useState<string>(DEFAULT_TEXT_COLOR);
  const [uiFontFamily, setUiFontFamily] = useState<string>(DEFAULT_UI_FONT);
  const [editorFontFamily, setEditorFontFamily] = useState<string>(DEFAULT_EDITOR_FONT);
  const [anthropicKey, setAnthropicKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [claudeCli, setClaudeCli] = useState('');
  const [codexCli, setCodexCli] = useState('');
  const [anthropicModel, setAnthropicModel] = useState('claude-sonnet-4-6');
  const [openaiModel, setOpenaiModel] = useState('gpt-4o-mini');
  const [themeId, setThemeId] = useState('vscode-dark');

  useEffect(() => {
    window.opendev.settings.get().then((s: AppSettings) => {
      if (s.displayFontSize) setDisplayFont(s.displayFontSize);
      if (s.editorFontSize) setEditorFont(s.editorFontSize);
      if (s.windowOpacity != null) setTransparency(Math.round((1 - s.windowOpacity) * 100));
      if (s.fontColor) setTextColor(s.fontColor);
      if (s.displayFontFamily) setUiFontFamily(s.displayFontFamily);
      if (s.editorFontFamily) setEditorFontFamily(s.editorFontFamily);
      if (s.anthropicApiKey) setAnthropicKey(s.anthropicApiKey);
      if (s.openaiApiKey) setOpenaiKey(s.openaiApiKey);
      if (s.claudeCliPath) setClaudeCli(s.claudeCliPath);
      if (s.codexCliPath) setCodexCli(s.codexCliPath);
      if (s.anthropicModel) setAnthropicModel(s.anthropicModel);
      if (s.openaiModel) setOpenaiModel(s.openaiModel);
      if (s.themeId) setThemeId(s.themeId);
    });
  }, []);

  const onTheme = (t: Theme) => {
    setThemeId(t.id);
    applyTheme(t);
    // The chosen text color override still wins if set.
    if (textColor && textColor !== '#d4d4d4') {
      document.documentElement.style.setProperty('--fg-0', textColor);
    }
    persist({ themeId: t.id });
  };

  const persist = (patch: Partial<AppSettings>) => {
    window.opendev.settings.set(patch);
  };

  const onDisplay = (n: number) => {
    setDisplayFont(n);
    document.documentElement.style.setProperty('--ui-font-size', `${n}px`);
    persist({ displayFontSize: n });
  };
  const onEditor = (n: number) => {
    setEditorFont(n);
    document.documentElement.style.setProperty('--editor-font-size', `${n}px`);
    persist({ editorFontSize: n });
  };
  const onTrans = (pct: number) => {
    setTransparency(pct);
    const alpha = (100 - pct) / 100;
    document.documentElement.style.setProperty('--bg-alpha', String(alpha));
    persist({ windowOpacity: alpha });
  };

  const onTextColor = (hex: string) => {
    const v = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : (/^#[0-9a-fA-F]{3}$/.test(hex) ? hex : null);
    setTextColor(hex);
    if (v) {
      document.documentElement.style.setProperty('--fg-0', hex);
      persist({ fontColor: hex });
    }
  };

  const onUiFont = (value: string) => {
    setUiFontFamily(value);
    document.documentElement.style.setProperty('--font-ui', value);
    persist({ displayFontFamily: value });
  };
  const onEditorFont = (value: string) => {
    setEditorFontFamily(value);
    document.documentElement.style.setProperty('--font-mono', value);
    persist({ editorFontFamily: value });
  };

  const FontControl = ({ label, sub, value, presets, onChange, listId }: {
    label: string; sub: string; value: string;
    presets: Array<{ name: string; value: string }>;
    onChange: (v: string) => void;
    listId: string;
  }) => {
    const matching = presets.find(p => p.value === value);
    return (
      <div className="settings-row">
        <div className="settings-row-text">
          <div className="settings-label">{label}</div>
          <div className="settings-sub">{sub}</div>
        </div>
        <div className="settings-row-control">
          <div className="settings-control">
            <input
              list={listId}
              className="settings-font-input"
              value={matching ? matching.name : value}
              onChange={(e) => {
                const typed = e.target.value;
                const found = presets.find(p => p.name === typed);
                onChange(found ? found.value : typed);
              }}
              spellCheck={false}
              style={{ fontFamily: value }}
            />
            <datalist id={listId}>
              {presets.map(p => <option key={p.name} value={p.name} />)}
            </datalist>
            <span className="settings-font-preview" style={{ fontFamily: value }}>
              {label.startsWith('Editor') ? 'const sum = (a, b) => a + b;' : 'The quick brown fox'}
            </span>
          </div>
          <div className="settings-presets">
            {presets.map(p => (
              <button
                key={p.name}
                className={p.value === value ? 'preset active' : 'preset'}
                onClick={() => onChange(p.value)}
                title={p.value}
              >{p.name}</button>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const Control = ({
    label, sub, value, min, max, onChange, unit, presets
  }: {
    label: string; sub: string; value: number; min: number; max: number;
    onChange: (n: number) => void; unit: string; presets: number[];
  }) => (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-label">{label}</div>
        <div className="settings-sub">{sub}</div>
      </div>
      <div className="settings-row-control">
        <div className="settings-control">
          <input type="range" min={min} max={max} step={1} value={value}
            onChange={(e) => onChange(Number(e.target.value))} />
          <input className="settings-number" type="number" min={min} max={max} value={value}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (!isNaN(n)) onChange(Math.max(min, Math.min(max, n)));
            }} />
          <span className="settings-unit">{unit}</span>
        </div>
        <div className="settings-presets">
          {presets.map(p => (
            <button key={p} className={value === p ? 'preset active' : 'preset'}
              onClick={() => onChange(p)}>{p}{unit}</button>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal settings-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span>Settings</span>
          <button onClick={onClose}>Done</button>
        </div>

        <div className="settings-section">
          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-label">Theme</div>
              <div className="settings-sub">Whole IDE color palette including syntax highlighting.</div>
            </div>
            <div className="settings-row-control">
              <div className="theme-cards">
                {THEMES.map(th => (
                  <button
                    key={th.id}
                    className={`theme-card ${themeId === th.id ? 'active' : ''}`}
                    onClick={() => onTheme(th)}
                    title={th.name}
                  >
                    <div className="theme-card-name">{th.name}</div>
                    <div className="theme-card-preview" style={{ background: th.bgSolid0, color: th.fg0, borderColor: th.borderSolid }}>
                      <span style={{ color: th.syntax.keyword }}>const</span>
                      <span style={{ color: th.syntax.function }}> sum</span>
                      <span> = (a, b) =&gt; </span>
                      <span style={{ color: th.syntax.string }}>'…'</span>
                    </div>
                    <div className="theme-card-swatches">
                      {[th.syntax.keyword, th.syntax.string, th.syntax.number, th.syntax.function, th.syntax.type, th.syntax.comment].map((c, i) => (
                        <span key={i} className="theme-swatch" style={{ background: c }} />
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <Control
            label="Display font size"
            sub="Affects file tree, panels, menus, status, and chrome."
            value={displayFont} min={10} max={20}
            onChange={onDisplay} unit="px"
            presets={[11, 12, 13, 14, 16]}
          />

          <FontControl
            label="Display font family"
            sub="UI text. Pick from suggestions or type any installed font."
            value={uiFontFamily}
            presets={UI_FONT_PRESETS}
            onChange={onUiFont}
            listId="ui-font-list"
          />

          <Control
            label="Editor font size"
            sub="Code editor and terminal."
            value={editorFont} min={10} max={24}
            onChange={onEditor} unit="px"
            presets={[11, 13, 14, 16, 18]}
          />

          <FontControl
            label="Editor font family"
            sub="Monospace for code and SQL. Terminals pick this up on reopen."
            value={editorFontFamily}
            presets={EDITOR_FONT_PRESETS}
            onChange={onEditorFont}
            listId="editor-font-list"
          />

          <McpStatusRow />


          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-label">AI CLI paths</div>
              <div className="settings-sub">Path to the Claude Code and Codex command-line binaries. Leave blank to look on $PATH.</div>
            </div>
            <div className="settings-row-control">
              <div className="settings-control">
                <input type="text" value={claudeCli}
                  placeholder="claude  (Claude Code path)"
                  spellCheck={false}
                  onChange={(e) => { setClaudeCli(e.target.value); persist({ claudeCliPath: e.target.value }); }}
                  style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12 }} />
                <input type="text" value={codexCli}
                  placeholder="codex  (Codex path)"
                  spellCheck={false}
                  onChange={(e) => { setCodexCli(e.target.value); persist({ codexCliPath: e.target.value }); }}
                  style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12 }} />
              </div>
            </div>
          </div>

          <Control
            label="Window transparency"
            sub="Background fades through to the desktop. Text stays solid."
            value={transparency} min={0} max={90}
            onChange={onTrans} unit="%"
            presets={[0, 25, 50, 75, 90]}
          />

          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-label">Text color</div>
              <div className="settings-sub">Foreground for the file tree, panels, and editor default.</div>
            </div>
            <div className="settings-row-control">
              <div className="settings-control">
                <input
                  type="color"
                  value={textColor}
                  onChange={(e) => onTextColor(e.target.value)}
                  className="settings-color"
                  aria-label="Text color picker"
                />
                <input
                  type="text"
                  value={textColor}
                  onChange={(e) => onTextColor(e.target.value)}
                  placeholder="#d4d4d4"
                  className="settings-color-hex"
                  spellCheck={false}
                />
                <span className="settings-color-swatch" style={{ background: textColor }} />
              </div>
              <div className="settings-presets">
                {TEXT_COLOR_PRESETS.map(p => (
                  <button
                    key={p.hex}
                    className={textColor.toLowerCase() === p.hex.toLowerCase() ? 'preset active' : 'preset'}
                    onClick={() => onTextColor(p.hex)}
                    title={p.hex}
                  >
                    <span className="preset-dot" style={{ background: p.hex }} />
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function McpStatusRow() {
  const [status, setStatus] = useState<{ running: boolean; url?: string; port?: number; error?: string } | null>(null);
  useEffect(() => { window.opendev.mcp.status().then(setStatus); }, []);
  const url = status?.url || 'http://127.0.0.1:53825/';
  const cfg = JSON.stringify({ mcpServers: { 'opendev-ide': { type: 'http', url } } }, null, 2);
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-label">MCP server for AI</div>
        <div className="settings-sub">
          The IDE hosts a Model Context Protocol server so external Claude Code / Codex sessions can read what you're
          looking at and act on it (open files, run services, query DBs, ripgrep, etc.). Add the snippet below to{' '}
          <code>~/.claude.json</code> (Claude Code) or a project-root <code>.mcp.json</code>.
        </div>
      </div>
      <div className="settings-row-control">
        <div className="settings-control">
          <span style={{ color: status?.running ? 'var(--ok)' : 'var(--danger)', fontSize: 12 }}>
            {status?.running ? '● running' : '○ not running'}
          </span>
          <span className="settings-value" style={{ fontFamily: 'var(--font-mono)' }}>{url}</span>
          <button onClick={() => navigator.clipboard.writeText(url)}>Copy URL</button>
        </div>
        <pre className="mcp-snippet">{cfg}</pre>
        <button onClick={() => navigator.clipboard.writeText(cfg)} style={{ alignSelf: 'flex-start' }}>Copy JSON snippet</button>
        {status?.error && <div className="db-test-error">{status.error}</div>}
      </div>
    </div>
  );
}

export function applyAppearanceSettings(s: AppSettings) {
  const root = document.documentElement;
  // Theme first — its color tokens are overridable by explicit settings below.
  applyTheme(themeById(s.themeId));
  if (s.displayFontSize) root.style.setProperty('--ui-font-size', `${s.displayFontSize}px`);
  if (s.editorFontSize) root.style.setProperty('--editor-font-size', `${s.editorFontSize}px`);
  if (s.windowOpacity != null) root.style.setProperty('--bg-alpha', String(s.windowOpacity));
  if (s.fontColor) root.style.setProperty('--fg-0', s.fontColor);
  if (s.displayFontFamily) root.style.setProperty('--font-ui', s.displayFontFamily);
  if (s.editorFontFamily) root.style.setProperty('--font-mono', s.editorFontFamily);
}
