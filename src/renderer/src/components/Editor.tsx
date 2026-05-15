import { useEffect, useRef, useState } from 'react';
import { useStore as useGlobalStore } from '../state/store';
import { DiffView, type DiffMode } from './DiffView';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, gutter, GutterMarker } from '@codemirror/view';
import { useStore } from '../state/store';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const ideHighlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--syntax-keyword)' },
  { tag: [t.controlKeyword, t.moduleKeyword, t.definitionKeyword], color: 'var(--syntax-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syntax-string)' },
  { tag: t.number, color: 'var(--syntax-number)' },
  { tag: [t.bool, t.null], color: 'var(--syntax-constant)' },
  { tag: t.comment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: t.lineComment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: t.blockComment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.definition(t.variableName))], color: 'var(--syntax-function)' },
  { tag: [t.className, t.typeName, t.namespace], color: 'var(--syntax-type)' },
  { tag: [t.variableName, t.propertyName, t.attributeName], color: 'var(--syntax-variable)' },
  { tag: [t.operator, t.derefOperator, t.compareOperator, t.logicOperator], color: 'var(--syntax-operator)' },
  { tag: [t.constant(t.name), t.standard(t.name)], color: 'var(--syntax-constant)' },
  { tag: t.tagName, color: 'var(--syntax-tag)' },
  { tag: t.attributeValue, color: 'var(--syntax-string)' },
  { tag: t.invalid, color: '#f48771' }
]);
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { lintKeymap } from '@codemirror/lint';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { sql } from '@codemirror/lang-sql';
import { java } from '@codemirror/lang-java';

function langForPath(path: string) {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts': case 'tsx': return javascript({ typescript: true, jsx: ext === 'tsx' });
    case 'js': case 'jsx': case 'mjs': case 'cjs': return javascript({ jsx: true });
    case 'json': return json();
    case 'css': case 'scss': return css();
    case 'html': case 'htm': return html();
    case 'md': case 'mdx': return markdown();
    case 'sql': return sql();
    case 'java': return java();
    default: return javascript();
  }
}

function languageIdFor(path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts': return 'typescript';
    case 'tsx': return 'typescriptreact';
    case 'js': case 'mjs': case 'cjs': return 'javascript';
    case 'jsx': return 'javascriptreact';
    default: return null;
  }
}

// LSP positions are 0-indexed line/character. Mapping to/from CM6 doc offsets.
function offsetToLsp(doc: { lineAt: (p: number) => { from: number; number: number } }, pos: number) {
  const line = doc.lineAt(pos);
  return { line: line.number - 1, character: pos - line.from };
}
function lspToOffset(doc: { line: (n: number) => { from: number } }, line: number, character: number) {
  const info = doc.line(line + 1);
  return info.from + character;
}

// Per-line blame entries indexed by 1-based line number.
type BlameLine = { line: number; hash: string; author?: string; date?: string; summary?: string };
const setBlameEffect = StateEffect.define<BlameLine[] | null>();
const blameField = StateField.define<Map<number, BlameLine>>({
  create: () => new Map(),
  update(v, tr) {
    for (const ef of tr.effects) {
      if (ef.is(setBlameEffect)) {
        const m = new Map<number, BlameLine>();
        if (ef.value) for (const b of ef.value) m.set(b.line, b);
        return m;
      }
    }
    return v;
  }
});

class BlameMarker extends GutterMarker {
  constructor(private text: string, private title: string, private hash?: string) { super(); }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.textContent = this.text;
    el.className = 'cm-blame-marker';
    el.title = this.title;
    if (this.hash) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('opendev:blame-click', { detail: { hash: this.hash } }));
      });
    }
    return el;
  }
}

const blameGutter = gutter({
  class: 'cm-blame-gutter',
  lineMarker(view, lineBlock) {
    const lineNo = view.state.doc.lineAt(lineBlock.from).number;
    const entry = view.state.field(blameField).get(lineNo);
    if (!entry) return null;
    const short = entry.hash.slice(0, 7);
    const who = entry.author?.split(/\s+/)[0] || '';
    return new BlameMarker(`${short} ${who}`, `${entry.hash}\n${entry.author}\n${entry.date}\n${entry.summary || ''}\n(click for full commit)`, entry.hash);
  },
  // CodeMirror only re-evaluates lineMarker on doc/viewport changes by
  // default. Without this hook, dispatching `setBlameEffect` updates the
  // state field but the gutter never re-renders, leaving it visually blank.
  lineMarkerChange: (update) => update.transactions.some(tr => tr.effects.some(e => e.is(setBlameEffect))),
  initialSpacer: () => new BlameMarker('0000000 author', '')
});

type Props = {
  path: string;
  value: string;
  onChange: (s: string) => void;
  onSave: () => void;
  onJumpTo?: (path: string, line: number, col: number) => void;
};

