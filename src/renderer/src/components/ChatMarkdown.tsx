import { memo, useMemo, useState, type ReactNode } from 'react';
import type { Parser } from '@lezer/common';
import { highlightCode, tagHighlighter, tags as t } from '@lezer/highlight';
import { StreamLanguage, type StreamParser } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { sql } from '@codemirror/lang-sql';
import { java } from '@codemirror/lang-java';
import { markdown } from '@codemirror/lang-markdown';
import { c, cpp, csharp, kotlin } from '@codemirror/legacy-modes/mode/clike';
import { python } from '@codemirror/legacy-modes/mode/python';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { diff } from '@codemirror/legacy-modes/mode/diff';
import { go } from '@codemirror/legacy-modes/mode/go';
import { rust } from '@codemirror/legacy-modes/mode/rust';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';

// Markdown renderer for AI chat messages. Covers what model output actually
// uses — headings, paragraphs, nested lists, task lists, block quotes,
// tables, rules, fenced code with syntax highlighting, links — plus the
// tool-trace lines ai.ts emits (`› using tool: X` / `  ↳ result`). Still no
// markdown library: this is ~a few hundred lines and never needs HTML
// sanitising because it only ever produces React elements.

// ---------------------------------------------------------------------
// Code highlighting — reuses the lezer parsers the editor already bundles.
// ---------------------------------------------------------------------

const highlighter = tagHighlighter([
  { tag: t.keyword, class: 'hl-keyword' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.attributeValue, t.url], class: 'hl-string' },
  { tag: [t.number, t.integer, t.float], class: 'hl-number' },
  { tag: [t.bool, t.null, t.atom, t.constant(t.variableName), t.standard(t.variableName), t.self], class: 'hl-constant' },
  { tag: t.comment, class: 'hl-comment' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.macroName], class: 'hl-function' },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], class: 'hl-type' },
  { tag: [t.tagName, t.angleBracket], class: 'hl-tag' },
  { tag: [t.attributeName, t.propertyName, t.labelName], class: 'hl-property' },
  { tag: t.variableName, class: 'hl-variable' },
  { tag: t.operator, class: 'hl-operator' },
  { tag: t.inserted, class: 'hl-inserted' },
  { tag: t.deleted, class: 'hl-deleted' },
  { tag: [t.heading, t.strong], class: 'hl-heading' },
  { tag: t.meta, class: 'hl-meta' },
  { tag: t.invalid, class: 'hl-invalid' }
]);

const legacy = (p: StreamParser<unknown>) => () => StreamLanguage.define(p).parser;
const PARSER_FACTORIES: Record<string, () => Parser> = {
  js: () => javascript({ jsx: true }).language.parser,
  ts: () => javascript({ jsx: true, typescript: true }).language.parser,
  json: () => json().language.parser,
  css: () => css().language.parser,
  html: () => html().language.parser,
  sql: () => sql().language.parser,
  java: () => java().language.parser,
  md: () => markdown().language.parser,
  c: legacy(c), cpp: legacy(cpp), cs: legacy(csharp), kotlin: legacy(kotlin),
  py: legacy(python), yaml: legacy(yaml), sh: legacy(shell), ps: legacy(powerShell),
  diff: legacy(diff), go: legacy(go), rust: legacy(rust), toml: legacy(toml), docker: legacy(dockerFile)
};
const LANG_ALIASES: Record<string, string> = {
  javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
  typescript: 'ts', tsx: 'ts', mts: 'ts',
  jsonc: 'json', json5: 'json',
  scss: 'css', less: 'css',
  xml: 'html', svg: 'html', vue: 'html', htm: 'html',
  mysql: 'sql', postgres: 'sql', postgresql: 'sql', psql: 'sql', sqlite: 'sql', tsql: 'sql',
  markdown: 'md',
  h: 'c', hpp: 'cpp', 'c++': 'cpp', csharp: 'cs', 'c#': 'cs', kt: 'kotlin',
  python: 'py', python3: 'py', yml: 'yaml',
  bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', shellscript: 'sh',
  powershell: 'ps', ps1: 'ps', pwsh: 'ps',
  patch: 'diff', golang: 'go', rs: 'rust', dockerfile: 'docker'
};

const parserCache = new Map<string, Parser | null>();
function parserFor(lang: string): Parser | null {
  const key = LANG_ALIASES[lang] || lang;
  if (parserCache.has(key)) return parserCache.get(key)!;
  const make = PARSER_FACTORIES[key];
  let p: Parser | null = null;
  try { p = make ? make() : null; } catch { p = null; }
  parserCache.set(key, p);
  return p;
}

// Past this size highlighting a streaming block on every chunk gets
// noticeable; plain text is fine for something that long.
const MAX_HIGHLIGHT = 60_000;

