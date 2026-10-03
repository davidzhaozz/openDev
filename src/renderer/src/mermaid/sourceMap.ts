// Source map between a .mmd file and the SVG mermaid renders from it.
//
// Mermaid emits no source map, so we rebuild one: scan the source the way
// the parser roughly sees it (bare identifiers, bracketed/quoted labels,
// arrows) and match those against the ids and text mermaid stamps into the
// SVG. It is a heuristic — an unmatched element simply isn't clickable
// rather than jumping somewhere wrong.

/** Words that are syntax, not node names. Kept small on purpose. */
const KEYWORDS = new Set([
  'graph', 'flowchart', 'subgraph', 'end', 'direction',
  'td', 'tb', 'bt', 'lr', 'rl',
  'sequencediagram', 'participant', 'actor', 'activate', 'deactivate',
  'autonumber', 'note', 'over', 'left', 'right', 'of', 'loop', 'alt',
  'else', 'opt', 'par', 'and', 'critical', 'break', 'rect',
  'classdiagram', 'classdiagram-v2', 'class', 'classdef', 'cssclass',
  'statediagram', 'statediagram-v2', 'state', 'erdiagram',
  'gantt', 'journey', 'pie', 'gitgraph', 'mindmap', 'timeline',
  'quadrantchart', 'requirementdiagram', 'c4context',
  'title', 'section', 'dateformat', 'axisformat', 'excludes', 'todaymarker',
  'style', 'linkstyle', 'click', 'accdescr', 'acctitle', 'showdata'
]);

const ARROW_RE = /(--|==|\.\.|->|=>|>>|<-|\|\|)/;

export type SourceIndex = {
  /** identifier → the 1-based lines it is declared or referenced on. */
  idLines: Map<string, number[]>;
  /** Every arrow line, as the ordered id pairs it could describe. */
  edges: Array<{ a: string; b: string; line: number }>;
  /** Normalized label text → the lines it appears on, in order. */
  labelLines: Map<string, number[]>;
  /** Lines carrying an arrow, in source order — mermaid numbers edges the same way. */
  arrowLines: number[];
  lineCount: number;
};

