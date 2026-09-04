// node-pty ships a small `spawn-helper` binary next to its prebuilt .node
// files. Some npm/tarball combinations drop the executable bit on extraction,
// and the only symptom is every terminal failing to open with
// "posix_spawnp failed". Restore it after install.
import { chmodSync, existsSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const prebuilds = join(root, 'node_modules', 'node-pty', 'prebuilds');

try {
  if (existsSync(prebuilds)) {
    for (const platform of readdirSync(prebuilds)) {
      const helper = join(prebuilds, platform, 'spawn-helper');
      if (!existsSync(helper)) continue;
      if (statSync(helper).mode & 0o111) continue;
      chmodSync(helper, 0o755);
      console.log(`[postinstall] chmod +x ${helper.slice(root.length + 1)}`);
    }
  }
} catch (err) {
  // Never fail an install over this — the terminal degrades to the
  // child_process fallback in src/main/term.ts.
  console.warn('[postinstall] could not fix node-pty permissions:', err.message);
}