function highlight(body: string, lang: string): ReactNode {
  const parser = body.length <= MAX_HIGHLIGHT ? parserFor(lang.toLowerCase()) : null;
  if (!parser) return body;
  try {
    const out: ReactNode[] = [];
    highlightCode(body, parser.parse(body), highlighter,
      (text, cls) => { out.push(cls ? <span key={out.length} className={cls}>{text}</span> : text); },
      () => { out.push('\n'); });
    return out;
  } catch {
    return body;
  }
}

// ---------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------

type Align = 'left' | 'center' | 'right' | undefined;
type ToolCall = { name: string; note: string; results: string[] };
type ListItem = { text: string; checked?: boolean; body: string };
type Block =
  | { kind: 'code'; lang: string; body: string; open: boolean }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'hr' }
  | { kind: 'quote'; body: string }
  | { kind: 'table'; head: string[]; align: Align[]; rows: string[][] }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'tools'; calls: ToolCall[] }
  | { kind: 'para'; text: string };

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TOOL_CALL = /^\s*›\s+using tool:\s*(.*)$/i;
const TOOL_RESULT = /^\s*↳\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const indentOf = (s: string) => s.match(/^\s*/)![0].replace(/\t/g, '    ').length;
const isBlank = (s: string) => s.trim() === '';

// Split a table row on unescaped pipes that aren't inside `code`.
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function startsBlock(line: string, next: string | undefined): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line)
    || LIST_ITEM.test(line) || TOOL_CALL.test(line) || TOOL_RESULT.test(line)
    || (line.includes('|') && next !== undefined && TABLE_SEP.test(next) && next.includes('-'));
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    // Fenced code. An unclosed fence (mid-stream) runs to the end.
    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[2];
      const pad = fence[1].length;
      const body: string[] = [];
      i++;
      let open = true;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim().startsWith(marker[0].repeat(marker.length)) && /^\s*[`~]+\s*$/.test(l)) { open = false; i++; break; }
        body.push(pad ? l.replace(new RegExp(`^ {0,${pad}}`), '') : l);
        i++;
      }
      blocks.push({ kind: 'code', lang: fence[3] || '', body: body.join('\n'), open });
      continue;
    }

    const h = line.match(HEADING);
    if (h) { blocks.push({ kind: 'heading', level: h[1].length, text: h[2] }); i++; continue; }

    if (HR.test(line)) { blocks.push({ kind: 'hr' }); i++; continue; }

    // Tool traces: consecutive call/result lines collapse into one card.
    if (TOOL_CALL.test(line) || TOOL_RESULT.test(line)) {
      const calls: ToolCall[] = [];
      while (i < lines.length && (TOOL_CALL.test(lines[i]) || TOOL_RESULT.test(lines[i]) || (isBlank(lines[i]) && i + 1 < lines.length && (TOOL_CALL.test(lines[i + 1]) || TOOL_RESULT.test(lines[i + 1]))))) {
        const l = lines[i];
        const call = l.match(TOOL_CALL);
        if (call) {
          // "Write········ (4.2 KB)" → name "Write", note "4.2 KB"
          const m = call[1].match(/^(\S+?)[·\s]*(?:\((.*)\))?\s*$/);
          calls.push({ name: m ? m[1] : call[1], note: m?.[2] || '', results: [] });
        } else {
          const r = l.match(TOOL_RESULT);
          if (r) {
            if (!calls.length) calls.push({ name: 'tool', note: '', results: [] });
            calls[calls.length - 1].results.push(r[1]);
          }
        }
        i++;
      }
      blocks.push({ kind: 'tools', calls });
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !isBlank(lines[i])) {
        const q = lines[i].match(QUOTE);
        // Lazy continuation: a plain line right after a quote line belongs to it.
        if (!q && startsBlock(lines[i], lines[i + 1])) break;
        body.push(q ? q[1] : lines[i]);
        i++;
      }
      blocks.push({ kind: 'quote', body: body.join('\n') });
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const align: Align[] = splitRow(lines[i + 1]).map(c => {
        const l = c.startsWith(':'), r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : undefined;
      });
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ kind: 'table', head, align, rows });
      continue;
    }

    const li = line.match(LIST_ITEM);
    if (li) {
      const baseIndent = indentOf(li[1]);
      const ordered = /\d/.test(li[2]);
      const start = ordered ? parseInt(li[2], 10) : 1;
      const items: ListItem[] = [];
      let cur: { text: string; checked?: boolean; body: string[] } | null = null;
      const pushCur = () => { if (cur) items.push({ text: cur.text, checked: cur.checked, body: cur.body.join('\n').replace(/\n+$/, '') }); };
      while (i < lines.length) {
        const l = lines[i];
        const m = l.match(LIST_ITEM);
        if (m && indentOf(m[1]) <= baseIndent + 1 && /\d/.test(m[2]) === ordered) {
          pushCur();
          let text = m[3];
          let checked: boolean | undefined;
          const task = text.match(/^\[([ xX])\]\s+(.*)$/);
          if (task) { checked = task[1] !== ' '; text = task[2]; }
          cur = { text, checked, body: [] };
          i++;
          continue;
        }
        if (isBlank(l)) {
          // A blank line continues the list only if more list content follows.
          let j = i + 1;
          while (j < lines.length && isBlank(lines[j])) j++;
          if (j >= lines.length) { i = j; break; }
          const n = lines[j];
          const nm = n.match(LIST_ITEM);
          if ((nm && indentOf(nm[1]) <= baseIndent + 1 && /\d/.test(nm[2]) === ordered) || indentOf(n) > baseIndent + 1) {
            cur?.body.push('');
            i++;
            continue;
          }
          break;
        }
        // Indented lines (nested lists, code, extra paragraphs) belong to the item.
        if (indentOf(l) > baseIndent + 1) {
          const cut = Math.min(indentOf(l), baseIndent + (ordered ? 3 : 2));
          cur?.body.push(l.replace(/\t/g, '    ').slice(cut));
          i++;
          continue;
        }
        // Lazy paragraph continuation directly under an item.
        if (cur && !startsBlock(l, lines[i + 1]) && cur.body.length === 0) {
          cur.text += '\n' + l.trim();
          i++;
          continue;
        }
        break;
      }
      pushCur();
      blocks.push({ kind: 'list', ordered, start, items });
      continue;
    }

    // Paragraph: runs until a blank line or the start of another block.
    const para: string[] = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i], lines[i + 1])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ kind: 'para', text: para.join('\n') });
  }
  return blocks;
}

// ---------------------------------------------------------------------
// Inline formatting
// ---------------------------------------------------------------------

const SAFE_URL = /^(https?:|mailto:)/i;
const BARE_URL = /^https?:\/\/[^\s<>"'`]+/i;

