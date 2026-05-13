// Theme presets. Each defines a small set of CSS variables that drive the
// IDE chrome (backgrounds, foregrounds, accents, borders) plus a syntax-
// highlighting palette for the editor.

export type Theme = {
  id: string;
  name: string;
  base: 'dark' | 'light';
  bg0: string;  // outer window / editor backdrop
  bg1: string;  // panel surfaces (sidebars, headers)
  bg2: string;  // section dividers, hover backgrounds
  bg3: string;  // emphasized surfaces (chips, buttons)
  bgHover: string;
  bgActive: string;
  bgSolid0: string;
  bgSolid1: string;
  bgSolid2: string;
  bgSolid3: string;
  fg0: string;  // primary text (also editor default)
  fg1: string;
  fg2: string;
  fg3: string;
  accent: string;
  accentHi: string;
  border: string;
  borderSolid: string;
  // Editor / SQL syntax tokens
  syntax: {
    keyword: string;
    string: string;
    number: string;
    comment: string;
    function: string;
    type: string;
    variable: string;
    operator: string;
    constant: string;
    tag: string;
  };
};

// VS Code Dark+ — the IDE's original look, kept as the default.
const vsDark: Theme = {
  id: 'vscode-dark',
  name: 'VS Code Dark+',
  base: 'dark',
  bg0: '#1e1e1e', bg1: '#252526', bg2: '#2d2d30', bg3: '#3c3c3c',
  bgHover: '#2a2d2e', bgActive: '#094771',
  bgSolid0: '#1e1e1e', bgSolid1: '#252526', bgSolid2: '#2d2d30', bgSolid3: '#3c3c3c',
  fg0: '#d4d4d4', fg1: '#cccccc', fg2: '#969696', fg3: '#6e6e6e',
  accent: '#0e639c', accentHi: '#1177bb',
  border: '#3c3c3c', borderSolid: '#3c3c3c',
  syntax: {
    keyword: '#569cd6', string: '#ce9178', number: '#b5cea8', comment: '#6a9955',
    function: '#dcdcaa', type: '#4ec9b0', variable: '#9cdcfe', operator: '#d4d4d4',
    constant: '#4fc1ff', tag: '#569cd6'
  }
};

// One Dark — Atom's classic, cool blue-grey base.
const oneDark: Theme = {
  id: 'one-dark',
  name: 'One Dark',
  base: 'dark',
  bg0: '#282c34', bg1: '#21252b', bg2: '#2c313a', bg3: '#3e4451',
  bgHover: '#2c313a', bgActive: '#3a4a6c',
  bgSolid0: '#282c34', bgSolid1: '#21252b', bgSolid2: '#2c313a', bgSolid3: '#3e4451',
  fg0: '#abb2bf', fg1: '#bbc2cf', fg2: '#9098a8', fg3: '#5c6370',
  accent: '#528bff', accentHi: '#61afef',
  border: '#3e4451', borderSolid: '#3e4451',
  syntax: {
    keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#7f848e',
    function: '#61afef', type: '#e5c07b', variable: '#e06c75', operator: '#56b6c2',
    constant: '#d19a66', tag: '#e06c75'
  }
};

// Dracula — vibrant purple/pink/cyan.
const dracula: Theme = {
  id: 'dracula',
  name: 'Dracula',
  base: 'dark',
  bg0: '#282a36', bg1: '#21222c', bg2: '#343746', bg3: '#44475a',
  bgHover: '#343746', bgActive: '#44475a',
  bgSolid0: '#282a36', bgSolid1: '#21222c', bgSolid2: '#343746', bgSolid3: '#44475a',
  fg0: '#f8f8f2', fg1: '#e0e0d6', fg2: '#a8a8a0', fg3: '#6272a4',
  accent: '#bd93f9', accentHi: '#ff79c6',
  border: '#44475a', borderSolid: '#44475a',
  syntax: {
    keyword: '#ff79c6', string: '#f1fa8c', number: '#bd93f9', comment: '#6272a4',
    function: '#50fa7b', type: '#8be9fd', variable: '#f8f8f2', operator: '#ff79c6',
    constant: '#bd93f9', tag: '#ff79c6'
  }
};