/** Collapses a label to a comparable form: no markup, no case, no runs. */
export function normalizeLabel(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;|#quot;/gi, '"')
    .replace(/&amp;|#amp;/gi, '&')
    .replace(/\\n/g, ' ')
    .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Strips the shape characters mermaid wraps a label in: [[x]], ([x]), {{x}}. */
function unwrapShape(s: string): string {
  return s.replace(/^[[\](){}<>/\\|"'\s]+/, '').replace(/[[\](){}<>/\\|"'\s]+$/, '');
}

type LineScan = { ids: string[]; labels: string[]; arrow: boolean };

/**
 * Splits one line into the labels it carries and the bare identifiers left
 * over. Labels are pulled out first so `A[Do the thing]` yields the id `A`
 * and the label `Do the thing` — not three stray words.
 */
function scanLine(raw: string): LineScan {
  const labels: string[] = [];
  let bare = '';
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"' || c === '|') {
      const end = raw.indexOf(c, i + 1);
      if (end === -1) { bare += raw.slice(i); break; }
      labels.push(raw.slice(i + 1, end));
      bare += ' ';
      i = end + 1;
      continue;
    }
    const close = c === '[' ? ']' : c === '(' ? ')' : c === '{' ? '}' : null;
    if (close) {
      // Balanced scan, so [[A]] / ([B]) / {{C}} come out as one label.
      let depth = 0;
      let j = i;
      for (; j < raw.length; j++) {
        if (raw[j] === c) depth++;
        else if (raw[j] === close) { depth--; if (depth === 0) break; }
      }
      if (j >= raw.length) { bare += raw.slice(i); break; }
      labels.push(raw.slice(i + 1, j));
      bare += ' ';
      i = j + 1;
      continue;
    }
    bare += c;
    i++;
  }

  // `Alice->>Bob: hi` and `Task name : t1, 2d` both put free text either
  // side of a colon. Identifiers only ever live before it.
  const colon = bare.indexOf(':');
  let idPart = bare;
  if (colon !== -1) {
    const before = bare.slice(0, colon).trim();
    const after = bare.slice(colon + 1).trim();
    if (after) labels.push(after);
    // Gantt / journey / pie name their row before the colon.
    if (before && !ARROW_RE.test(before)) labels.push(before);
    idPart = before;
  }

  const ids: string[] = [];
  for (const m of idPart.matchAll(/[A-Za-z_][A-Za-z0-9_.]*/g)) {
    const tok = m[0];
    if (KEYWORDS.has(tok.toLowerCase())) continue;
    ids.push(tok);
  }
  return { ids, labels, arrow: ARROW_RE.test(bare) };
}

export function buildSourceIndex(src: string): SourceIndex {
  const idLines = new Map<string, number[]>();
  const labelLines = new Map<string, number[]>();
  const edges: SourceIndex['edges'] = [];
  const arrowLines: number[] = [];
  const lines = src.split(/\r?\n/);

  let inFrontmatter = false;
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    const lineNo = n + 1;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // YAML frontmatter (--- ... ---) and %% comments are not diagram content.
    if (trimmed === '---') { inFrontmatter = !inFrontmatter; continue; }
    if (inFrontmatter) continue;
    if (trimmed.startsWith('%%')) continue;

    const { ids, labels, arrow } = scanLine(raw);
    for (const id of ids) {
      const arr = idLines.get(id);
      if (arr) { if (!arr.includes(lineNo)) arr.push(lineNo); } else idLines.set(id, [lineNo]);
    }
    for (const label of labels) {
      const key = normalizeLabel(unwrapShape(label));
      if (!key) continue;
      const arr = labelLines.get(key);
      if (arr) { if (!arr.includes(lineNo)) arr.push(lineNo); } else labelLines.set(key, [lineNo]);
    }
    if (arrow) {
      arrowLines.push(lineNo);
      for (let a = 0; a < ids.length; a++) {
        for (let b = a + 1; b < ids.length; b++) edges.push({ a: ids[a], b: ids[b], line: lineNo });
      }
    }
  }

  return { idLines, edges, labelLines, arrowLines, lineCount: lines.length };
}

export function hasId(index: SourceIndex, id: string): boolean {
  return index.idLines.has(id);
}

/** Where an identifier is first mentioned. */
export function lineForId(index: SourceIndex, id: string): number | null {
  return index.idLines.get(id)?.[0] ?? null;
}

/** The nth (0-based) line that draws an edge between two identifiers. */
export function lineForEdge(index: SourceIndex, a: string, b: string, nth = 0): number | null {
  const hits = index.edges.filter(e => (e.a === a && e.b === b) || (e.a === b && e.b === a));
  if (!hits.length) return null;
  return (hits[nth] ?? hits[hits.length - 1]).line;
}

/** Exact label match first, then a containment match for truncated text. */
export function lineForLabel(index: SourceIndex, text: string, used: Set<number>): number | null {
  const key = normalizeLabel(text);
  if (!key) return null;
  const exact = index.labelLines.get(key);
  if (exact) {
    const fresh = exact.find(l => !used.has(l));
    return fresh ?? exact[0];
  }
  if (key.length < 3) return null;
  let best: number | null = null;
  for (const [k, lns] of index.labelLines) {
    if (k.length < 3) continue;
    if (!k.includes(key) && !key.includes(k)) continue;
    const fresh = lns.find(l => !used.has(l));
    const cand = fresh ?? lns[0];
    if (best === null || cand < best) best = cand;
  }
  return best;
}

/** Prefixes mermaid puts in front of the author's own id in a DOM id. */
const DOM_ID_PREFIXES = [
  'flowchart-', 'classId-', 'stateid-', 'state-', 'entity-', 'node-',
  'actor-', 'nodeid-', 'mermaid-'
];

type DomKey =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; a: string; b: string; nth: number }
  | { kind: 'edge-ordinal'; nth: number };

/** Every id in the SVG is namespaced with the id passed to mermaid.render. */
function stripRenderId(raw: string, renderId?: string): string {
  if (!renderId) return raw;
  for (const sep of ['-', '_']) {
    const p = renderId + sep;
    if (raw.startsWith(p)) return raw.slice(p.length);
  }
  return raw;
}

/** `classId-Animal-0` / `entity-ORDER-1` → the author's own identifier. */
function resolveIdPart(part: string, index: SourceIndex): string | null {
  let body = part;
  for (const p of DOM_ID_PREFIXES) {
    if (body.startsWith(p)) { body = body.slice(p.length); break; }
  }
  for (const cand of [body.replace(/-\d+$/, ''), body, part]) {
    if (hasId(index, cand)) return cand;
  }
  return null;
}

