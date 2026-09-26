import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTaskPlan,
  parseTaskDescriptor,
  taskDescriptorDigest,
} from '../../src/services/check-runner/index.js';
import { sha256Hex } from '../../src/services/check-runner/canonical.js';
// @ts-expect-error The package-owned verifier intentionally ships native ESM without declarations.
import { buildExpectedTaskPolicy } from '../../vendor/evidence-verification/src/policy-builder.js';

// An adopter may keep an optional, manual mutation node in test-tasks.json
// while no mandatory profile reaches it. The runner strips that node from
// selection, but the package-owned verifier reconstructs the RC policy from
// the committed descriptor bytes, so both must bind the authored descriptor.

const roots: string[] = [];

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

const authored = {
  schemaVersion: '1.0.0',
  descriptorVersion: 'parity-test-v1',
  repositoryId: 'example/rc-parity',
  fallbackNodeId: null,
  dynamicFallbackSelectors: [],
  tasks: [
    {
      nodeId: 'test:rc',
      dependencies: [],
      argv: ['node', '-e', 'process.exit(0)'],
      cwd: '.',
      runner: 'node-v1',
      inputSelectors: [{ kind: 'glob', pattern: 'src/**' }],
      toolchainKeys: ['node'],
      allowlistedEnv: ['CI'],
      outputContract: { kind: 'command', requiredResult: 'pass' },
    },
    {
      nodeId: 'test:mutation',
      dependencies: ['test:rc'],
      argv: ['pnpm', 'run', 'test:mutation'],
      cwd: '.',
      runner: 'node-v1',
      inputSelectors: [{ kind: 'glob', pattern: 'src/**' }],
      toolchainKeys: ['node'],
      allowlistedEnv: [],
      outputContract: { kind: 'command', requiredResult: 'pass' },
    },
  ],
  profiles: [{ profileId: 'rc', mode: 'fixed', requiredNodes: ['test:rc'] }],
};

function repository(): { root: string; commit: string; tree: string } {
  const root = mkdtempSync(join(tmpdir(), 'devai-rc-policy-parity-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Parity Test']);
  git(root, ['config', 'user.email', 'parity@example.invalid']);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'index.js'), 'export const value = 1;\n');
  writeFileSync(join(root, 'test-tasks.json'), `${JSON.stringify(authored, null, 2)}\n`);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return {
    root,
    commit: git(root, ['rev-parse', 'HEAD']),
    tree: git(root, ['rev-parse', 'HEAD^{tree}']),
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true });
});

describe('RC task policy parity with the package-owned verifier', () => {
  it('binds the authored descriptor digest while stripping mutation from selection', () => {
    const parsed = parseTaskDescriptor(structuredClone(authored));
    expect(parsed.tasks.map((task) => task.nodeId)).toEqual(['test:rc']);
    expect(taskDescriptorDigest(parsed)).toBe(sha256Hex(authored));
    expect(taskDescriptorDigest(parseTaskDescriptor(parsed))).toBe(sha256Hex(authored));
  });

  it('derives the exact RC task policy the verifier reconstructs from test-tasks.json', () => {
    const { root, commit, tree } = repository();
    const toolchain = { node: process.version };
    const plan = buildTaskPlan({
      repoRoot: root,
      descriptor: parseTaskDescriptor(structuredClone(authored)),
      target: 'rc',
      toolchain,
      environment: { CI: 'true' },
      cacheState: () => ({ cacheState: 'execute', reason: 'test' }),
    });
    const expected = buildExpectedTaskPolicy({
      repo: root,
      descriptor: structuredClone(authored),
      profileId: 'rc',
      candidateCommit: commit,
      expectedTree: tree,
      toolchain,
      environment: { CI: `sha256:${sha256Hex(Buffer.from('true', 'utf8'))}` },
      policySchemaVersion: '1.1.0',
    });

    expect(plan.descriptorDigest).toBe(sha256Hex(authored));
    expect(plan.taskPolicy.requiredNodes.map((node) => node.nodeId)).toEqual(['test:rc']);
    expect(plan.taskPolicy).toEqual(expected.taskPolicy);
    expect(plan.taskPolicyDigest).toBe(sha256Hex(expected.taskPolicy));
  });
});
