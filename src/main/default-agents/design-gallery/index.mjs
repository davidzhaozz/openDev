// Design Gallery — surveys the UI surface of the project: renders every
// standalone HTML file in a live preview grid, and inventories CSS and
// component files. A quick visual overview of the project's design.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.OPENDEV_WORKSPACE_ROOT || process.cwd();
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage',
  '.opendev', '.cache', 'vendor', '.turbo', '.parcel-cache'
]);
const MAX_HTML = 512 * 1024;

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Escape content for use inside a double-quoted srcdoc="" attribute.
function attrEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

const files = walk(ROOT);
const htmlFiles = [];
let cssCount = 0;
let componentCount = 0;

for (const f of files) {
  const ext = path.extname(f).toLowerCase();
  if (ext === '.html' || ext === '.htm') {
    let stat;
    try { stat = fs.statSync(f); } catch { continue; }
    if (stat.size > MAX_HTML) continue;
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    htmlFiles.push({ rel: path.relative(ROOT, f), content });
  } else if (ext === '.css' || ext === '.scss' || ext === '.sass' || ext === '.less') {
    cssCount++;
  } else if (/\.(jsx|tsx|vue|svelte)$/i.test(f)) {
    componentCount++;
  }
}

const cards = htmlFiles.slice(0, 40).map((h) => `
  <div class="card">
    <div class="card-head">${esc(h.rel)}</div>
    <div class="frame-wrap">
      <iframe sandbox="" srcdoc="${attrEsc(h.content)}"></iframe>
    </div>
  </div>`).join('');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font: 13px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 24px; background: #1e1e1e; color: #d4d4d4; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #888; margin-bottom: 18px; }
  .summary { display: flex; gap: 10px; margin-bottom: 22px; flex-wrap: wrap; }
  .stat { background: #2d2d30; border: 1px solid #3c3c3c; border-radius: 8px; padding: 10px 16px; min-width: 90px; }
  .stat .n { font-size: 22px; font-weight: 700; color: #9cdcfe; }
  .stat .l { font-size: 11px; text-transform: uppercase; color: #888; letter-spacing: .05em; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
  .card { background: #2d2d30; border: 1px solid #3c3c3c; border-radius: 8px; overflow: hidden; }
  .card-head { font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; color: #9cdcfe; padding: 8px 10px; border-bottom: 1px solid #3c3c3c; }
  .frame-wrap { height: 240px; background: #fff; }
  iframe { width: 100%; height: 100%; border: 0; }
  .empty { background: #2d2d30; border: 1px solid #3c3c3c; border-radius: 8px; padding: 24px; text-align: center; color: #888; }
</style></head><body>
  <h1>🎨 Design Gallery</h1>
  <div class="sub">UI surface of ${esc(ROOT)}</div>
  <div class="summary">
    <div class="stat"><div class="n">${htmlFiles.length}</div><div class="l">HTML pages</div></div>
    <div class="stat"><div class="n">${cssCount}</div><div class="l">Stylesheets</div></div>
    <div class="stat"><div class="n">${componentCount}</div><div class="l">Components</div></div>
  </div>
  ${htmlFiles.length === 0
    ? `<div class="empty">No standalone HTML files found to preview.<br>This project has ${cssCount} stylesheet(s) and ${componentCount} component file(s) — its UI is likely rendered by a framework.</div>`
    : `<div class="grid">${cards}</div>`}
</body></html>`;

console.log(html);
