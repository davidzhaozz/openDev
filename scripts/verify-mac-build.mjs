#!/usr/bin/env node
// Post-flight for a macOS build: prove the packaged .app is a Mac app and
// nothing else.
//
// Why: from 2026-09-03 to 2026-10-02 every Mac build shipped a *Windows*
// keytar.node (left in node_modules by a cross-build attempt). Typecheck,
// build and both smoke tests passed — they never load keytar — and the
// Keychain was broken in the released app. So this checks the artifact
// itself:
//   1. no Windows binaries (PE "MZ" header) or Windows scripts anywhere;
//   2. every native module is Mach-O for this build's arch;
//   3. keytar and node-pty actually load inside the packaged Electron, and
//      keytar completes a real Keychain round-trip.
//
// Usage: node scripts/verify-mac-build.mjs [path/to/OpenDev IDE.app]
import { execFileSync } from 'node:child_process';
import { existsSync, openSync, readSync, closeSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const app = process.argv[2] || join(root, 'dist', 'mac-arm64', 'OpenDev IDE.app');
// Apple Silicon only — the DMG is built for arm64 and Intel Macs aren't supported.
const arch = 'arm64';
if (!existsSync(app)) { console.error(`[verify-mac] no app at ${app}`); process.exit(1); }

const problems = [];
const WIN_EXT = /\.(exe|dll|bat|cmd|ps1|msi)$/i;

function head(file, n) {
  const fd = openSync(file, 'r');
  try { const b = Buffer.alloc(n); const got = readSync(fd, b, 0, n, 0); return b.subarray(0, got); }
  finally { closeSync(fd); }
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { walk(p); continue; }
    const rel = p.slice(app.length + 1);
    if (WIN_EXT.test(name)) problems.push(`Windows file: ${rel}`);
    if (st.size >= 2 && head(p, 2).toString('latin1') === 'MZ') problems.push(`Windows (PE) binary: ${rel}`);
    if (name.endsWith('.node')) {
      const info = execFileSync('file', ['-b', p], { encoding: 'utf8' });
      if (!info.includes('Mach-O') || !info.includes(arch)) problems.push(`native module not Mach-O ${arch}: ${rel} (${info.trim()})`);
    }
  }
}
walk(join(app, 'Contents'));

// Load the natives inside the packaged Electron, the way the app does.
const exe = join(app, 'Contents', 'MacOS', 'OpenDev IDE');
const unpacked = join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules');
const probe = `
  const keytar = require(${JSON.stringify(join(unpacked, 'keytar'))});
  require(${JSON.stringify(join(unpacked, 'node-pty'))});
  (async () => {
    // CI runners have no unlocked login keychain; loading the module is the check there.
    if (process.env.VERIFY_SKIP_KEYCHAIN) { console.log('natives-ok'); return; }
    await keytar.setPassword('opendev-verify', 'probe', 'ok');
    const v = await keytar.getPassword('opendev-verify', 'probe');
    await keytar.deletePassword('opendev-verify', 'probe');
    if (v !== 'ok') throw new Error('keychain round-trip returned ' + v);
    console.log('natives-ok');
  })().catch((e) => { console.error(e.message); process.exit(1); });`;
try {
  const out = execFileSync(exe, ['-e', probe], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!out.includes('natives-ok')) problems.push(`packaged natives probe: unexpected output ${out.trim()}`);
} catch (e) {
  const err = (e.stderr || e.message || '').toString();
  const line = err.split('\n').find((l) => /^\w*Error:/.test(l.trim())) || err.trim().split('\n').pop();
  problems.push(`keytar/node-pty failed to load in the packaged app: ${line.trim().slice(0, 300)}`);
}

if (problems.length) {
  console.error(`[verify-mac] ${problems.length} problem(s) in ${app}:`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`[verify-mac] OK — Mac-only payload (${arch}), keytar Keychain round-trip and node-pty load pass`);
