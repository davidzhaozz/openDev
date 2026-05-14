import type { AgentManifest } from '@shared/types';

// Built-in agents that ship with OpenDev IDE. Their entry-file source is
// inlined at build time via Vite's `?raw` import, so they need no separate
// bundling step and work identically in dev and packaged builds. At runtime
// AgentManager materializes them to disk so they run exactly like a
// user-authored agent (see agents.ts).
import securityScanSrc from './default-agents/security-scan/index.mjs?raw';
import codeQualitySrc from './default-agents/code-quality/index.mjs?raw';
import todoCollectorSrc from './default-agents/todo-collector/index.mjs?raw';
import designGallerySrc from './default-agents/design-gallery/index.mjs?raw';

export type BuiltinAgent = {
  manifest: AgentManifest;
  // The entry file's contents. Materialized to <appData>/openDev/builtin-agents/<slug>/.
  source: string;
};

function manifest(slug: string, name: string, description: string): AgentManifest {
  return {
    slug,
    name,
    description,
    entry: 'index.mjs',
    runtime: 'node',
    createdBy: 'builtin',
    createdAt: 0
  };
}

export const BUILTIN_AGENTS: BuiltinAgent[] = [
  {
    manifest: manifest(
      'security-scan',
      'Security Scan',
      'Scans the codebase for hardcoded secrets, private keys, and committed .env files.'
    ),
    source: securityScanSrc
  },
  {
    manifest: manifest(
      'code-quality',
      'Code Quality',
      'Runs ESLint (if installed) plus dependency-free metrics: file counts, LOC, TODO density.'
    ),
    source: codeQualitySrc
  },
  {
    manifest: manifest(
      'todo-collector',
      'TODO Collector',
      'Collects TODO / FIXME / HACK / XXX / BUG markers into a checklist of tasks.'
    ),
    source: todoCollectorSrc
  },
  {
    manifest: manifest(
      'design-gallery',
      'Design Gallery',
      'Surveys the project UI — renders every standalone HTML page in a live preview grid.'
    ),
    source: designGallerySrc
  }
];

export const BUILTIN_SLUGS = new Set(BUILTIN_AGENTS.map((a) => a.manifest.slug));
