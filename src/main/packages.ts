import { ipcMain } from 'electron';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { IPC } from '@shared/ipc';
import type { AddPackageArgs, AddPackageResult, DetectedProject } from '@shared/types';
import { safeSend } from './safeSend.js';
import { resolveBinPath } from './ai.js';
import { spawnBin } from './platform.js';

// Add a package/dependency to a Maven (Java) or .NET (C#) project, with
// live install output streamed to the renderer. Maven: edit pom.xml + run
// `mvn install`. .NET: shell out to `dotnet add package`, which edits the
// .csproj and restores in one step.

function logLine(line: string): void {
  safeSend(IPC.PackagesAddLog, line.endsWith('\n') ? line : line + '\n');
}

async function detectProject(dir: string): Promise<DetectedProject | null> {
  let entries: string[];
  try { entries = await fs.readdir(dir); } catch { return null; }
  if (entries.includes('pom.xml')) {
    return { type: 'maven', projectFile: join(dir, 'pom.xml'), label: 'Maven (pom.xml)' };
  }
  const csproj = entries.find((e) => e.toLowerCase().endsWith('.csproj'));
  if (csproj) {
    return { type: 'dotnet', projectFile: join(dir, csproj), label: csproj };
  }
  return null;
}

// Run a command, stream output via PackagesAddLog. Resolve with { code }.
function runStreamed(cmdName: string, args: string[], cwd: string): Promise<{ code: number | null }> {
  return new Promise((resolve) => {
    const resolved = resolveBinPath(cmdName);
    if (!resolved) {
      logLine(`[error] ${cmdName} not found on PATH — install it and try again.`);
      resolve({ code: -1 });
      return;
    }
    logLine(`$ ${cmdName} ${args.join(' ')}`);
    const proc = spawnBin(resolved, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    proc.stdout?.on('data', (b: Buffer) => logLine(b.toString('utf8')));
    proc.stderr?.on('data', (b: Buffer) => logLine(b.toString('utf8')));
    proc.on('error', (e) => { logLine(`[spawn error] ${e.message}`); resolve({ code: -1 }); });
    proc.on('exit', (code) => resolve({ code }));
  });
}

// Best-effort XML edit: append a <dependency> block before </dependencies>,
// or insert a <dependencies> block before </project> if there isn't one.
async function addMavenDependency(pomPath: string, groupId: string, artifactId: string, version?: string): Promise<void> {
  const xml = await fs.readFile(pomPath, 'utf8');
  // Skip if it's already there (best-effort exact match).
  const sigRe = new RegExp(`<groupId>\\s*${escapeRegex(groupId)}\\s*</groupId>\\s*<artifactId>\\s*${escapeRegex(artifactId)}\\s*</artifactId>`);
  if (sigRe.test(xml)) {
    logLine(`[skip] ${groupId}:${artifactId} is already a dependency.`);
    return;
  }
  const block = [
    '    <dependency>',
    `      <groupId>${groupId}</groupId>`,
    `      <artifactId>${artifactId}</artifactId>`,
    ...(version ? [`      <version>${version}</version>`] : []),
    '    </dependency>'
  ].join('\n');
  let next: string;
  if (xml.includes('</dependencies>')) {
    next = xml.replace('</dependencies>', `${block}\n  </dependencies>`);
  } else {
    next = xml.replace('</project>', `  <dependencies>\n${block}\n  </dependencies>\n</project>`);
  }
  if (next === xml) {
    throw new Error('Could not find </dependencies> or </project> in pom.xml.');
  }
  await fs.writeFile(pomPath, next, 'utf8');
  logLine(`Wrote ${groupId}:${artifactId}${version ? '@' + version : ''} to pom.xml.`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function addPackage(args: AddPackageArgs): Promise<AddPackageResult> {
  const det = await detectProject(args.projectDir);
  if (!det) return { ok: false, error: `No Maven or .NET project found in ${args.projectDir}.` };
  if (det.type !== args.type) return { ok: false, error: `Detected project type (${det.type}) doesn't match requested (${args.type}).` };

  if (det.type === 'dotnet') {
    // dotnet add package handles the .csproj edit + restore for us.
    const pkg = args.packageId.trim();
    if (!pkg) return { ok: false, error: 'Empty package name.' };
    const argv = ['add', det.projectFile, 'package', pkg];
    if (args.version) argv.push('--version', args.version.trim());
    const r = await runStreamed('dotnet', argv, args.projectDir);
    if (r.code !== 0) return { ok: false, error: `dotnet exited with code ${r.code}.` };
    return { ok: true };
  }

  // Maven. The packageId can carry the version: "g:a" or "g:a:v".
  const parts = args.packageId.split(':').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 3) {
    return { ok: false, error: 'Maven package must be "groupId:artifactId" or "groupId:artifactId:version".' };
  }
  const [groupId, artifactId, vFromId] = parts;
  const version = (args.version?.trim() || vFromId) || undefined;
  try {
    await addMavenDependency(det.projectFile, groupId, artifactId, version);
  } catch (err) {
    return { ok: false, error: `pom.xml edit failed: ${(err as Error).message}` };
  }
  // mvn install -DskipTests fetches the new dep + builds, equivalent of npm install.
  const r = await runStreamed('mvn', ['install', '-DskipTests'], args.projectDir);
  if (r.code !== 0) {
    return { ok: false, error: `mvn install exited with code ${r.code}. The pom.xml edit was applied; run \`mvn install -DskipTests\` to retry.` };
  }
  return { ok: true };
}

export function registerPackagesIpc(): void {
  ipcMain.handle(IPC.PackagesDetect, (_e, dir: string) => detectProject(dir));
  ipcMain.handle(IPC.PackagesAdd, (_e, args: AddPackageArgs) => addPackage(args));
}