export function CodeEditor({ path, value, onChange, onSave, onJumpTo }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [blameOn, setBlameOn] = useState(false);
  const [gutterCtx, setGutterCtx] = useState<{ x: number; y: number } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyList, setHistoryList] = useState<Array<{ hash: string; date: string; message: string; author_name?: string }> | null>(null);
  const [historyError, setHistoryError] = useState<string | undefined>();
  const [showingCommit, setShowingCommit] = useState<string | null>(null);
  const [commitDiff, setCommitDiff] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>('split');
  const versionRef = useRef(1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onJumpToRef = useRef(onJumpTo);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onJumpToRef.current = onJumpTo;
  const pendingJump = useStore(s => s.pendingJump);
  const setPendingJump = useStore(s => s.setPendingJump);
  const setReferences = useStore(s => s.setReferences);

  const fileUri = `file://${path}`;
  const langId = languageIdFor(path);

  const handleCmdClick = async (e: MouseEvent, view: EditorView, references: boolean) => {
    if (!langId) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) return false;
    const { line, character } = offsetToLsp(view.state.doc, pos);
    if (references) {
      const result = await window.opendev.lsp.request<Array<{ uri: string; range: { start: { line: number; character: number } } }>>('textDocument/references', {
        textDocument: { uri: fileUri },
        position: { line, character },
        context: { includeDeclaration: true }
      });
      if (result && result.length) {
        setReferences({
          items: result.map(r => ({
            path: r.uri.replace(/^file:\/\//, ''),
            line: r.range.start.line,
            col: r.range.start.character
          }))
        });
      }
      return true;
    }
    const result = await window.opendev.lsp.request<any>('textDocument/definition', {
      textDocument: { uri: fileUri },
      position: { line, character }
    });
    if (!result) return true;
    const loc = Array.isArray(result) ? result[0] : result;
    if (!loc) return true;
    const uri = loc.uri || loc.targetUri;
    const range = loc.range || loc.targetSelectionRange || loc.targetRange;
    if (!uri || !range) return true;
    onJumpToRef.current?.(uri.replace(/^file:\/\//, ''), range.start.line, range.start.character);
    return true;
  };

  useEffect(() => {
    if (!ref.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        foldGutter(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        autocompletion(),
        syntaxHighlighting(ideHighlight, { fallback: true }),
        langForPath(path),
        EditorView.theme({
          '&': { backgroundColor: 'transparent', color: 'var(--fg-0)', opacity: '1' },
          '.cm-scroller': { opacity: '1' },
          '.cm-content': { color: 'var(--fg-0)' },
          '.cm-line': { color: 'var(--fg-0)' },
          '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--fg-3)' },
          '.cm-cursor': { borderLeftColor: '#1177bb' },
          '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.04)' },
          '.cm-selectionBackground, .cm-content ::selection': { backgroundColor: '#264f78 !important' }
        }, { dark: true }),
        keymap.of([
          ...defaultKeymap, ...historyKeymap, ...searchKeymap, ...completionKeymap,
          ...closeBracketsKeymap, ...foldKeymap, ...lintKeymap, indentWithTab,
          { key: 'Mod-s', preventDefault: true, run: () => { onSaveRef.current(); return true; } }
        ]),
        blameField,
        ...(blameOn ? [blameGutter] : []),
        EditorView.domEventHandlers({
          mousedown: (e, view) => {
            if (!(e.metaKey || e.ctrlKey)) return false;
            e.preventDefault();
            handleCmdClick(e as MouseEvent, view, e.shiftKey);
            return true;
          }
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            onChangeRef.current(u.state.doc.toString());
            // Debounced LSP didChange notification so the server's view of
            // the doc stays in sync with the user's edits.
            if (langId) {
              if (debounceRef.current) clearTimeout(debounceRef.current);
              debounceRef.current = setTimeout(() => {
                versionRef.current += 1;
                window.opendev.lsp.notify('textDocument/didChange', {
                  textDocument: { uri: fileUri, version: versionRef.current },
                  contentChanges: [{ text: u.state.doc.toString() }]
                });
              }, 250);
            }
          }
        })
      ]
    });
    const view = new EditorView({ state, parent: ref.current });
    viewRef.current = view;
    // Notify the language server that this doc is open so go-to-definition
    // and references work without first having to make an edit.
    if (langId) {
      versionRef.current = 1;
      window.opendev.lsp.notify('textDocument/didOpen', {
        textDocument: { uri: fileUri, languageId: langId, version: 1, text: value }
      });
    }
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (langId) {
        try { window.opendev.lsp.notify('textDocument/didClose', { textDocument: { uri: fileUri } }); } catch {}
      }
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, blameOn]);

  // Fetch git blame when annotation is enabled (or path changes while it is on)
  useEffect(() => {
    if (!blameOn) return;
    let alive = true;
    (async () => {
      const r = await window.opendev.git.blame(path);
      if (!alive) return;
      const view = viewRef.current;
      if (!view) return;
      if ('error' in r) {
        console.warn('[blame] git blame failed for', path, '→', r.error);
        view.dispatch({ effects: setBlameEffect.of(null) });
      } else {
        console.log('[blame]', path, '→', r.lines?.length ?? 0, 'lines');
        // Retry dispatch on the next tick to ensure the gutter extension
        // is mounted before we feed data to it (the editor may have just
        // re-instantiated when blameOn flipped).
        view.dispatch({ effects: setBlameEffect.of(r.lines) });
      }
    })();
    return () => { alive = false; };
  }, [path, blameOn]);

  // Dismiss the gutter context menu on outside click
  useEffect(() => {
    const dismiss = () => setGutterCtx(null);
    window.addEventListener('click', dismiss);
    return () => window.removeEventListener('click', dismiss);
  }, []);

  const showHistory = async (focusHash?: string) => {
    setHistoryOpen(true); setHistoryList(null); setHistoryError(undefined);
    const r = await window.opendev.git.fileLog(path, 500);
    if ('error' in r) setHistoryError(r.error);
    else {
      const commits = r.commits as Array<{ hash: string; date: string; message: string; author_name?: string }>;
      setHistoryList(commits);
      // If the requested hash isn't in the file's log (e.g. blame found a
      // pre-rename commit), still load its diff.
      if (focusHash) showCommit(focusHash);
    }
  };

  const showCommit = async (hash: string) => {
    setShowingCommit(hash); setCommitDiff(null);
    const dir = path.split('/').slice(0, -1).join('/');
    const r = await window.opendev.git.show(dir, hash);
    if ('error' in r) setCommitDiff(`error: ${r.error}`);
    else setCommitDiff(r.diff);
  };

  // Open the diff full-screen as a center tab — replaces the cramped modal
  // pane for actual reading.
  const openCommitInTab = async (hash: string) => {
    const dir = path.split('/').slice(0, -1).join('/');
    const r = await window.opendev.git.show(dir, hash);
    if ('error' in r) return;
    useGlobalStore.getState().openDiffTab({ filePath: path, hash, diff: r.diff });
    setHistoryOpen(false);
    setShowingCommit(null);
  };

  // Click-through on blame annotations → open the history modal scoped to
  // that commit. Same affordance as WebStorm's "Annotate" → click → show
  // commit diff.
  useEffect(() => {
    const h = (e: Event) => {
      const hash = (e as CustomEvent).detail?.hash as string | undefined;
      if (!hash) return;
      showHistory(hash);
    };
    window.addEventListener('opendev:blame-click', h as EventListener);
    return () => window.removeEventListener('opendev:blame-click', h as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // If a pendingJump matches this file, move the caret + scroll into view.
  useEffect(() => {
    if (!pendingJump || pendingJump.path !== path) return;
    const view = viewRef.current;
    if (!view) return;
    try {
      const pos = lspToOffset(view.state.doc, pendingJump.line, pendingJump.col);
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    } catch {}
    setPendingJump(undefined);
  }, [pendingJump, path, setPendingJump]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return (
    <div
      style={{ height: '100%', overflow: 'hidden', position: 'relative' }}
      onContextMenu={(e) => {
        const t = e.target as HTMLElement | null;
        // Match any gutter element (line numbers, fold, blame, etc.)
        const inGutter = !!(t && (t.closest('.cm-gutters') || t.closest('.cm-gutter')));
        if (inGutter) {
          e.preventDefault();
          e.stopPropagation();
          setGutterCtx({ x: e.clientX, y: e.clientY });
        }
      }}
    >
      <div ref={ref} style={{ height: '100%', overflow: 'hidden' }} />
      {gutterCtx && (
        <div className="ctx-menu" style={{ left: gutterCtx.x, top: gutterCtx.y }} onClick={(e) => e.stopPropagation()}>
          <div className="item" onClick={() => { setBlameOn(v => !v); setGutterCtx(null); }}>
            {blameOn ? 'Hide Annotations' : 'Show Annotations (git blame)'}
          </div>
          <div className="item" onClick={() => { showHistory(); setGutterCtx(null); }}>
            Show File History…
          </div>
        </div>
      )}
      {historyOpen && (
        <div className="modal-overlay" onMouseDown={() => { setHistoryOpen(false); setShowingCommit(null); }}>
          <div className="modal git-history-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="git-history-header">
              <span>History · {path.split('/').pop()}</span>
              <span className="grow" />
              {historyList && <span className="git-history-count">{historyList.length} commit{historyList.length === 1 ? '' : 's'}</span>}
              <button onClick={() => { setHistoryOpen(false); setShowingCommit(null); }}>Close</button>
            </div>
            <div className="git-history-list-only">
              {historyError && <div className="db-test-error" style={{ margin: 12 }}>{historyError}</div>}
              {!historyError && !historyList && <div className="db-empty">Loading…</div>}
              {historyList && historyList.length === 0 && <div className="db-empty">No commits affecting this file.</div>}
              {historyList && historyList.map((c) => {
                const date = c.date ? new Date(c.date).toISOString().slice(0, 10) : '';
                return (
                  <div key={c.hash}
                    className="git-history-row"
                    title="Click to open diff in a new tab"
                    onClick={() => openCommitInTab(c.hash)}>
                    <div className="git-history-row-top">
                      <span className="git-history-hash">{c.hash.slice(0, 7)}</span>
                      <span className="git-history-msg">{c.message.split('\n')[0]}</span>
                    </div>
                    <div className="git-history-row-bot">
                      <span className="git-history-author">{c.author_name || 'unknown'}</span>
                      <span className="git-history-date">{date}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