// Monokai — classic warm dark.
const monokai: Theme = {
  id: 'monokai',
  name: 'Monokai',
  base: 'dark',
  bg0: '#272822', bg1: '#1e1f1c', bg2: '#3e3d32', bg3: '#49483e',
  bgHover: '#3e3d32', bgActive: '#49483e',
  bgSolid0: '#272822', bgSolid1: '#1e1f1c', bgSolid2: '#3e3d32', bgSolid3: '#49483e',
  fg0: '#f8f8f2', fg1: '#e8e8de', fg2: '#a59f85', fg3: '#75715e',
  accent: '#a6e22e', accentHi: '#fd971f',
  border: '#49483e', borderSolid: '#49483e',
  syntax: {
    keyword: '#f92672', string: '#e6db74', number: '#ae81ff', comment: '#75715e',
    function: '#a6e22e', type: '#66d9ef', variable: '#f8f8f2', operator: '#f92672',
    constant: '#ae81ff', tag: '#f92672'
  }
};

// Solarized Dark — muted teal base, gentle warm accents.
const solarizedDark: Theme = {
  id: 'solarized-dark',
  name: 'Solarized Dark',
  base: 'dark',
  bg0: '#002b36', bg1: '#073642', bg2: '#0e4451', bg3: '#1c5667',
  bgHover: '#0e4451', bgActive: '#1c5667',
  bgSolid0: '#002b36', bgSolid1: '#073642', bgSolid2: '#0e4451', bgSolid3: '#1c5667',
  fg0: '#93a1a1', fg1: '#839496', fg2: '#657b83', fg3: '#586e75',
  accent: '#268bd2', accentHi: '#2aa198',
  border: '#1c5667', borderSolid: '#1c5667',
  syntax: {
    keyword: '#859900', string: '#2aa198', number: '#d33682', comment: '#586e75',
    function: '#268bd2', type: '#b58900', variable: '#cb4b16', operator: '#93a1a1',
    constant: '#6c71c4', tag: '#dc322f'
  }
};

// Nord — cool blue-grey, muted.
const nord: Theme = {
  id: 'nord',
  name: 'Nord',
  base: 'dark',
  bg0: '#2e3440', bg1: '#3b4252', bg2: '#434c5e', bg3: '#4c566a',
  bgHover: '#3b4252', bgActive: '#434c5e',
  bgSolid0: '#2e3440', bgSolid1: '#3b4252', bgSolid2: '#434c5e', bgSolid3: '#4c566a',
  fg0: '#eceff4', fg1: '#d8dee9', fg2: '#a3b0c6', fg3: '#7b8aa3',
  accent: '#5e81ac', accentHi: '#88c0d0',
  border: '#4c566a', borderSolid: '#4c566a',
  syntax: {
    keyword: '#81a1c1', string: '#a3be8c', number: '#b48ead', comment: '#616e88',
    function: '#88c0d0', type: '#8fbcbb', variable: '#d8dee9', operator: '#81a1c1',
    constant: '#b48ead', tag: '#bf616a'
  }
};

// GitHub Dark — GitHub.com dark mode.
const githubDark: Theme = {
  id: 'github-dark',
  name: 'GitHub Dark',
  base: 'dark',
  bg0: '#0d1117', bg1: '#161b22', bg2: '#21262d', bg3: '#30363d',
  bgHover: '#21262d', bgActive: '#1f6feb',
  bgSolid0: '#0d1117', bgSolid1: '#161b22', bgSolid2: '#21262d', bgSolid3: '#30363d',
  fg0: '#c9d1d9', fg1: '#b1bac4', fg2: '#8b949e', fg3: '#6e7681',
  accent: '#1f6feb', accentHi: '#58a6ff',
  border: '#30363d', borderSolid: '#30363d',
  syntax: {
    keyword: '#ff7b72', string: '#a5d6ff', number: '#79c0ff', comment: '#8b949e',
    function: '#d2a8ff', type: '#ffa657', variable: '#c9d1d9', operator: '#ff7b72',
    constant: '#79c0ff', tag: '#7ee787'
  }
};

