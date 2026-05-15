import { ipcMain, dialog } from 'electron';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { IPC } from '@shared/ipc';
import type { CreateProjectArgs, CreateProjectResult, ProjectTemplate } from '@shared/types';
import { safeSend } from './safeSend.js';
import { resolveBinPath } from './ai.js';

// New-project wizard. Two kinds of templates:
//   - 'inline'  → write a fixed set of files to disk (small starter projects).
//   - 'cli'     → shell out to a tool that scaffolds the project (npm create
//     vite, dotnet new …). Tool failures bubble up as clear errors.
// After scaffolding, an optional post-install step (`npm install`, `mvn
// install`, …) runs in the new folder so the project is ready to start.

type InlineFile = { path: string; content: string };

type TemplateDef = ProjectTemplate & (
  | { kind: 'inline'; files: (name: string) => InlineFile[]; postInstall?: string }
  | { kind: 'cli'; cli: (name: string, dir: string) => { cmd: string; args: string[]; cwd: 'parent' | 'project' }; postInstall?: string }
);

// ── Template content helpers (kept inline so we don't need a templates dir). ──

function nodePlainJs(name: string): InlineFile[] {
  return [
    { path: 'package.json', content: JSON.stringify({
      name, version: '0.1.0', private: true,
      type: 'module',
      scripts: { start: 'node index.js' }
    }, null, 2) + '\n' },
    { path: 'index.js', content: `console.log('Hello from ${name} (Node.js)');\n` },
    { path: '.gitignore', content: 'node_modules/\n' }
  ];
}

function nodePlainTs(name: string): InlineFile[] {
  return [
    { path: 'package.json', content: JSON.stringify({
      name, version: '0.1.0', private: true,
      type: 'module',
      scripts: { start: 'tsx index.ts', build: 'tsc -p .' },
      devDependencies: { tsx: '^4.19.0', typescript: '^5.6.0', '@types/node': '^22.0.0' }
    }, null, 2) + '\n' },
    { path: 'tsconfig.json', content: JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler',
        strict: true, esModuleInterop: true, skipLibCheck: true,
        outDir: 'dist'
      },
      include: ['*.ts', 'src/**/*.ts']
    }, null, 2) + '\n' },
    { path: 'index.ts', content: `console.log('Hello from ${name} (TypeScript)');\n` },
    { path: '.gitignore', content: 'node_modules/\ndist/\n' }
  ];
}

function nodeExpressJs(name: string): InlineFile[] {
  return [
    { path: 'package.json', content: JSON.stringify({
      name, version: '0.1.0', private: true,
      type: 'module',
      scripts: { start: 'node index.js', dev: 'node --watch index.js' },
      dependencies: { express: '^4.21.0' }
    }, null, 2) + '\n' },
    { path: 'index.js', content:
`import express from 'express';

const app = express();
const port = process.env.PORT ?? 3000;

app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ ok: true, app: '${name}' });
});

app.get('/healthz', (_req, res) => res.send('ok'));

app.listen(port, () => {
  console.log(\`${name} listening on :\${port}\`);
});
` },
    { path: '.gitignore', content: 'node_modules/\n' }
  ];
}

function nodeExpressTs(name: string): InlineFile[] {
  return [
    { path: 'package.json', content: JSON.stringify({
      name, version: '0.1.0', private: true,
      type: 'module',
      scripts: { start: 'tsx index.ts', dev: 'tsx --watch index.ts', build: 'tsc -p .' },
      dependencies: { express: '^4.21.0' },
      devDependencies: { tsx: '^4.19.0', typescript: '^5.6.0', '@types/express': '^5.0.0', '@types/node': '^22.0.0' }
    }, null, 2) + '\n' },
    { path: 'tsconfig.json', content: JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler',
        strict: true, esModuleInterop: true, skipLibCheck: true,
        outDir: 'dist'
      },
      include: ['*.ts', 'src/**/*.ts']
    }, null, 2) + '\n' },
    { path: 'index.ts', content:
`import express, { type Request, type Response } from 'express';

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(express.json());

app.get('/', (_req: Request, res: Response) => {
  res.json({ ok: true, app: '${name}' });
});

app.get('/healthz', (_req: Request, res: Response) => res.send('ok'));

app.listen(port, () => {
  console.log(\`${name} listening on :\${port}\`);
});
` },
    { path: '.gitignore', content: 'node_modules/\ndist/\n' }
  ];
}

