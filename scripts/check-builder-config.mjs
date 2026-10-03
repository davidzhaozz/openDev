#!/usr/bin/env node
// Pre-flight for electron-builder.yml, run before a Windows build.
//
// Two things have gone wrong here before and both are cheap to catch:
//
//   1. A malformed file. electron-builder reports YAML errors clearly, but only
//      after electron-vite has already spent ~15s building — and the message
//      ("bad indentation of a mapping entry") points at the line AFTER the real
//      mistake, which was a top-level key indented into the middle of the
//      `files:` list.
//   2. A silently dropped key. Losing `extraResources` does not fail anything:
//      the build succeeds, procmap.ps1 never ships, and the process-table host
//      quietly falls back at runtime with the services panel going empty.
import { readFileSync } from 'node:fs';

// argv[2] lets the checks be run against a copy, which is how they are tested.
const path = process.argv[2] ?? new URL('../electron-builder.yml', import.meta.url);
const raw = readFileSync(path, 'utf8');

let config = null;
try {
  // js-yaml arrives with electron-builder. If that ever stops being true, fall
  // back to the string checks below rather than failing the build over a
  // missing dev-only parser.
  const { load } = await import('js-yaml');
  config = load(raw);
} catch (err) {
  if (err?.code === 'ERR_MODULE_NOT_FOUND') {
    console.warn('[config] js-yaml unavailable — structural check skipped');
  } else {
    console.error(`[config] electron-builder.yml is not valid YAML:\n  ${err.message}`);
    process.exit(1);
  }
}

const problems = [];

if (config) {
  // src/main/psHost.ts spawns `powershell -File <resourcesPath>/procmap.ps1`.
  const res = config.extraResources;
  const hasProcmap =
    Array.isArray(res) &&
    res.some((e) => (typeof e === 'string' ? e : e?.to) === 'procmap.ps1');
  if (!hasProcmap) {
    problems.push('extraResources is missing the procmap.ps1 entry — the PowerShell host will not ship');
  }

  if (config.afterPack !== 'scripts/sign-ps1.mjs') {
    problems.push('afterPack no longer points at scripts/sign-ps1.mjs — procmap.ps1 will ship unsigned');
  }

  // A top-level key indented into a list is the mistake that produced the
  // YAML error above; it parses as a string continuation rather than a key.
  if (!Array.isArray(config.files)) {
    problems.push('`files` did not parse as a list — check for a key indented into it');
  }
}

if (problems.length > 0) {
  console.error('[config] electron-builder.yml problems:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log('[config] electron-builder.yml OK');
