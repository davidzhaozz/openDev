// TODO Collector — scans the codebase for TODO / FIXME / HACK / XXX / BUG
// comment markers and turns them into a checklist of tasks, grouped by file.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.OPENDEV_WORKSPACE_ROOT || process.cwd();
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage',
  '.opendev', '.cache', 'vendor', '.turbo', '.parcel-cache'
]);
const TEXT_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte|py|rb|go|java|php|rs|c|cc|cpp|cs|kt|swift|sh|css|scss|html|md|yml|yaml|sql)$/i;
const MAX_FILE = 2 * 1024 * 1024;
const MARKER = /\b(TODO|FIXME|HACK|XXX|BUG)\b[:\s-]*(.*)$/;

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out);
    } else if (e.isFile() && TEXT_EXT.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const byFile = new Map();
const tagCounts = { TODO: 0, FIXME: 0, HACK: 0, XXX: 0, BUG: 0 };
let total = 0;

for (const f of walk(ROOT)) {
  let stat;
  try { stat = fs.statSync(f); } catch { continue; }
  if (stat.size > MAX_FILE) continue;
  let content;
  try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const lines = content.split('\n');
  const rel = path.relative(ROOT, f);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(MARKER);
    if (!m) continue;
    const tag = m[1].toUpperCase();
    tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    total++;
    if (!byFile.has(rel)) byFile.set(rel, []);
    byFile.get(rel).push({ line: i + 1, tag, text: (m[2] || '').trim().slice(0, 200) });
  }
}

const sortedFiles = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);

const sections = sortedFiles.map(([rel, items]) => {
  const rows = items.map((it) => `
    <li class="task">
      <span class="tag ${it.tag.toLowerCase()}">${it.tag}</span>
      <span class="line">:${it.line}</span>
      <span class="text">${esc(it.text) || '<em>(no description)</em>'}</span>
    </li>`).join('');
  return `<div class="file"><div class="file-name">${esc(rel)} <span class="file-n">${items.length}</span></div><ul>${rows}</ul></div>`;
}).join('');

const chips = Object.entries(tagCounts).filter(([, n]) => n > 0)
  .map(([t, n]) => `<span class="chip ${t.toLowerCase()}">${t} ${n}</span>`).join('');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font: 13px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 24px; background: #1e1e1e; color: #d4d4d4; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #888; margin-bottom: 14px; }
  .chips { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
  .chip { font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 5px; background: #2d2d30; border: 1px solid #3c3c3c; }
  .chip.todo { color: #4ec9b0; } .chip.fixme { color: #f48771; } .chip.hack { color: #cca700; }
  .chip.xxx { color: #c586c0; } .chip.bug { color: #f48771; }
  .file { margin-bottom: 16px; }
  .file-name { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: #9cdcfe; margin-bottom: 4px; }
  .file-n { background: #3c3c3c; color: #ccc; border-radius: 8px; padding: 0 6px; font-size: 10px; }
  ul { list-style: none; margin: 0; padding: 0; }
  .task { display: flex; gap: 8px; align-items: baseline; padding: 3px 0 3px 12px; border-left: 2px solid #2a2a2a; }
  .tag { font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 4px; flex-shrink: 0; }
  .tag.todo { background: rgba(78,201,176,.18); color: #4ec9b0; }
  .tag.fixme, .tag.bug { background: rgba(244,135,113,.18); color: #f48771; }
  .tag.hack { background: rgba(204,167,0,.18); color: #cca700; }
  .tag.xxx { background: rgba(197,134,192,.18); color: #c586c0; }
  .line { font-family: ui-monospace, Menlo, monospace; color: #888; font-size: 11px; flex-shrink: 0; }
  .text { color: #d4d4d4; }
  .ok { background: #2d2d30; border: 1px solid #3c3c3c; border-radius: 8px; padding: 24px; text-align: center; color: #4ec9b0; }
</style></head><body>
  <h1>✅ TODO Collector</h1>
  <div class="sub">${total} marker${total === 1 ? '' : 's'} across ${byFile.size} file${byFile.size === 1 ? '' : 's'} · under ${esc(ROOT)}</div>
  <div class="chips">${chips || ''}</div>
  ${total === 0 ? '<div class="ok">✓ No TODO/FIXME markers found — clean codebase.</div>' : sections}
</body></html>`;

console.log(html);
