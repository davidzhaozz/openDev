// Thin wrapper over mermaid: loads it lazily (it is a large bundle and most
// sessions never open a .mmd), keeps its theme in step with the IDE's, and
// turns parse failures into a line number we can point the editor at.

type MermaidApi = typeof import('mermaid')['default'];

let modPromise: Promise<MermaidApi> | null = null;
let configuredFor = '';
let seq = 0;

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** rgb()/rgba()/#hex → perceived luminance, used to pick mermaid's theme. */
function luminance(color: string): number {
  let r = 0, g = 0, b = 0;
  const hex = color.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  const rgb = color.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (hex) { r = parseInt(hex[1], 16); g = parseInt(hex[2], 16); b = parseInt(hex[3], 16); }
  else if (rgb) { r = +rgb[1]; g = +rgb[2]; b = +rgb[3]; }
  else return 0;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function isDarkUi(): boolean {
  return luminance(cssVar('--bg-solid-0', '#1e1e1e')) < 0.5;
}

/** A signature of everything that should force a re-init + re-render. */
export function themeSignature(): string {
  return [
    cssVar('--bg-solid-1', ''),
    cssVar('--fg-0', ''),
    cssVar('--accent', ''),
    cssVar('--border-solid', ''),
    cssVar('--font-ui', '')
  ].join('|');
}

async function load(): Promise<MermaidApi> {
  if (!modPromise) modPromise = import('mermaid').then(m => m.default);
  return modPromise;
}

async function configure(mermaid: MermaidApi) {
  const sig = themeSignature();
  if (sig === configuredFor) return;
  configuredFor = sig;
  const dark = isDarkUi();
  mermaid.initialize({
    startOnLoad: false,
    // The source is a file in the user's own workspace, but it is rendered
    // inside the IDE's renderer — keep mermaid's own sanitizer on.
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'default',
    fontFamily: cssVar('--font-ui', 'system-ui, sans-serif'),
    maxTextSize: 500_000,
    themeVariables: {
      background: cssVar('--bg-solid-0', dark ? '#1e1e1e' : '#ffffff'),
      primaryColor: cssVar('--bg-solid-3', dark ? '#3c3c3c' : '#eeeeee'),
      primaryTextColor: cssVar('--fg-0', dark ? '#d4d4d4' : '#1a1a1a'),
      primaryBorderColor: cssVar('--border-solid', dark ? '#555555' : '#cccccc'),
      lineColor: cssVar('--fg-2', dark ? '#9a9a9a' : '#555555'),
      secondaryColor: cssVar('--bg-solid-2', dark ? '#2d2d2d' : '#f5f5f5'),
      tertiaryColor: cssVar('--bg-solid-1', dark ? '#252526' : '#fafafa')
    },
    flowchart: { useMaxWidth: false, htmlLabels: true },
    sequence: { useMaxWidth: false },
    gantt: { useMaxWidth: false },
    class: { useMaxWidth: false },
    state: { useMaxWidth: false },
    er: { useMaxWidth: false },
    journey: { useMaxWidth: false },
    pie: { useMaxWidth: false }
  });
}

export type MermaidError = { message: string; line?: number };

/** Mermaid reports `Parse error on line N:` inside its message. */
function errorLine(message: string): number | undefined {
  const m = message.match(/line (\d+)/i);
  return m ? Number(m[1]) : undefined;
}

export type RenderResult =
  /** `renderId` namespaces every id inside the SVG; the source map strips it. */
  | { ok: true; svg: string; renderId: string }
  | { ok: false; error: MermaidError };

export async function renderMermaid(code: string): Promise<RenderResult> {
  if (!code.trim()) return { ok: false, error: { message: 'Empty diagram.' } };
  try {
    const mermaid = await load();
    await configure(mermaid);
    seq += 1;
    const renderId = `opendev-mmd-${Date.now()}-${seq}`;
    const { svg } = await mermaid.render(renderId, code);
    return { ok: true, svg, renderId };
  } catch (e: any) {
    // Mermaid leaves its scratch <div> behind when a render throws.
    for (const el of Array.from(document.querySelectorAll('[id^="dopendev-mmd-"]'))) el.remove();
    const message = String(e?.message || e || 'Failed to render diagram.');
    return { ok: false, error: { message, line: errorLine(message) } };
  }
}