function Link({ href, children }: { href: string; children: ReactNode }) {
  if (!SAFE_URL.test(href)) return <>{children}</>;
  // target=_blank → the main process' window-open handler sends it to the
  // system browser instead of navigating the IDE window.
  return <a className="md-link" href={href} target="_blank" rel="noreferrer" title={href} onClick={e => e.stopPropagation()}>{children}</a>;
}

function renderInline(s: string, keyBase = ''): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  let i = 0;
  const key = () => `${keyBase}${out.length}`;
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch);

  while (i < s.length) {
    const ch = s[i];

    if (ch === '\\' && i + 1 < s.length && /[\\`*_{}\[\]()#+\-.!|~>]/.test(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      const fence = '`'.repeat(n);
      const end = s.indexOf(fence, i + n);
      if (end > -1) {
        flush();
        let code = s.slice(i + n, end);
        if (/^ .* $/.test(code)) code = code.slice(1, -1);
        out.push(<code key={key()} className="md-inline-code">{code}</code>);
        i = end + n;
        continue;
      }
      buf += fence;
      i += n;
      continue;
    }

    // [text](url)
    if (ch === '[') {
      const close = s.indexOf('](', i + 1);
      if (close > -1) {
        const end = s.indexOf(')', close + 2);
        if (end > -1 && !s.slice(i + 1, close).includes('\n')) {
          const label = s.slice(i + 1, close);
          const href = s.slice(close + 2, end).trim().split(/\s+/)[0];
          flush();
          out.push(<Link key={key()} href={href}>{renderInline(label, key() + '-')}</Link>);
          i = end + 1;
          continue;
        }
      }
    }

    if ((ch === 'h' || ch === 'H') && !isWord(s[i - 1])) {
      const m = s.slice(i).match(BARE_URL);
      if (m) {
        const url = m[0].replace(/[.,;:!?)\]]+$/, '');
        flush();
        out.push(<Link key={key()} href={url}>{url}</Link>);
        i += url.length;
        continue;
      }
    }

    // **bold** / __bold__
    if ((ch === '*' || ch === '_') && s[i + 1] === ch && s[i + 2] && s[i + 2] !== ' ') {
      const marker = ch + ch;
      const end = s.indexOf(marker, i + 2);
      if (end > i + 2 && (ch === '*' || !isWord(s[end + 2]))) {
        flush();
        out.push(<strong key={key()}>{renderInline(s.slice(i + 2, end), key() + '-')}</strong>);
        i = end + 2;
        continue;
      }
    }

    // ~~strike~~
    if (ch === '~' && s[i + 1] === '~') {
      const end = s.indexOf('~~', i + 2);
      if (end > i + 2) {
        flush();
        out.push(<del key={key()}>{renderInline(s.slice(i + 2, end), key() + '-')}</del>);
        i = end + 2;
        continue;
      }
    }

    // *em* / _em_ — `_` only at word boundaries so snake_case survives.
    if ((ch === '*' || (ch === '_' && !isWord(s[i - 1]))) && s[i + 1] && s[i + 1] !== ' ' && s[i + 1] !== ch) {
      let end = i + 1;
      while ((end = s.indexOf(ch, end)) > -1) {
        if (s[end - 1] !== ' ' && s[end + 1] !== ch && (ch === '*' || !isWord(s[end + 1]))) break;
        end++;
      }
      if (end > i + 1) {
        flush();
        out.push(<em key={key()}>{renderInline(s.slice(i + 1, end), key() + '-')}</em>);
        i = end + 1;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------

function CodeBlock({ lang, body, open }: { lang: string; body: string; open: boolean }) {
  const [copied, setCopied] = useState(false);
  const highlighted = useMemo(() => highlight(body, lang), [body, lang]);
  const copy = () => {
    try {
      void navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };
  const lines = body.split('\n').length;
  return (
    <div className={`md-code${lang.toLowerCase() === 'diff' || lang.toLowerCase() === 'patch' ? ' md-code-diff' : ''}`}>
      <div className="md-code-head">
        <span className="md-code-lang">{lang || 'text'}</span>
        <span className="md-code-lines">{lines} line{lines === 1 ? '' : 's'}{open ? ' · writing…' : ''}</span>
        {body.length > 0 && (
          <button className="md-code-copy" onClick={(e) => { e.stopPropagation(); copy(); }}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
      <pre><code>{highlighted}</code></pre>
    </div>
  );
}

// Collapsed to a one-line summary by default; click to see each call.
function ToolTrace({ calls }: { calls: ToolCall[] }) {
  const [open, setOpen] = useState(false);
  const errors = calls.filter((c) => c.results.some((r) => r.startsWith('[error]'))).length;
  const names = [...new Set(calls.map((c) => c.name))];
  const shown = names.slice(0, 4).join(', ') + (names.length > 4 ? `, +${names.length - 4}` : '');
  return (
    <div className={`md-tools${open ? ' open' : ''}`}>
      <button className="md-tools-summary" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="md-tools-caret" aria-hidden>{open ? '▾' : '▸'}</span>
        <span className="md-tool-icon" aria-hidden>⚙</span>
        <span>{calls.length} tool call{calls.length === 1 ? '' : 's'}</span>
        <span className="md-tool-note">{shown}</span>
        {errors > 0 && <span className="md-tools-errors">{errors} failed</span>}
      </button>
      {open && calls.map((c, i) => (
        <div key={i} className="md-tool">
          <div className="md-tool-head">
            <span className="md-tool-icon" aria-hidden>⚙</span>
            <span className="md-tool-name">{c.name}</span>
            {c.note && <span className="md-tool-note">{c.note}</span>}
          </div>
          {c.results.map((r, j) => {
            const err = r.startsWith('[error]');
            return (
              <div key={j} className={`md-tool-result${err ? ' error' : ''}`}>
                <span aria-hidden>↳ </span>{err ? r.slice(7).trimStart() : r}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'code':
      return <CodeBlock lang={block.lang} body={block.body} open={block.open} />;
    case 'heading': {
      const Tag = `h${Math.min(block.level, 6)}` as 'h1';
      return <Tag className={`md-h md-h${block.level}`}>{renderInline(block.text)}</Tag>;
    }
    case 'hr':
      return <hr className="md-hr" />;
    case 'quote':
      return <blockquote className="md-quote"><Markdown text={block.body} /></blockquote>;
    case 'table':
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>{block.head.map((h, i) => <th key={i} style={{ textAlign: block.align[i] }}>{renderInline(h)}</th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((r, ri) => (
                <tr key={ri}>
                  {block.head.map((_, ci) => <td key={ci} style={{ textAlign: block.align[ci] }}>{renderInline(r[ci] ?? '')}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'list': {
      const items = block.items.map((it, i) => (
        <li key={i} className={it.checked !== undefined ? 'md-task' : undefined}>
          {it.checked !== undefined && <span className={`md-check${it.checked ? ' on' : ''}`} aria-hidden>{it.checked ? '✓' : ''}</span>}
          <span className="md-li-text">{renderInline(it.text)}</span>
          {it.body && <Markdown text={it.body} />}
        </li>
      ));
      return block.ordered
        ? <ol className="md-list" start={block.start}>{items}</ol>
        : <ul className="md-list">{items}</ul>;
    }
    case 'tools':
      return <ToolTrace calls={block.calls} />;
    case 'para':
      return <p className="md-p">{renderInline(block.text)}</p>;
  }
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return <>{blocks.map((b, i) => <BlockView key={i} block={b} />)}</>;
});
