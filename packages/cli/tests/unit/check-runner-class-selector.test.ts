// ADR-GOV-0017, Inspector Adversarial Acceptance IA-003: a node that selects
// by change class is planned only for paths the change-taxonomy binding
// assigns to that class; a path no binding covers still widens to the declared
// fallback; and a plan-class-only change plans no node that executes package
// code (vitest, coverage, or the build script).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTaskPlan } from '../../src/services/check-runner/policy.js';
import type { TaskDescriptor } from '../../src/services/check-runner/types.js';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../../..');
const TAXONOMY_FILES = [
  'law/policy/change-taxonomy.json',
  '.devai/config/change-taxonomy.json',
  '.devai/config/change-taxonomy-binding.json',
] as const;
const PLAN_PATH = 'product/campaigns/CMP-9999-fixture/campaign.json';
const CODE_PATH = 'packages/cli/src/services/fixture.ts';
const UNBOUND_PATH = 'notes/unbound.txt';
const CODE_RUNNERS = new Set(['vitest-v1', 'vitest-coverage-v1']);

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

let invocationOrdinal = 0;
function withRunnerScope<T>(callback: () => T): T {
  invocationOrdinal += 1;
  const invocationId = `check-runner-class-selector-test-${String(invocationOrdinal)}`;
  let receiptOrdinal = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'check-runner-class-selector-test',
    issuer_version: '1.0.0',
    invocation_id: invocationId,
    canonicalSha256: () => 'c'.repeat(64),
    randomId: () => `${invocationId}-${String(++receiptOrdinal)}`,
    now: () => '2026-09-26T00:00:00.000Z',
    receipt_ttl_ms: 30_000,
  });
  const scope: AuthorityHostEffectScope = {
    action_id: 'check',
    invocation_id: invocationId,
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (_request, apply) => apply(),
  };
  try {
    return runWithAuthorityHostEffects(scope, callback);
  } finally {
    issuer.dispose();
  }
}

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, 'utf8');
}

function initRepo(): Readonly<{ root: string; base: string }> {
  const root = mkdtempSync(join(tmpdir(), 'devai-class-selector-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  for (const path of TAXONOMY_FILES) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(REPOSITORY_ROOT, path), join(root, path));
  }
  put(root, '.gitignore', '.devai/state/\n');
  put(root, PLAN_PATH, '{"id":"CMP-9999"}\n');
  put(root, CODE_PATH, 'export const value = 1;\n');
  put(root, UNBOUND_PATH, 'unbound\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  return { root, base: git(root, ['rev-parse', 'HEAD']) };
}

function change(root: string, path: string): void {
  put(root, path, `changed ${path}\n`);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', `change ${path}`]);
}

function node(
  nodeId: string,
  runner: string,
  argv: readonly string[],
  inputSelectors: readonly Readonly<{ kind: string; pattern: string }>[],
  dependencies: readonly string[] = [],
) {
  return {
    nodeId,
    dependencies,
    argv,
    cwd: '.',
    runner,
    inputSelectors,
    toolchainKeys: ['node'],
    allowlistedEnv: [],
    outputContract: { kind: 'marker', value: nodeId },
  };
}

// The class selector kind is declared in law/schemas/test-task-descriptor.schema.json
// but not yet in the InputSelector type, so the fixture is built untyped and cast.
function descriptorFixture(): TaskDescriptor {
  const packages = [{ kind: 'prefix', pattern: 'packages/' }];
  const descriptor = {
    schemaVersion: '1.0.0',
    descriptorVersion: 'class-selector-fixture',
    repositoryId: 'fixture/repo',
    fallbackNodeId: 'test:local-full',
    dynamicFallbackSelectors: [],
    tasks: [
      node('plan:validate', 'node-v1', ['node', '-e', '0'], [{ kind: 'class', pattern: 'plan' }]),
      node('build', 'pnpm-script-v1', ['pnpm', 'run', 'build'], packages),
      node('test:unit', 'vitest-v1', ['pnpm', 'vitest', 'run'], packages, ['build']),
      node(
        'test:coverage',
        'vitest-coverage-v1',
        ['pnpm', 'vitest', 'run', '--coverage'],
        packages,
        ['build'],
      ),
      node(
        'test:local-full',
        'node-v1',
        ['node', '-e', '0'],
        [{ kind: 'glob', pattern: '**' }],
        ['build', 'test:unit', 'test:coverage'],
      ),
    ],
    profiles: [
      {
        profileId: 'affected',
        mode: 'affected',
        requiredNodes: [],
        eligibleNodes: ['plan:validate', 'build', 'test:unit', 'test:coverage', 'test:local-full'],
      },
    ],
  };
  return descriptor as unknown as TaskDescriptor;
}

function plannedNodes(root: string, base: string): readonly string[] {
  const plan = withRunnerScope(() =>
    buildTaskPlan({
      repoRoot: root,
      descriptor: descriptorFixture(),
      target: 'affected',
      baseCommit: base,
      toolchain: { node: 'v-test' },
      environment: {},
      resolveExecutable: () => ({ path: process.execPath, sha256: 'a'.repeat(64) }),
      cacheState: () => ({ cacheState: 'execute' as const, reason: 'fixture' }),
    }),
  );
  return plan.tasks.map((task) => task.nodeId);
}

function runnerOf(nodeId: string): string {
  const task = descriptorFixture().tasks.find((entry) => entry.nodeId === nodeId);
  if (task === undefined) throw new Error(`CLASS_SELECTOR_TEST: unknown node ${nodeId}`);
  return task.runner;
}

describe('check-runner class selector (ADR-GOV-0017)', () => {
  it('selects the class node and not the code node for a changed plan path', () => {
    const { root, base } = initRepo();
    change(root, PLAN_PATH);
    const nodes = plannedNodes(root, base);
    expect(nodes).toContain('plan:validate');
    expect(nodes).not.toContain('test:unit');
    expect(nodes).not.toContain('test:local-full');
  });

  it('selects the code node and not the class node for a changed code path', () => {
    const { root, base } = initRepo();
    change(root, CODE_PATH);
    const nodes = plannedNodes(root, base);
    expect(nodes).toContain('test:unit');
    expect(nodes).not.toContain('plan:validate');
  });

  it('widens a changed path bound to no class to the fallback node', () => {
    const { root, base } = initRepo();
    change(root, UNBOUND_PATH);
    const nodes = plannedNodes(root, base);
    expect(nodes).toContain('test:local-full');
    expect(nodes).not.toContain('plan:validate');
  });

  it('plans no vitest, coverage, or build node for a plan-only change', () => {
    const { root, base } = initRepo();
    change(root, PLAN_PATH);
    const codeNodes = plannedNodes(root, base).filter((nodeId) => {
      const runner = runnerOf(nodeId);
      return CODE_RUNNERS.has(runner) || (runner === 'pnpm-script-v1' && nodeId === 'build');
    });
    expect(codeNodes).toEqual([]);
  });
});
