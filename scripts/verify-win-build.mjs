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
import { existsSync, readFileSync } from 'node:fs';
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
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
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
