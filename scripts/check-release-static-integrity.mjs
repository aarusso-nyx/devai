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

const trackedFiles = (pathspecs) =>
  execFileSync('git', ['ls-files', '-z', ...pathspecs], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);

const tracked = trackedFiles([
  'packages/*/src/**',
  'packages/cli/resources/**',
  'packages/skills/resources/**',
  'law/policy/**',
  'law/schemas/**',
]);
// ADR-SEC-0001: the credential scan covers committed configuration outside
// packages and law too, so a token literal anywhere in configuration fails.
const configuration = trackedFiles([
  'config/**',
  '.devai/config/**',
  '.github/**',
  ':(glob)*.json',
  ':(glob)*.yaml',
  ':(glob)*.yml',
]).filter((path) => !tracked.includes(path));

// Token shapes shared with the tracking binding scan: private keys, GitHub
// classic and fine-grained tokens, and AWS access key ids.
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/u,
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

for (const path of configuration) {
  if (secretPatterns.some((pattern) => pattern.test(readFileSync(resolve(root, path), 'utf8')))) {
    fail('RELEASE_SECRET_SURFACE_DETECTED', path);
  }
}

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
  `${JSON.stringify({ exact_candidate: true, secret_scan: 'pass', path_portability: 'pass', files: tracked.length + configuration.length })}\n`,
);
