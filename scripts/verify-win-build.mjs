#!/usr/bin/env node
// Post-flight for a Windows build: prove the artifacts are what we think.
//
// The failure this exists for is silent. `scripts/win-sign-env.ps1` has to be
// DOT-SOURCED; run normally it sets CSC_LINK in a child shell that exits
// immediately, electron-builder then signs nothing, and the build succeeds with
// no error and no warning. You end up shipping — and installing — an unsigned
// build believing it is signed, which is precisely the thing the signing work
// was meant to fix.
//
// So: if a certificate was configured, every artifact must actually carry a
// valid signature, and a miss fails the build. If no certificate was
// configured, say so loudly but let the build stand — an unsigned build is a
// legitimate thing to want, just never by accident.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, lstatSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const { version, build } = { version: pkg.version, build: 'OpenDev IDE' };

const artifacts = [
  join(root, 'dist', 'win-unpacked', `${build}.exe`),
  join(root, 'dist', 'win-unpacked', 'resources', 'procmap.ps1'),
  join(root, 'dist', `${build}-${version}-x64.exe`),
  join(root, 'dist', `${build}-${version}-x64-portable.exe`)
];

const signingRequested = Boolean(process.env.CSC_LINK);

// One PowerShell call for the whole set; Get-AuthenticodeSignature is the only
// thing that reads an Authenticode signature properly (a .ps1 signature lives
// in a trailing comment block, not in a PE header, so file parsing won't do).
function signatures(paths) {
  const list = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
  const ps = `@(${list}) | ForEach-Object { $s = Get-AuthenticodeSignature $_; ` +
    `[pscustomobject]@{ path=$_; status=$s.Status.ToString(); ` +
    `subject=$(if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '' }) } } | ConvertTo-Json -Compress`;
  // Windows PowerShell 5.1 can't load its own Security module when it
  // inherits PowerShell 7's PSModulePath (as on GitHub's windows runners,
  // where npm runs under pwsh): Get-AuthenticodeSignature is then "not
  // found" and the JSON comes back empty. Drop the variable so 5.1 uses its
  // defaults.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'psmodulepath') delete env[k];
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    env
  });
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

const missing = artifacts.filter((p) => !existsSync(p));
if (missing.length > 0) {
  console.error('[verify] expected artifacts are missing:');
  for (const m of missing) console.error(`  - ${m}`);
  if (missing.some((m) => m.endsWith('procmap.ps1'))) {
    console.error('[verify] procmap.ps1 absent — check extraResources in electron-builder.yml');
  }
  process.exit(1);
}

// No macOS payload in a Windows build. A native module copied from a Mac's
// node_modules (or a darwin prebuild) would install fine and then fail at
// runtime — the Mac edition shipped exactly that the other way round in
// 0.7.20 (a Windows keytar.node). Check the unpacked app itself.
const MACHO = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe']);
function magic(file) {
  const fd = openSync(file, 'r');
  try { const b = Buffer.alloc(4); const n = readSync(fd, b, 0, 4, 0); return b.subarray(0, n); }
  finally { closeSync(fd); }
}
const leaks = [];
const unpackedDir = join(root, 'dist', 'win-unpacked');
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { walk(p); continue; }
    const rel = p.slice(unpackedDir.length + 1);
    if (/\.dylib$/i.test(name) || /[\\/]prebuilds[\\/]darwin-/i.test(p)) { leaks.push(`macOS file: ${rel}`); continue; }
    if (st.size < 4) continue;
    const m = magic(p);
    const hex = m.toString('hex');
    // cafebabe is also a Java class header; only count it for native-looking files.
    if (MACHO.has(hex) && (hex !== 'cafebabe' || /\.(node|dylib)$|^[^.]+$/.test(name))) leaks.push(`macOS (Mach-O) binary: ${rel}`);
    if (name.endsWith('.node') && m.subarray(0, 2).toString('latin1') !== 'MZ') leaks.push(`native module is not a Windows DLL: ${rel}`);
  }
})(unpackedDir);
if (leaks.length > 0) {
  console.error(`[verify] ${leaks.length} non-Windows file(s) in the Windows build:`);
  for (const l of leaks) console.error(`  - ${l}`);
  process.exit(1);
}
console.log('[verify] payload is Windows-only (no Mach-O binaries, every .node is a PE DLL)');

const results = signatures(artifacts);
let bad = 0;

console.log(`[verify] OpenDev IDE ${version} — ${artifacts.length} artifacts`);
for (const r of results) {
  const name = r.path.split(/[\\/]/).pop();
  const ok = r.status === 'Valid';
  if (!ok) bad += 1;
  const mark = ok ? 'OK  ' : 'FAIL';
  console.log(`  ${mark} ${name.padEnd(40)} ${r.status}${r.subject ? `  ${r.subject}` : ''}`);
}

if (!signingRequested) {
  console.log('');
  if (bad === 0) {
    // Run standalone against an already-signed dist. Saying "UNSIGNED" here
    // would contradict the four valid signatures just printed above it.
    console.log('[verify] CSC_LINK was not set for this run; the artifacts above are');
    console.log('[verify] already signed, so they came from an earlier signed build.');
    process.exit(0);
  }
  console.warn(`[verify] CSC_LINK was not set — ${bad} of ${artifacts.length} artifact(s) are unsigned.`);
  console.warn('[verify] To sign, DOT-SOURCE the env script (the leading dot is load-bearing):');
  console.warn('[verify]     . .\\scripts\\win-sign-env.ps1');
  console.warn('[verify]     npm run dist:win');
  process.exit(0);
}

if (bad > 0) {
  console.error('');
  console.error(`[verify] ${bad} artifact(s) are not validly signed although CSC_LINK was set.`);
  console.error('[verify] Refusing to pass a build that claims to be signed and is not.');
  process.exit(1);
}

console.log('');
console.log('[verify] all artifacts signed and valid.');
