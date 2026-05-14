// Security Scan — dependency-free secret/credential scan of the workspace.
// Walks the codebase looking for hardcoded secrets, private keys, and
// committed .env files, then emits an HTML report.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.OPENDEV_WORKSPACE_ROOT || process.cwd();
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage',
  '.opendev', '.cache', 'vendor', '.turbo', '.parcel-cache'
]);
const TEXT_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|json|ya?ml|sh|bash|zsh|py|rb|go|java|php|rs|c|cc|cpp|cs|kt|swift|env|config|conf|ini|properties|xml|txt|md|html|css|scss|sql)$/i;
const MAX_FILE = 2 * 1024 * 1024;

const PATTERNS = [
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/g, sev: 'high' },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g, sev: 'high' },
  { name: 'Slack token', re: /xox[baprs]-[0-9A-Za-z-]{10,}/g, sev: 'high' },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/g, sev: 'high' },
  { name: 'GitHub token', re: /gh[pousr]_[0-9A-Za-z]{36,}/g, sev: 'high' },
  { name: 'DB URL with password', re: /(?:mysql|postgres(?:ql)?|mongodb(?:\+srv)?):\/\/[^\s:'"]+:[^\s@'"]+@/gi, sev: 'medium' },
  { name: 'Hardcoded secret/token', re: /(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)["']?\s*[:=]\s*["'][^"'\s]{12,}["']/gi, sev: 'medium' },
  { name: 'JWT-like token', re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, sev: 'low' }
];

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

const findings = [];
const files = walk(ROOT);
let scanned = 0;

for (const f of files) {
  const base = path.basename(f);
  const rel = path.relative(ROOT, f);

  // Committed real .env files (not examples/templates).
  if (/^\.env(\..+)?$/.test(base) && !/example|sample|template|dist/i.test(base)) {
    findings.push({ rel, line: 0, sev: 'medium', name: 'Committed .env file', snippet: base });
  }

  if (!TEXT_EXT.test(base)) continue;
  let stat;
  try { stat = fs.statSync(f); } catch { continue; }
  if (stat.size > MAX_FILE) continue;
  let content;
  try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
  scanned++;
  const lines = content.split('\n');
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(content)) !== null) {
      const lineNo = content.slice(0, m.index).split('\n').length;
      const snippet = (lines[lineNo - 1] || '').trim().slice(0, 140);
      findings.push({ rel, line: lineNo, sev: p.sev, name: p.name, snippet });
      if (p.re.lastIndex === m.index) p.re.lastIndex++;
    }
  }
}

const order = { high: 0, medium: 1, low: 2 };
findings.sort((a, b) => (order[a.sev] - order[b.sev]) || a.rel.localeCompare(b.rel) || a.line - b.line);
const counts = { high: 0, medium: 0, low: 0 };
for (const x of findings) counts[x.sev]++;

const rows = findings.map((x) => `
  <tr class="sev-${x.sev}">
    <td class="sev"><span class="badge ${x.sev}">${x.sev}</span></td>
    <td class="what">${esc(x.name)}</td>
    <td class="loc">${esc(x.rel)}${x.line ? ':' + x.line : ''}</td>
    <td class="snip"><code>${esc(x.snippet || '')}</code></td>
  </tr>`).join('');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font: 13px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 24px; background: #1e1e1e; color: #d4d4d4; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #888; margin-bottom: 18px; }
  .summary { display: flex; gap: 10px; margin-bottom: 20px; }
  .stat { background: #2d2d30; border: 1px solid #3c3c3c; border-radius: 8px; padding: 10px 16px; }
  .stat .n { font-size: 22px; font-weight: 700; }
  .stat.high .n { color: #f48771; } .stat.medium .n { color: #cca700; } .stat.low .n { color: #4ec9b0; }
  .stat .l { font-size: 11px; text-transform: uppercase; color: #888; letter-spacing: .05em; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; color: #888; padding: 6px 8px; border-bottom: 1px solid #3c3c3c; }
  td { padding: 6px 8px; border-bottom: 1px solid #2a2a2a; vertical-align: top; }
  .badge { font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 2px 7px; border-radius: 4px; }
  .badge.high { background: rgba(244,135,113,.18); color: #f48771; }
  .badge.medium { background: rgba(204,167,0,.18); color: #cca700; }
  .badge.low { background: rgba(78,201,176,.18); color: #4ec9b0; }
  .loc { font-family: ui-monospace, Menlo, monospace; color: #9cdcfe; font-size: 12px; }
  .snip code { font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; color: #ce9178; word-break: break-all; }
  .ok { background: #2d2d30; border: 1px solid #3c3c3c; border-radius: 8px; padding: 24px; text-align: center; color: #4ec9b0; }
</style></head><body>
  <h1>🔒 Security Scan</h1>
  <div class="sub">Scanned ${scanned} text files under ${esc(ROOT)}</div>
  <div class="summary">
    <div class="stat high"><div class="n">${counts.high}</div><div class="l">High</div></div>
    <div class="stat medium"><div class="n">${counts.medium}</div><div class="l">Medium</div></div>
    <div class="stat low"><div class="n">${counts.low}</div><div class="l">Low</div></div>
  </div>
  ${findings.length === 0
    ? '<div class="ok">✓ No hardcoded secrets or credentials found.</div>'
    : `<table><thead><tr><th>Severity</th><th>Finding</th><th>Location</th><th>Snippet</th></tr></thead><tbody>${rows}</tbody></table>`}
</body></html>`;

console.log(html);
