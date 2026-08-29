#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function fail(code, detail) {
  throw new Error(`${code}:${detail}`);
}

const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
  cwd: root,
  encoding: 'utf8',
});
const unexpected = status
  .split('\n')
  .filter(Boolean)
  .filter((line) => !line.slice(3).startsWith('.devai/state/'));
if (unexpected.length > 0) fail('RELEASE_CANDIDATE_NOT_CLEAN', unexpected[0].slice(0, 2));

const tracked = execFileSync(
  'git',
  [
    'ls-files',
    '-z',
    'packages/*/src/**',
    'packages/cli/resources/**',
    'packages/skills/resources/**',
    'law/policy/**',
    'law/schemas/**',
  ],
  { cwd: root, encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);

const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
];
const absolutePath = /(?:\/Users\/[^/\s]+\/|\/Volumes\/[^/\s]+\/|[A-Za-z]:\\Users\\)/u;
const legacyProvenanceComments = new Set([
  'law/schemas/api-map.schema.json',
  'law/schemas/coverage-matrix.schema.json',
  'law/schemas/dep-graph.schema.json',
  'law/schemas/module-blueprint.schema.json',
  'law/schemas/rbac-inventory.schema.json',
  'law/schemas/routes-inventory.schema.json',
]);

for (const path of tracked) {
  const source = readFileSync(resolve(root, path), 'utf8');
  if (secretPatterns.some((pattern) => pattern.test(source))) {
    fail('RELEASE_SECRET_SURFACE_DETECTED', path);
  }
  if (!legacyProvenanceComments.has(path) && absolutePath.test(source)) {
    fail('RELEASE_PATH_PORTABILITY_VIOLATION', path);
  }
}

execFileSync('git', ['diff', '--check', 'HEAD'], { cwd: root, stdio: 'inherit' });
process.stdout.write(
  `${JSON.stringify({ exact_candidate: true, secret_scan: 'pass', path_portability: 'pass', files: tracked.length })}\n`,
);
