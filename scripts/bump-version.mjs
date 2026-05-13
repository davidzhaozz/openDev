#!/usr/bin/env node
// Bump the patch version in package.json before each `npm run dist`.
// Each component caps at MAX_PATCH (25): when patch goes over, it rolls
// to 0 and the minor is bumped instead. Same rule cascades to major.
import { readFileSync, writeFileSync } from 'node:fs';

const MAX_PATCH = 25;
const path = new URL('../package.json', import.meta.url);
const pj = JSON.parse(readFileSync(path, 'utf8'));
const parts = (pj.version || '0.0.0').split('.').map(n => Number.parseInt(n, 10));
while (parts.length < 3) parts.push(0);

parts[2] = (parts[2] || 0) + 1;
if (parts[2] > MAX_PATCH) {
  parts[2] = 0;
  parts[1] = (parts[1] || 0) + 1;
  if (parts[1] > MAX_PATCH) {
    parts[1] = 0;
    parts[0] = (parts[0] || 0) + 1;
  }
}
const next = parts.join('.');
pj.version = next;
writeFileSync(path, JSON.stringify(pj, null, 2) + '\n');
console.log(`[version] bumped to ${next}`);