// Slate — lighter dark grey, more legible at high transparency.
const slate: Theme = {
  id: 'slate',
  name: 'Slate (lighter dark)',
  base: 'dark',
  bg0: '#383c44', bg1: '#414550', bg2: '#4a4f5b', bg3: '#5a6070',
  bgHover: '#4a4f5b', bgActive: '#5a6070',
  bgSolid0: '#383c44', bgSolid1: '#414550', bgSolid2: '#4a4f5b', bgSolid3: '#5a6070',
  fg0: '#e8eaed', fg1: '#dadee3', fg2: '#a8b0bb', fg3: '#7a8290',
  accent: '#6aa1ff', accentHi: '#8ab9ff',
  border: '#5a6070', borderSolid: '#5a6070',
  syntax: {
    keyword: '#86c2ff', string: '#bcd99c', number: '#d9b890', comment: '#7e8a98',
    function: '#e0c97c', type: '#7fd1b9', variable: '#cbd2dc', operator: '#cbd2dc',
    constant: '#c0a3ff', tag: '#86c2ff'
  }
};

export const THEMES: Theme[] = [vsDark, oneDark, dracula, monokai, solarizedDark, nord, githubDark, slate];

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  // Translucent (alpha-driven) panel backgrounds
  const rgba = (hex: string, ref: string) => {
    const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (!m) return hex;
    const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
    return `rgba(${r}, ${g}, ${b}, var(--bg-alpha))`;
  };
  root.style.setProperty('--bg-0', rgba(theme.bg0, 'bg-0'));
  root.style.setProperty('--bg-1', rgba(theme.bg1, 'bg-1'));
  root.style.setProperty('--bg-2', rgba(theme.bg2, 'bg-2'));
  root.style.setProperty('--bg-3', rgba(theme.bg3, 'bg-3'));
  root.style.setProperty('--bg-hover', rgba(theme.bgHover, 'bg-hover'));
  root.style.setProperty('--bg-active', rgba(theme.bgActive, 'bg-active'));
  // Solid versions for modals / context menus
  root.style.setProperty('--bg-solid-0', theme.bgSolid0);
  root.style.setProperty('--bg-solid-1', theme.bgSolid1);
  root.style.setProperty('--bg-solid-2', theme.bgSolid2);
  root.style.setProperty('--bg-solid-3', theme.bgSolid3);
  // Foreground stays solid (no alpha) — see-through windows should still
  // have crisp text.
  root.style.setProperty('--fg-0', theme.fg0);
  root.style.setProperty('--fg-1', theme.fg1);
  root.style.setProperty('--fg-2', theme.fg2);
  root.style.setProperty('--fg-3', theme.fg3);
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--accent-hi', theme.accentHi);
  root.style.setProperty('--border', theme.border);
  root.style.setProperty('--border-solid', theme.borderSolid);
  // Editor syntax tokens
  root.style.setProperty('--syntax-keyword', theme.syntax.keyword);
  root.style.setProperty('--syntax-string', theme.syntax.string);
  root.style.setProperty('--syntax-number', theme.syntax.number);
  root.style.setProperty('--syntax-comment', theme.syntax.comment);
  root.style.setProperty('--syntax-function', theme.syntax.function);
  root.style.setProperty('--syntax-type', theme.syntax.type);
  root.style.setProperty('--syntax-variable', theme.syntax.variable);
  root.style.setProperty('--syntax-operator', theme.syntax.operator);
  root.style.setProperty('--syntax-constant', theme.syntax.constant);
  root.style.setProperty('--syntax-tag', theme.syntax.tag);
}

export function themeById(id: string | undefined): Theme {
  return THEMES.find(t => t.id === id) || THEMES[0];
}
