// Code Quality — runs ESLint if it's installed in the workspace, and always
// reports dependency-free metrics (file counts, size, LOC, TODO density).
// If ESLint isn't installed it tells you how to add it.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.env.OPENDEV_WORKSPACE_ROOT || process.cwd();
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage',
  '.opendev', '.cache', 'vendor', '.turbo', '.parcel-cache'
]);
const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte)$/i;
const MAX_FILE = 4 * 1024 * 1024;

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

// ── Dependency-free metrics ──────────────────────────────────────────
const files = walk(ROOT);
const byExt = {};
let totalLoc = 0;
let todoCount = 0;
const largest = [];

for (const f of files) {
  const ext = (path.extname(f) || '(none)').toLowerCase();
  byExt[ext] = (byExt[ext] || 0) + 1;
  if (!CODE_EXT.test(f)) continue;
  let stat;
  try { stat = fs.statSync(f); } catch { continue; }
  if (stat.size > MAX_FILE) continue;
  let content;
  try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const loc = content.split('\n').length;
  totalLoc += loc;
  todoCount += (content.match(/\b(?:TODO|FIXME|HACK|XXX)\b/g) || []).length;
  largest.push({ rel: path.relative(ROOT, f), loc });
}
largest.sort((a, b) => b.loc - a.loc);
const topLargest = largest.slice(0, 10);
const codeFileCount = largest.length;

// ── ESLint (only if installed in the workspace) ──────────────────────
const eslintBin = path.join(ROOT, 'node_modules', '.bin', 'eslint');
const eslintAvailable = fs.existsSync(eslintBin);
let eslintResults = null;
let eslintError = null;
if (eslintAvailable) {
  try {
    const out = execFileSync(eslintBin, ['.', '--format', 'json', '--no-error-on-unmatched-pattern'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
    });
    eslintResults = JSON.parse(out);
  } catch (err) {
    // ESLint exits 1 when it finds lint problems — the JSON is still on stdout.
    if (err && err.stdout) {
      try { eslintResults = JSON.parse(err.stdout.toString()); }
      catch { eslintError = String(err.message || err); }
    } else {
      eslintError = String((err && err.message) || err);
    }
  }
}

let eslintErrors = 0, eslintWarnings = 0;
const eslintTop = [];
if (eslintResults) {
  for (const r of eslintResults) {
    eslintErrors += r.errorCount || 0;
    eslintWarnings += r.warningCount || 0;
    if ((r.errorCount || 0) + (r.warningCount || 0) > 0) {
      eslintTop.push({ rel: path.relative(ROOT, r.filePath), e: r.errorCount || 0, w: r.warningCount || 0 });
    }
  }
  eslintTop.sort((a, b) => (b.e + b.w) - (a.e + a.w));
}

const extRows = Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 12)
  .map(([ext, n]) => `<tr><td class="loc">${esc(ext)}</td><td>${n}</td></tr>`).join('');
const largeRows = topLargest
  .map((x) => `<tr><td class="loc">${esc(x.rel)}</td><td>${x.loc}</td></tr>`).join('');

let eslintSection;
if (!eslintAvailable) {
  eslintSection = `<div class="callout">
    <strong>ESLint is not installed in this project.</strong><br>
    Install it to enable lint checks here:
    <pre>npm install --save-dev eslint</pre>
    Then re-run this agent.
  </div>`;
} else if (eslintError) {
  eslintSection = `<div class="callout">ESLint ran but couldn't be parsed: <code>${esc(eslintError)}</code></div>`;
} else {
  const rows = eslintTop.slice(0, 15)
    .map((x) => `<tr><td class="loc">${esc(x.rel)}</td><td class="err">${x.e}</td><td class="warn">${x.w}</td></tr>`).join('');
  eslintSection = `
    <div class="summary">
      <div class="stat err"><div class="n">${eslintErrors}</div><div class="l">Errors</div></div>
      <div class="stat warn"><div class="n">${eslintWarnings}</div><div class="l">Warnings</div></div>
    </div>
    ${eslintTop.length === 0
      ? '<div class="ok">✓ ESLint found no problems.</div>'
      : `<table><thead><tr><th>File</th><th>Errors</th><th>Warnings</th></tr></thead><tbody>${rows}</tbody></table>`}`;
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font: 13px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 24px; background: #1e1e1e; color: #d4d4d4; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 26px 0 10px; color: #cccccc; }
  .sub { color: #888; margin-bottom: 18px; }
  .summary { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
  .stat { background: #2d2d30; border: 1px solid #3c3c3c; border-radius: 8px; padding: 10px 16px; min-width: 80px; }
  .stat .n { font-size: 22px; font-weight: 700; }
  .stat .l { font-size: 11px; text-transform: uppercase; color: #888; letter-spacing: .05em; }
  .stat.err .n { color: #f48771; } .stat.warn .n { color: #cca700; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; color: #888; padding: 6px 8px; border-bottom: 1px solid #3c3c3c; }
  td { padding: 5px 8px; border-bottom: 1px solid #2a2a2a; }
  .loc { font-family: ui-monospace, Menlo, monospace; color: #9cdcfe; font-size: 12px; }
  td.err { color: #f48771; } td.warn { color: #cca700; }
  .callout { background: #2d2d30; border: 1px solid #cca700; border-radius: 8px; padding: 14px 16px; margin-bottom: 8px; }
  .callout pre { background: #1e1e1e; padding: 8px 10px; border-radius: 6px; margin: 8px 0 0; color: #ce9178; }
  .ok { background: #2d2d30; border: 1px solid #3c3c3c; border-radius: 8px; padding: 18px; text-align: center; color: #4ec9b0; }
  .grid { display: flex; gap: 24px; flex-wrap: wrap; }
  .grid > div { flex: 1; min-width: 220px; }
</style></head><body>
  <h1>📊 Code Quality</h1>
  <div class="sub">${codeFileCount} code files · ${totalLoc.toLocaleString()} lines · ${todoCount} TODO/FIXME markers · under ${esc(ROOT)}</div>

  <h2>ESLint</h2>
  ${eslintSection}

  <div class="grid">
    <div>
      <h2>Largest code files</h2>
      <table><thead><tr><th>File</th><th>Lines</th></tr></thead><tbody>${largeRows || '<tr><td colspan="2">No code files found.</td></tr>'}</tbody></table>
    </div>
    <div>
      <h2>Files by extension</h2>
      <table><thead><tr><th>Ext</th><th>Count</th></tr></thead><tbody>${extRows}</tbody></table>
    </div>
  </div>
</body></html>`;

console.log(html);