function javaSpringBootMaven(name: string): InlineFile[] {
  // Best-effort sanitization: package names can't contain hyphens/uppercase.
  const pkg = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const className = name.replace(/[^A-Za-z0-9]/g, '').replace(/^[a-z]/, (c) => c.toUpperCase()) + 'Application';
  return [
    { path: 'pom.xml', content:
`<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>

  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.4</version>
    <relativePath/>
  </parent>

  <groupId>com.example.${pkg}</groupId>
  <artifactId>${name}</artifactId>
  <version>0.1.0</version>
  <name>${name}</name>

  <properties>
    <java.version>17</java.version>
  </properties>

  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
      </plugin>
    </plugins>
  </build>
</project>
` },
    { path: `src/main/java/com/example/${pkg}/${className}.java`, content:
`package com.example.${pkg};

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
@RestController
public class ${className} {
  public static void main(String[] args) {
    SpringApplication.run(${className}.class, args);
  }

  @GetMapping("/")
  public String home() {
    return "Hello from ${name} (Spring Boot)";
  }

  @GetMapping("/healthz")
  public String health() {
    return "ok";
  }
}
` },
    { path: 'src/main/resources/application.properties', content:
`server.port=8080
spring.application.name=${name}
` },
    { path: '.gitignore', content: 'target/\n.idea/\n*.iml\n' }
  ];
}

const TEMPLATES: TemplateDef[] = [
  {
    id: 'node-plain-js',
    language: 'JavaScript', framework: 'Plain (Node.js)',
    description: 'A minimal Node.js project with index.js and an npm start script.',
    postCreate: 'After install completes: `npm start`.',
    kind: 'inline', files: nodePlainJs, postInstall: 'npm install'
  },
  {
    id: 'node-express-js',
    language: 'JavaScript', framework: 'Express Web API',
    description: 'A minimal Express server (JS) with /, /healthz, and a dev script.',
    postCreate: 'After install completes: `npm run dev`.',
    kind: 'inline', files: nodeExpressJs, postInstall: 'npm install'
  },
  {
    id: 'node-plain-ts',
    language: 'TypeScript', framework: 'Plain (Node.js)',
    description: 'A minimal TypeScript Node project with tsx + tsc.',
    postCreate: 'After install completes: `npm start`.',
    kind: 'inline', files: nodePlainTs, postInstall: 'npm install'
  },
  {
    id: 'node-express-ts',
    language: 'TypeScript', framework: 'Express Web API',
    description: 'A minimal Express server (TypeScript) with tsx + tsc.',
    postCreate: 'After install completes: `npm run dev`.',
    kind: 'inline', files: nodeExpressTs, postInstall: 'npm install'
  },
  {
    id: 'react-vite',
    language: 'TypeScript', framework: 'React + Vite',
    description: 'A React + TypeScript single-page app scaffolded by `npm create vite`.',
    postCreate: 'After install completes: `npm run dev`.',
    requires: 'Requires `npm` on PATH.',
    kind: 'cli',
    cli: (name) => ({ cmd: 'npm', args: ['create', 'vite@latest', name, '--', '--template', 'react-ts'], cwd: 'parent' }),
    postInstall: 'npm install'
  },
  {
    id: 'java-spring-boot-maven',
    language: 'Java', framework: 'Spring Boot Web API (Maven)',
    description: 'A minimal Spring Boot 3 web service with one controller and two routes.',
    postCreate: 'After install completes: `mvn spring-boot:run`.',
    requires: 'Requires `mvn` on PATH (Maven 3.6+, JDK 17+).',
    // mvn install -DskipTests fetches all deps + builds, equivalent of npm install.
    kind: 'inline', files: javaSpringBootMaven, postInstall: 'mvn install -DskipTests'
  },
  {
    id: 'dotnet-webapi',
    language: 'C#', framework: 'ASP.NET Core Web API',
    description: 'A minimal ASP.NET Core Web API scaffolded by `dotnet new webapi`.',
    postCreate: 'Then: `dotnet run`.',
    requires: 'Requires the `dotnet` CLI on PATH.',
    kind: 'cli',
    // dotnet new restores by default, so no extra postInstall needed.
    cli: (name, dir) => ({ cmd: 'dotnet', args: ['new', 'webapi', '-n', name, '-o', join(dir, name)], cwd: 'parent' })
  },
  {
    id: 'dotnet-console',
    language: 'C#', framework: 'Console',
    description: 'A minimal C# console app scaffolded by `dotnet new console`.',
    postCreate: 'Then: `dotnet run`.',
    requires: 'Requires the `dotnet` CLI on PATH.',
    kind: 'cli',
    cli: (name, dir) => ({ cmd: 'dotnet', args: ['new', 'console', '-n', name, '-o', join(dir, name)], cwd: 'parent' })
  }
];