/**
 * Recovers the author's identifier(s) from a DOM id such as
 * `flowchart-Start-0`, `L_Start_Finish_0` or `id_entity-A-0_entity-B-1_0`.
 * Edge ids are ambiguous — the separator also appears inside identifiers —
 * so every possible split is validated against ids we saw in the source.
 */
export function domIdToKey(rawWithPrefix: string, index: SourceIndex, renderId?: string): DomKey | null {
  if (!rawWithPrefix) return null;
  const raw = stripRenderId(rawWithPrefix, renderId);

  // stateDiagram names its edges by position only.
  const ordinal = raw.match(/^edge(\d+)$/);
  if (ordinal) return { kind: 'edge-ordinal', nth: Number(ordinal[1]) };

  const edgeMatch = raw.match(/^(?:L|id)[_-](.+)[_-](\d+)$/);
  if (edgeMatch) {
    const middle = edgeMatch[1];
    const nth = Number(edgeMatch[2]) || 0;
    for (const sep of ['_', '-']) {
      let at = middle.indexOf(sep);
      while (at !== -1) {
        const a = resolveIdPart(middle.slice(0, at), index);
        const b = resolveIdPart(middle.slice(at + 1), index);
        if (a && b) return { kind: 'edge', a, b, nth };
        at = middle.indexOf(sep, at + 1);
      }
    }
    return null;
  }

  const id = resolveIdPart(raw, index);
  return id ? { kind: 'node', id } : null;
}

/**
 * Tags every element we can trace back to a line with `data-mmd-line`, so a
 * click resolves via `closest()` and a caret move finds its element with a
 * single query. Returns how many elements were tagged.
 */
export function annotateSvg(svg: SVGSVGElement, index: SourceIndex, renderId?: string): number {
  const used = new Set<number>();
  let tagged = 0;

  const mark = (el: Element | null | undefined, line: number | null): boolean => {
    if (!el || line == null || line < 1) return false;
    if (el.hasAttribute('data-mmd-line')) return false;
    el.setAttribute('data-mmd-line', String(line));
    el.classList.add('mmd-hit');
    used.add(line);
    tagged++;
    return true;
  };

  // 1. Anything mermaid gave a structured id — nodes, edge paths, states.
  for (const el of Array.from(svg.querySelectorAll('[id]'))) {
    const key = domIdToKey(el.getAttribute('id') || '', index, renderId);
    if (!key) continue;
    if (key.kind === 'node') mark(el, lineForId(index, key.id));
    else if (key.kind === 'edge') mark(el, lineForEdge(index, key.a, key.b, key.nth));
    else mark(el, index.arrowLines[key.nth] ?? null);
  }

  // 2. Edge labels ship in their own group, in the same order as the paths.
  const edgeEls = Array.from(svg.querySelectorAll('.edgePaths > *, g.edgePath'));
  const edgeLabelEls = Array.from(svg.querySelectorAll('.edgeLabels > *, g.edgeLabel'));
  edgeLabelEls.forEach((labelEl, i) => {
    const host = edgeEls[i];
    if (!host) return;
    const src = host.getAttribute('data-mmd-line')
      ?? host.querySelector('[data-mmd-line]')?.getAttribute('data-mmd-line');
    if (src) mark(labelEl, Number(src));
  });

  // 3. Everything else — sequence actors, messages, pie slices, gantt rows —
  //    matched on the text mermaid actually drew.
  const textish = Array.from(svg.querySelectorAll(
    'text, span.nodeLabel, span.edgeLabel, .messageText, .actor, .loopText, .noteText'
  ));
  for (const el of textish) {
    if (el.closest('[data-mmd-line]')) continue;
    const text = (el.textContent || '').trim();
    if (!text || text.length > 200) continue;
    // Some diagrams draw the bare identifier as the label (state, ER).
    const line = lineForLabel(index, text, used) ?? lineForId(index, text);
    if (line == null) continue;
    // Prefer the enclosing group so the whole shape highlights rather than
    // the glyph — but only when that group is this label's own, or a pie
    // chart's outer <g> would swallow every slice under its title's line.
    const group = el.closest('g');
    const ownGroup = group && group.querySelectorAll('text, span.nodeLabel').length <= 1
      ? group
      : el;
    if (!mark(ownGroup, line)) mark(el, line);
  }

  return tagged;
}

/** Elements drawn from one source line — the source → diagram direction. */
export function elementsForLine(svg: SVGSVGElement, line: number): Element[] {
  return Array.from(svg.querySelectorAll('[data-mmd-line="' + line + '"]'));
}
