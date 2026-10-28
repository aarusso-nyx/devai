#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { invokeDevaiCli } from './cli-runtime.js';
import { withDevaiRcCertification } from './services/check-runner/certification-context.js';

const [repoRoot, controlPath] = process.argv.slice(2);
if (!repoRoot || !controlPath || process.argv.length !== 4) throw new Error('RC_HOST_USAGE');
// An operational boundary against accidentally certifying another checkout, not
// cryptographic provenance: the local checkout and its Git configuration are mutable.
try {
  const root = realpathSync(repoRoot);
  const expectedControl = join(root, 'scripts/process/release-prerequisites.mjs');
  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const manifest = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')) as {
    name?: unknown;
  };
  const descriptor = JSON.parse(readFileSync(join(root, 'test-tasks.json'), 'utf8')) as {
    repositoryId?: unknown;
    tasks?: { nodeId?: unknown }[];
  };
  if (
    realpathSync(process.cwd()) !== root ||
    realpathSync(gitRoot) !== root ||
    !lstatSync(expectedControl).isFile() ||
    realpathSync(controlPath) !== expectedControl ||
    manifest.name !== '@aarusso-nyx/devai' ||
    descriptor.repositoryId !== 'aarusso-nyx/devai' ||
    !Array.isArray(descriptor.tasks) ||
    descriptor.tasks.filter((task) => task?.nodeId === 'test:coverage:rc').length !== 1
  )
    throw new Error('invalid');
} catch {
  throw new Error('RC_HOST_SOURCE_SCOPE_INVALID');
}

const baseCache = join(realpathSync(repoRoot), '.devai/state/check-cache/v1');
if (existsSync(baseCache) && realpathSync(baseCache) !== baseCache)
  throw new Error('RC_HOST_CACHE_INVALID');
const cacheRoot = join(baseCache, `rc-certification-${randomUUID()}`);
if (existsSync(cacheRoot)) throw new Error('RC_HOST_CACHE_EXISTS');
const result = await withDevaiRcCertification(cacheRoot, () =>
  invokeDevaiCli([
    'check',
    '--rc',
    '--run',
    '--task-timeout-ms',
    '1800000',
    '--as-role',
    'inspector',
    '--write',
    '--format',
    'json',
    '--repo-root',
    repoRoot,
  ]),
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exit_code;
