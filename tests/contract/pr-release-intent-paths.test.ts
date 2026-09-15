import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  buildTaskPlan,
  projectChangedPaths,
} from '../../packages/cli/src/services/check-runner/policy.js';
import type { TaskDescriptor } from '../../packages/cli/src/services/check-runner/types.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it('uses the runtime projection in the PR intent producer', () => {
  const script = readFileSync(resolve('scripts/run-pr-release-gate.mjs'), 'utf8');
  expect(script).toContain(
    "import { projectChangedPaths } from '../.devai/state/pr-bootstrap/cli/services/check-runner/policy.js'",
  );
  expect(script).toContain('return projectChangedPaths([...paths]);');
});

it('matches release planning for tracked record metadata and renames without hiding ordinary files', () => {
  const root = mkdtempSync(join(tmpdir(), 'devai-pr-paths-'));
  roots.push(root);
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  git(['init', '-q']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  put('before.ts', 'export const n = 1;\n');
  put('record/proofs/README.md', 'before\n');
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']);
  renameSync(join(root, 'before.ts'), join(root, 'after.ts'));
  put('record/proofs/README.md', 'after\n');
  put('record/derived/inventory/README.md', 'metadata\n');
  put('docs/release.md', 'ordinary documentation\n');
  git(['add', '.']);
  git(['commit', '-qm', 'candidate']);
  const commit = git(['rev-parse', 'HEAD']);
  const tree = git(['rev-parse', 'HEAD^{tree}']);
  // Bootstrap/evidence files cannot alter the exact candidate projection.
  put('.devai/state/pr-bootstrap/release-intent.json', '{}');
  put('scratch/check.json', '{}');
  const descriptor: TaskDescriptor = {
    schemaVersion: '1.0.0',
    descriptorVersion: 'fixture',
    repositoryId: 'fixture',
    fallbackNodeId: null,
    dynamicFallbackSelectors: [],
    profiles: [],
    tasks: [
      {
        nodeId: 'ordinary',
        dependencies: [],
        argv: ['node'],
        cwd: '.',
        runner: 'node',
        toolchainKeys: [],
        allowlistedEnv: [],
        inputSelectors: [],
        outputContract: { paths: [] },
      },
    ],
  };
  const plan = buildTaskPlan({
    repoRoot: root,
    descriptor,
    target: 'release',
    baseCommit: base,
    releaseCandidate: { commit, tree },
    releaseRequiredNodes: ['ordinary'],
    toolchain: {},
    environment: {},
    resolveExecutable: () => ({ path: process.execPath, sha256: 'a'.repeat(64) }),
    cacheState: () => ({ cacheState: 'execute', reason: 'fixture' }),
  });
  const declared = projectChangedPaths([
    'before.ts',
    'after.ts',
    'docs/release.md',
    'record/proofs/README.md',
    'record/derived/inventory/README.md',
  ]);
  expect(declared).toEqual(['after.ts', 'before.ts', 'docs/release.md']);
  expect(plan.changedPaths).toEqual(declared);
  expect(plan.clean).toBe(true);
  expect(plan.repository).toMatchObject({ commit, tree });
  put('ordinary-untracked.ts', 'changed');
  expect(() =>
    buildTaskPlan({
      repoRoot: root,
      descriptor,
      target: 'release',
      baseCommit: base,
      releaseCandidate: { commit, tree },
      releaseRequiredNodes: ['ordinary'],
      toolchain: {},
      environment: {},
      cacheState: () => ({ cacheState: 'execute', reason: 'fixture' }),
    }),
  ).toThrow('CHECK_RELEASE_CANDIDATE_WORKTREE_MISMATCH');
});

it('does not exclude similarly named product paths or ordinary documentation', () => {
  expect(
    projectChangedPaths([
      'record.ts',
      'records/a.ts',
      'scratchpad/a.ts',
      '.devai/config/a.json',
      'docs/record/a.md',
      'record/a',
      '.devai/state/a',
      'scratch/a',
    ]),
  ).toEqual([
    '.devai/config/a.json',
    'docs/record/a.md',
    'record.ts',
    'records/a.ts',
    'scratchpad/a.ts',
  ]);
});
