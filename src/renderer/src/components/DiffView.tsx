import { useMemo } from 'react';

export type DiffMode = 'unified' | 'split';

type Side = { line: number; text: string; kind: 'ctx' | 'add' | 'del' } | null;
type AlignedRow = { left: Side; right: Side };
type Hunk = { header: string; oldStart: number; newStart: number; rows: AlignedRow[] };
type FileBlock = {
  path: string;
  meta: string[];          // diff --git, index, +++/---, rename info, etc.
  hunks: Hunk[];
  binary?: boolean;
};

/** Parse a unified diff (output of `git show` / `git diff`) into per-file
 *  blocks with hunks. Each hunk's lines are also pre-aligned for split view. */
function parseDiff(diff: string): { commitHeader: string[]; files: FileBlock[] } {
  const lines = diff.split('\n');
  const commitHeader: string[] = [];
  const files: FileBlock[] = [];
  let i = 0;
  while (i < lines.length && !lines[i].startsWith('diff --git')) {
    commitHeader.push(lines[i]);
    i++;
  }
  while (i < lines.length) {
    if (!lines[i].startsWith('diff --git')) { i++; continue; }
    const meta: string[] = [];
    const fileHeader = lines[i++];
    meta.push(fileHeader);
    // Parse the "diff --git a/path b/path" line for the path
    const pathMatch = fileHeader.match(/^diff --git a\/(\S+)\s+b\/(\S+)$/);
    const path = pathMatch ? pathMatch[2] : '(unknown)';
    let binary = false;
    // Collect file-level meta lines until first hunk header
    while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git')) {
      const l = lines[i];
      if (/^Binary files/.test(l)) binary = true;
      meta.push(l);
      i++;
    }
    const hunks: Hunk[] = [];
    while (i < lines.length && lines[i].startsWith('@@')) {
      const header = lines[i++];
      const m = header.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
      const oldStart = m ? Number(m[1]) : 1;
      const newStart = m ? Number(m[3]) : 1;
      const body: string[] = [];
      while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git')) {
        body.push(lines[i++]);
      }
      hunks.push({ header, oldStart, newStart, rows: alignHunkRows(body, oldStart, newStart) });
    }
    files.push({ path, meta, hunks, binary });
  }
  return { commitHeader, files };
}

/** Greedy alignment: pair each `+` line with the nearest preceding `-` line
 *  in the same change block so they appear side-by-side. */
function alignHunkRows(body: string[], oldStart: number, newStart: number): AlignedRow[] {
  const rows: AlignedRow[] = [];
  let oldLn = oldStart;
  let newLn = newStart;
  let pendingDels: { line: number; text: string }[] = [];
  const flush = () => {
    for (const d of pendingDels) rows.push({ left: { line: d.line, text: d.text, kind: 'del' }, right: null });
    pendingDels = [];
  };
  for (const line of body) {
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    const tag = line[0];
    const text = line.length > 0 ? line.slice(1) : '';
    if (tag === '-') {
      pendingDels.push({ line: oldLn++, text });
    } else if (tag === '+') {
      if (pendingDels.length > 0) {
        const d = pendingDels.shift()!;
        rows.push({
          left: { line: d.line, text: d.text, kind: 'del' },
          right: { line: newLn++, text, kind: 'add' }
        });
      } else {
        rows.push({ left: null, right: { line: newLn++, text, kind: 'add' } });
      }
    } else {
      // context line (' ' prefix or completely blank)
      flush();
      rows.push({
        left: { line: oldLn++, text, kind: 'ctx' },
        right: { line: newLn++, text, kind: 'ctx' }
      });
    }
  }
  flush();
  return rows;
}

export function DiffView({ diff, mode = 'split', showCommitHeader = true }: { diff: string; mode?: DiffMode; showCommitHeader?: boolean }) {
  const parsed = useMemo(() => parseDiff(diff), [diff]);

  return (
    <div className="diff-view">
      {showCommitHeader && parsed.commitHeader.length > 0 && parsed.commitHeader.some(l => l.trim()) && (
        <div className="diff-header">
          {parsed.commitHeader.map((l, i) => <div key={i} className="diff-header-line">{l}</div>)}
        </div>
      )}
      {parsed.files.map((f, fi) => (
        <div key={fi} className="diff-file">
          <div className="diff-file-header">
            <span className="diff-file-icon">▦</span>
            <span className="diff-file-path">{f.path}</span>
            {f.binary && <span className="diff-file-binary">binary</span>}
          </div>
          {f.binary && <div className="diff-empty">Binary file — not shown.</div>}
          {!f.binary && f.hunks.length === 0 && <div className="diff-empty">No changes shown (rename / mode only).</div>}
          {!f.binary && f.hunks.map((h, hi) => (
            mode === 'split'
              ? <SplitHunk key={hi} hunk={h} />
              : <UnifiedHunk key={hi} hunk={h} />
          ))}
        </div>
      ))}
    </div>
  );
}

function SplitHunk({ hunk }: { hunk: Hunk }) {
  return (
    <div className="diff-hunk">
      <div className="diff-hunk-header">{hunk.header}</div>
      <table className="diff-split">
        <colgroup>
          <col className="ln" /><col className="code" /><col className="ln" /><col className="code" />
        </colgroup>
        <tbody>
          {hunk.rows.map((row, i) => (
            <tr key={i}>
              <td className={`diff-ln ${row.left?.kind || 'empty'}`}>{row.left?.line ?? ''}</td>
              <td className={`diff-code ${row.left?.kind || 'empty'}`}>
                <span className="diff-marker">{row.left?.kind === 'del' ? '-' : ''}</span>
                <span className="diff-text">{row.left?.text ?? ''}</span>
              </td>
              <td className={`diff-ln ${row.right?.kind || 'empty'}`}>{row.right?.line ?? ''}</td>
              <td className={`diff-code ${row.right?.kind || 'empty'}`}>
                <span className="diff-marker">{row.right?.kind === 'add' ? '+' : ''}</span>
                <span className="diff-text">{row.right?.text ?? ''}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UnifiedHunk({ hunk }: { hunk: Hunk }) {
  // Reconstruct unified lines from aligned rows
  return (
    <div className="diff-hunk">
      <div className="diff-hunk-header">{hunk.header}</div>
      <div className="diff-unified">
        {hunk.rows.flatMap((row, i) => {
          const out: React.ReactNode[] = [];
          if (row.left && row.left.kind === 'del') {
            out.push(
              <div key={`${i}-l`} className="diff-line diff-line-del">
                <span className="diff-ln">{row.left.line}</span>
                <span className="diff-marker">-</span>
                <span className="diff-text">{row.left.text}</span>
              </div>
            );
          }
          if (row.right && row.right.kind === 'add') {
            out.push(
              <div key={`${i}-r`} className="diff-line diff-line-add">
                <span className="diff-ln">{row.right.line}</span>
                <span className="diff-marker">+</span>
                <span className="diff-text">{row.right.text}</span>
              </div>
            );
          }
          if (row.left && row.left.kind === 'ctx') {
            out.push(
              <div key={`${i}-c`} className="diff-line diff-line-ctx">
                <span className="diff-ln">{row.left.line}</span>
                <span className="diff-marker"> </span>
                <span className="diff-text">{row.left.text}</span>
              </div>
            );
          }
          return out;
        })}
      </div>
    </div>
  );
}
