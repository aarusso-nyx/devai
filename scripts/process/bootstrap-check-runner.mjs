#!/usr/bin/env node
// Compile the orchestration runtime outside publishable CLI output. In particular,
// bootstrapping must not contaminate a cached assembled package with raw TS output.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '../..');
const project = join(root, 'packages/cli/tsconfig.json');
const config = JSON.parse(readFileSync(project, 'utf8'));
const dependencies = config.references.map((reference) =>
  resolve(dirname(project), reference.path),
);
const output = join(root, '.devai/state/pr-bootstrap/cli');
mkdirSync(output, { recursive: true });
for (const args of [
  ['exec', 'tsc', '-b', ...dependencies, '--force'],
  [
    'exec',
    'tsc',
    '-p',
    project,
    '--outDir',
    output,
    '--tsBuildInfoFile',
    join(output, '../cli.tsbuildinfo'),
  ],
]) {
  const result = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const modules = join(output, 'node_modules');
const workspaceModules = join(root, 'packages/cli/node_modules');
if (existsSync(modules)) {
  if (realpathSync(modules) !== realpathSync(workspaceModules))
    throw new Error('BOOTSTRAP_MODULES_MISMATCH');
} else {
  symlinkSync(workspaceModules, modules, 'dir');
}

const metadata = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8'));
writeFileSync(
  join(output, '../package.json'),
  JSON.stringify({ ...metadata, imports: { '#runtime-core': './cli/runtime-core.js' } }),
);
const law = join(output, 'law');
if (existsSync(law)) {
  if (realpathSync(law) !== realpathSync(join(root, 'law')))
    throw new Error('BOOTSTRAP_LAW_MISMATCH');
} else symlinkSync(join(root, 'law'), law, 'dir');
