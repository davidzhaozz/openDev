#!/usr/bin/env node
// electron-builder afterPack hook: Authenticode-sign the PowerShell host script.
//
// electron-builder signs PE binaries (.exe/.dll/.node) on its own when
// CSC_LINK/CSC_KEY_PASSWORD are set, but it has no notion of signing a .ps1,
// and resources/procmap.ps1 is executed with -File by src/main/psHost.ts. An
// unsigned script still runs under this machine's RemoteSigned policy, but a
// signed one also survives AllSigned and a Mark-of-the-Web on the installed
// copy — and, more to the point, a script that carries the same signature as
// the app is one fewer thing for an EDR agent to treat as an anomaly.
//
// No-op on anything but Windows, and a no-op (with a warning) when no
// certificate is configured, so an unsigned build still succeeds.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT_NAME = 'procmap.ps1';

/** signtool ships inside electron-builder's winCodeSign cache; find the x64 one. */
function findSigntool() {
  const cache = join(
    process.env.LOCALAPPDATA || '',
    'electron-builder',
    'Cache',
    'winCodeSign'
  );
  if (!existsSync(cache)) return null;
  // Cache dirs are named by a build id; newest wins.
  const versions = readdirSync(cache).sort().reverse();
  for (const v of versions) {
    const candidate = join(cache, v, 'windows-10', 'x64', 'signtool.exe');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export default async function signPs1(context) {
  if (context.electronPlatformName !== 'win32') return;

  const target = join(context.appOutDir, 'resources', SCRIPT_NAME);
  if (!existsSync(target)) {
    console.warn(`[sign-ps1] ${SCRIPT_NAME} not found at ${target} — skipping`);
    return;
  }

  const pfx = process.env.CSC_LINK;
  const password = process.env.CSC_KEY_PASSWORD;
  if (!pfx || !existsSync(pfx)) {
    console.warn('[sign-ps1] CSC_LINK not set or missing — leaving script unsigned');
    return;
  }

  const signtool = findSigntool();
  if (!signtool) {
    console.warn('[sign-ps1] signtool.exe not found in the electron-builder cache — leaving script unsigned');
    return;
  }

  // RFC 3161 timestamping so the signature stays valid after the certificate
  // expires. Harmless for a self-signed cert, required for a purchased one.
  const args = [
    'sign',
    '/fd', 'SHA256',
    '/f', pfx,
    ...(password ? ['/p', password] : []),
    '/tr', 'http://timestamp.digicert.com',
    '/td', 'SHA256',
    target
  ];

  try {
    execFileSync(signtool, args, { stdio: 'pipe' });
    console.log(`[sign-ps1] signed ${SCRIPT_NAME}`);
  } catch (err) {
    // Do not fail the build: an unsigned script still runs under RemoteSigned.
    const detail = err?.stderr?.toString().trim() || err?.message || String(err);
    console.warn(`[sign-ps1] signing failed, leaving script unsigned: ${detail}`);
  }
}
