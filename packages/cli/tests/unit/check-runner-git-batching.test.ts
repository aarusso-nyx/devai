import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  fault: 'none' as
    'none' | 'size-truncated' | 'size-malformed' | 'content-truncated' | 'content-malformed',
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  return {
    ...actual,
    readCheckPolicyGitSync(
      repoRoot: string,
      args: readonly string[],
      input?: string | Buffer,
    ): Buffer {
      const output = actual.readCheckPolicyGitSync(repoRoot, args, input);
      const sizeRead = args.length === 2 && args[0] === 'cat-file' && args[1] === '--batch-check';
      const contentRead = args.length === 2 && args[0] === 'cat-file' && args[1] === '--batch';
      if (
        (sizeRead && boundary.fault === 'size-truncated') ||
        (contentRead && boundary.fault === 'content-truncated')
      ) {
        return output.subarray(0, Math.max(0, output.length - 1));
      }
      if (
        (sizeRead && boundary.fault === 'size-malformed') ||
        (contentRead && boundary.fault === 'content-malformed')
      ) {
        const malformed = Buffer.from(output);
        malformed[0] = malformed[0] === 0x61 ? 0x62 : 0x61;
        return malformed;
      }
      return output;
    },
  };
});

import { buildTaskPlan } from '../../src/services/check-runner/index.js';

const roots: string[] = [];

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-check-git-batch-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Batch Test']);
  git(root, ['config', 'user.email', 'batch@example.invalid']);
  writeFileSync(join(root, 'input.txt'), 'exact input\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

const descriptor = {
  schemaVersion: '1.0.0',
  descriptorVersion: 'batch-test-v1',
  repositoryId: 'example/batch-test',
  fallbackNodeId: null,
  dynamicFallbackSelectors: [],
  tasks: [
    {
      nodeId: 'test:rc',
      dependencies: [],
      argv: ['node', '-e', 'process.exit(0)'],
      cwd: '.',
      runner: 'node-v1',
      inputSelectors: [{ kind: 'glob', pattern: '**' }],
      toolchainKeys: ['node'],
      allowlistedEnv: [],
      outputContract: { kind: 'test', requiredResult: 'pass' },
    },
  ],
  profiles: [{ profileId: 'rc', mode: 'fixed', requiredNodes: ['test:rc'] }],
} as const;

function plan(root: string) {
  return buildTaskPlan({
    repoRoot: root,
    descriptor,
    target: 'rc',
    toolchain: { node: process.version },
    environment: {},
    resolveExecutable: () => ({ path: process.execPath, sha256: 'a'.repeat(64) }),
    cacheState: () => ({ cacheState: 'execute', reason: 'test' }),
  });
}

afterEach(() => {
  boundary.fault = 'none';
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true });
});

describe('bounded committed-snapshot Git reads', () => {
  it.each([
    ['size-truncated', 'CHECK_RUNNER_GIT: truncated cat-file size header'],
    ['size-malformed', 'CHECK_RUNNER_GIT: unexpected cat-file size header'],
    ['content-truncated', 'CHECK_RUNNER_GIT: truncated cat-file content'],
    ['content-malformed', 'CHECK_RUNNER_GIT: unexpected cat-file header'],
  ] as const)('fails closed for %s output', (fault, diagnostic) => {
    const root = repository();
    boundary.fault = fault;
    expect(() => plan(root)).toThrow(diagnostic);
  });

  it('accepts complete size and content batches', () => {
    const report = plan(repository());
    expect(report.clean).toBe(true);
    expect(report.tasks).toHaveLength(1);
    expect(report.tasks[0]?.inputPaths).toEqual(['input.txt']);
  });
});