function publicTemplate(t: TemplateDef): ProjectTemplate {
  return {
    id: t.id,
    language: t.language,
    framework: t.framework,
    description: t.description,
    postCreate: t.postCreate,
    requires: t.requires
  };
}

function logLine(line: string): void {
  safeSend(IPC.ProjectsCreateLog, line.endsWith('\n') ? line : line + '\n');
}

function looksLikeName(name: string): boolean {
  return /^[a-zA-Z0-9._-]{1,64}$/.test(name);
}

// Run a command, stream stdout/stderr through ProjectsCreateLog, resolve
// with { code }. Used for both CLI scaffolds and post-install steps.
function runStreamed(cmdName: string, args: string[], cwd: string): Promise<{ code: number | null }> {
  return new Promise((resolveP) => {
    const resolved = resolveBinPath(cmdName);
    if (!resolved) {
      logLine(`[error] ${cmdName} not found on PATH — install it and try again.`);
      resolveP({ code: -1 });
      return;
    }
    logLine(`$ ${cmdName} ${args.join(' ')}`);
    const proc = spawn(resolved, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    proc.stdout?.on('data', (b: Buffer) => logLine(b.toString('utf8')));
    proc.stderr?.on('data', (b: Buffer) => logLine(b.toString('utf8')));
    proc.on('error', (err) => { logLine(`[spawn error] ${err.message}`); resolveP({ code: -1 }); });
    proc.on('exit', (code) => resolveP({ code }));
  });
}

async function createProject(args: CreateProjectArgs): Promise<CreateProjectResult> {
  const t = TEMPLATES.find((x) => x.id === args.templateId);
  if (!t) return { ok: false, error: `Unknown template: ${args.templateId}` };
  const name = args.projectName.trim();
  if (!looksLikeName(name)) {
    return { ok: false, error: 'Project name must be 1–64 chars: letters, digits, dot, underscore, hyphen.' };
  }
  const dest = args.destinationDir;
  try { await fs.access(dest); } catch { return { ok: false, error: `Destination folder does not exist: ${dest}` }; }
  const projectPath = join(dest, name);
  // Don't clobber an existing folder.
  try { await fs.access(projectPath); return { ok: false, error: `A folder named "${name}" already exists at the destination.` }; }
  catch { /* good */ }

  logLine(`Creating ${t.language} / ${t.framework} project "${name}" in ${dest}…`);

  if (t.kind === 'inline') {
    try {
      await fs.mkdir(projectPath, { recursive: true });
      for (const f of t.files(name)) {
        const abs = join(projectPath, f.path);
        await fs.mkdir(join(abs, '..'), { recursive: true });
        await fs.writeFile(abs, f.content, 'utf8');
        logLine(`  + ${f.path}`);
      }
    } catch (err) {
      return { ok: false, error: `Scaffold failed: ${(err as Error).message}` };
    }
  } else {
    // CLI scaffold. The CLI creates the project folder itself.
    const spec = t.cli(name, dest);
    const cwd = spec.cwd === 'parent' ? dest : projectPath;
    const r = await runStreamed(spec.cmd, spec.args, cwd);
    if (r.code !== 0) {
      return { ok: false, error: `${spec.cmd} exited with code ${r.code}.` };
    }
    try { await fs.access(projectPath); }
    catch { return { ok: false, error: `${spec.cmd} did not create "${projectPath}".` }; }
  }

  // Post-install (npm install / mvn install / etc). Critical for Java + .NET
  // so the project is actually ready to run, not just "files on disk".
  if (t.postInstall) {
    logLine('');
    logLine('Installing dependencies…');
    const parts = t.postInstall.split(/\s+/);
    const r = await runStreamed(parts[0], parts.slice(1), projectPath);
    if (r.code !== 0) {
      // Don't fail the create — files are already there, the user can re-run install.
      logLine(`[warn] dependency install failed (exit ${r.code}). The project files are in place; run \`${t.postInstall}\` in ${projectPath} to retry.`);
    } else {
      logLine('Dependencies installed.');
    }
  }

  logLine('');
  logLine(`✓ Project ready at ${projectPath}`);
  return { ok: true, projectPath };
}

export function registerProjectsIpc(): void {
  ipcMain.handle(IPC.ProjectsList, () => TEMPLATES.map(publicTemplate));
  ipcMain.handle(IPC.ProjectsCreate, (_e, args: CreateProjectArgs) => createProject(args));
  ipcMain.handle(IPC.ProjectsPickDir, async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose a destination folder for the new project'
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });
}
