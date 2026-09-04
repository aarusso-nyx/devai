import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
  type AuthorityHostEffectRequest,
} from '@devai-nyx/authority';
import { afterEach, describe, expect, it } from 'vitest';
import { invocationIsNonMutating } from '../../src/command-router.js';
import {
  buildTaskPlan,
  bindReleaseTaskProcessOptions,
  describeDeclaredCheckTaskRefusal,
  matchDeclaredCheckTaskProcess,
  matchDeclaredReleaseTaskProcess,
  readTaskDescriptor,
  runCheckTasks,
  sha256Hex,
  type CheckRunnerOptions,
  type TaskExecutionResult,
} from '../../src/services/check-runner/index.js';
import { readProtectedCompletedTaskResults } from '../../src/services/check-runner/runner.js';
import { resolveTaskExecutable } from '../../src/services/check-runner/executable.js';
import { createSelfContainedRepositoryFixture } from '../helpers/self-contained-repository-fixture.js';

const roots: string[] = [];
const sourceFixtures: Array<ReturnType<typeof createSelfContainedRepositoryFixture>> = [];
const TOOLCHAIN = { node: 'v-test' } as const;
const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../../..');
const PASS: TaskExecutionResult = {
  status: 0,
  signal: null,
  stdout: 'ok\n',
  stderr: '',
};
let invocationOrdinal = 0;

function withRunnerScope<T>(callback: () => T): T {
  invocationOrdinal += 1;
  const invocationId = `check-runner-test-${String(invocationOrdinal)}`;
  let receiptOrdinal = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'check-runner-test',
    issuer_version: '1.0.0',
    invocation_id: invocationId,
    canonicalSha256: () => 'c'.repeat(64),
    randomId: () => `${invocationId}-${String(++receiptOrdinal)}`,
    now: () => '2026-08-10T00:00:00.000Z',
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
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(String(result.stderr));
  return String(result.stdout).trim();
}

function file(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function descriptor() {
  return {
    schemaVersion: '1.0.0',
    descriptorVersion: 'test-v1',
    repositoryId: 'example/repo',
    fallbackNodeId: 'test:local-full',
    dynamicFallbackSelectors: [{ kind: 'prefix', pattern: 'scripts/dynamic/' }],
    tasks: [
      {
        nodeId: 'generate',
        dependencies: [],
        argv: ['node', '-e', 'process.stdout.write("generated")'],
        cwd: '.',
        runner: 'node-v1',
        inputSelectors: [
          { kind: 'exact', pattern: 'config.json' },
          { kind: 'exact', pattern: 'lock.yaml' },
        ],
        toolchainKeys: ['node'],
        allowlistedEnv: [],
        outputContract: { kind: 'tracked-files', paths: ['generated.txt'] },
      },
      {
        nodeId: 'test:unit',
        dependencies: ['generate'],
        argv: ['node', '-e', 'process.stdout.write("unit")'],
        cwd: '.',
        runner: 'node-v1',
        inputSelectors: [
          { kind: 'prefix', pattern: 'src/' },
          { kind: 'prefix', pattern: 'tests/' },
          { kind: 'exact', pattern: 'helpers.ts' },
          { kind: 'exact', pattern: 'config.json' },
          { kind: 'exact', pattern: 'lock.yaml' },
        ],
        toolchainKeys: ['node'],
        allowlistedEnv: [],
        outputContract: { kind: 'test', requiredResult: 'pass' },
      },
      {
        nodeId: 'test:local-full',
        dependencies: ['test:unit'],
        argv: ['node', '-e', "process.stdout.write('local test dependency closure complete\\n')"],
        cwd: '.',
        runner: 'node-v1',
        inputSelectors: [{ kind: 'glob', pattern: '**' }],
        toolchainKeys: ['node'],
        allowlistedEnv: [],
        outputContract: { kind: 'marker', value: 'local' },
      },
      {
        nodeId: 'test:rc',
        dependencies: ['test:unit'],
        argv: ['node', '-e', 'process.stdout.write("rc")'],
        cwd: '.',
        runner: 'node-v1',
        inputSelectors: [{ kind: 'prefix', pattern: 'src/' }],
        toolchainKeys: ['node'],
        allowlistedEnv: [],
        outputContract: { kind: 'test', requiredResult: 'pass' },
      },
    ],
    profiles: [
      {
        profileId: 'affected',
        mode: 'affected',
        requiredNodes: ['generate'],
        eligibleNodes: ['generate', 'test:unit', 'test:local-full'],
      },
      { profileId: 'rc', mode: 'fixed', requiredNodes: ['test:rc'] },
    ],
  } as const;
}

function releaseProfile() {
  const capabilities = [
    'formatting-hygiene',
    'lint',
    'type-integrity',
    'schema-consistency',
    'secret-scan',
    'path-portability',
    'package-integrity',
    'exact-candidate',
    'affected-checks',
    'dependent-checks',
    'build-integrity',
  ];
  return {
    schemaVersion: '1.0.0',
    policy_id: 'example.release',
    policy_version: '1.0.0',
    release_unit: 'example/repo',
    version_source: 'package.json',
    default_support: 'current',
    capability_tasks: Object.fromEntries(
      capabilities.map((capability) => [capability, ['test:unit']]),
    ),
    risk_capabilities: {},
    mutation_roster: [],
  } as const;
}

function repository(): Readonly<{ root: string; base: string }> {
  const root = mkdtempSync(join(tmpdir(), 'devai-check-runner-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Runner Test']);
  git(root, ['config', 'user.email', 'runner@example.invalid']);
  file(root, '.gitignore', '.devai/state/*\n');
  file(root, 'package.json', '{"name":"example-repo","version":"1.0.0"}\n');
  file(root, 'test-tasks.json', `${JSON.stringify(descriptor(), null, 2)}\n`);
  file(root, 'src/app.ts', 'export const value = 1;\n');
  file(root, 'tests/app.test.ts', 'test(value);\n');
  file(root, 'helpers.ts', 'export const helper = true;\n');
  file(root, 'config.json', '{"enabled":true}\n');
  file(root, 'lock.yaml', 'version: 1\n');
  file(root, 'generated.txt', 'generated\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  return { root, base: git(root, ['rev-parse', 'HEAD']) };
}

function commitRelease(root: string, path: string, content: string, version = '1.0.1'): string {
  file(root, path, content);
  file(root, 'package.json', `${JSON.stringify({ name: 'example-repo', version })}\n`);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', `release ${version}`]);
  return git(root, ['rev-parse', 'HEAD']);
}

function commit(root: string, path: string, content: string): string {
  file(root, path, content);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', `change ${path}`]);
  return git(root, ['rev-parse', 'HEAD']);
}

function plan(root: string, target: 'affected' | 'local' | 'rc', baseCommit?: string) {
  const cacheResults = new Map<string, string>();
  return withRunnerScope(() =>
    buildTaskPlan({
      repoRoot: root,
      descriptor: readTaskDescriptor(join(root, 'test-tasks.json')),
      target,
      ...(baseCommit !== undefined && { baseCommit }),
      toolchain: TOOLCHAIN,
      environment: {},
      cacheState(task) {
        const dependenciesReady = task.dependencies.every((dependency) =>
          cacheResults.has(dependency),
        );
        return {
          cacheState: dependenciesReady ? ('execute' as const) : ('execute' as const),
          reason: dependenciesReady ? 'cache-miss' : 'dependency-not-reusable',
        };
      },
    }),
  );
}

function run(root: string, overrides: Partial<CheckRunnerOptions> = {}) {
  return withRunnerScope(() =>
    runCheckTasks({
      repoRoot: root,
      target: 'local',
      operation: 'run',
      toolchain: TOOLCHAIN,
      environment: {},
      executeTask: () => PASS,
      now: () => '2026-08-10T00:00:00.000Z',
      ...overrides,
    }),
  );
}

afterEach(() => {
  for (const fixture of sourceFixtures.splice(0)) fixture.cleanup();
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true });
});

describe('content-addressed check runner', () => {
  it('snapshots a Git-free source without traversing excluded directories or directory symlinks', () => {
    const parent = mkdtempSync(join(tmpdir(), 'devai git-free source ç-'));
    roots.push(parent);
    const source = join(parent, 'source');
    const outside = join(parent, 'outside');
    file(
      source,
      '.gitignore',
      'dist/\n.devai/state/*\n!.devai/state/.gitkeep\nscratch/*\n!scratch/README.md\n',
    );
    file(source, '.devai/state/.gitkeep', 'state placeholder\n');
    file(source, '.devai/worktrees/.gitkeep', 'worktree placeholder\n');
    file(source, 'scratch/README.md', 'scratch placeholder\n');
    file(source, 'src/app.ts', 'export const value = 1;\n');
    for (const path of [
      'tmp/never.ts',
      '.devai/worktrees/never/secret.ts',
      'node_modules/never.ts',
      'dist/never.ts',
      '.devai/state/never.ts',
      'scratch/never.ts',
    ])
      file(source, path, 'must not enter snapshot\n');
    file(outside, 'never.ts', 'do not follow directory symlinks\n');
    symlinkSync(outside, join(source, 'linked'));
    const fixture = createSelfContainedRepositoryFixture(source);
    sourceFixtures.push(fixture);
    expect(fixture.paths).toEqual([
      '.devai/state/.gitkeep',
      '.devai/worktrees/.gitkeep',
      '.gitignore',
      'linked',
      'scratch/README.md',
      'src/app.ts',
    ]);
    expect(readFileSync(join(fixture.root, 'src/app.ts'))).toEqual(
      readFileSync(join(source, 'src/app.ts')),
    );
    expect(readFileSync(join(fixture.root, '.devai/worktrees/.gitkeep'), 'utf8')).toBe(
      'worktree placeholder\n',
    );
    expect(readlinkSync(join(fixture.root, 'linked'))).toBe(outside);
    expect(fixture.git(['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(fixture.git(['remote'])).toBe('');
    expect(fixture.git(['status', '--porcelain'])).toBe('');
  });

  it('refuses a full source snapshot when the exact worktree placeholder is absent', () => {
    const source = mkdtempSync(join(tmpdir(), 'devai missing placeholder ç-'));
    roots.push(source);
    file(source, 'src/app.ts', 'export const value = 1;\n');
    expect(() => createSelfContainedRepositoryFixture(source)).toThrow();
  });

  it('runs the documented pnpm test descriptor shape in a fresh repository', () => {
    const state = repository();
    file(
      state.root,
      'package.json',
      `${JSON.stringify({
        name: 'documented-example',
        private: true,
        scripts: { test: `node -e "process.stdout.write('docs example pass\\\\n')"` },
      })}\n`,
    );
    const documentation = readFileSync(
      join(REPOSITORY_ROOT, 'docs/adopters/test-tasks.md'),
      'utf8',
    );
    const documented = /Minimal example:\n\n```json\n([\s\S]*?)\n```/u.exec(documentation)?.[1];
    if (documented === undefined) throw new Error('documented descriptor example missing');
    file(state.root, 'test-tasks.json', `${documented}\n`);
    git(state.root, ['add', '.']);
    git(state.root, ['commit', '-qm', 'documented example']);
    const report = run(state.root, {
      target: 'rc',
      toolchain: { node: process.version, pnpm: 'acceptance' },
      executeTask: undefined,
    });
    expect(report.exitCode).toBe(0);
    expect(report.execution).toMatchObject([{ nodeId: 'test:project', outcome: 'PASS' }]);
  });

  it('derives mutation outputs from the exact workspace roster', () => {
    const state = repository();
    file(
      state.root,
      'tools/repo-config/test-policy.json',
      `${JSON.stringify({
        policies: { mutation: { tier3: { break: 90, high: 100, low: 90 } } },
        defaults: { mutation: 'tier3' },
      })}\n`,
    );
    file(
      state.root,
      'packages/core/package.json',
      `${JSON.stringify({ name: '@stynx/core', scripts: { stryker: 'stryker run' } })}\n`,
    );
    file(state.root, 'packages/core/stryker.conf.mjs', 'export default { threshold: 70 };\n');
    git(state.root, ['add', '.']);
    git(state.root, ['commit', '-qm', 'add mutation package']);
    const mutationDescriptor = {
      schemaVersion: '1.0.0',
      descriptorVersion: 'mutation-v1',
      repositoryId: 'example/repo',
      fallbackNodeId: null,
      dynamicFallbackSelectors: [],
      tasks: [
        {
          nodeId: 'test:mutation',
          dependencies: [],
          argv: ['pnpm', 'test:mutation'],
          cwd: '.',
          runner: 'stryker-v1',
          inputSelectors: [{ kind: 'prefix', pattern: 'packages/' }],
          toolchainKeys: ['node'],
          allowlistedEnv: [],
          outputContract: {
            kind: 'mutation-report-set-discovery-v1',
            workspaceRoots: ['packages'],
            testPolicyPath: 'tools/repo-config/test-policy.json',
            artifactRoot: '.devai/state/check-cache/v1/artifacts/mutation',
            summaryPath: '.devai/state/check-cache/v1/artifacts/mutation/summary.json',
          },
        },
      ],
      profiles: [{ profileId: 'rc', mode: 'fixed', requiredNodes: ['test:mutation'] }],
    } as const;
    const report = withRunnerScope(() =>
      buildTaskPlan({
        repoRoot: state.root,
        descriptor: mutationDescriptor,
        target: 'rc',
        toolchain: TOOLCHAIN,
        environment: {},
        cacheState: () => ({ cacheState: 'execute', reason: 'test' }),
      }),
    );
    expect(report.tasks[0]?.outputContract).toMatchObject({
      kind: 'mutation-report-set-v1',
      expectedPackageCount: 1,
      packages: [
        {
          packageName: '@stynx/core',
          workspace: 'packages/core',
          thresholds: { break: 70, high: 70, low: 60 },
        },
      ],
    });
  });

  it('binds environment identities without exposing local values', () => {
    const state = repository();
    const declared = readTaskDescriptor(join(state.root, 'test-tasks.json'));
    const secret = 'database-password-that-must-not-enter-evidence';
    const mutated = structuredClone(declared) as unknown as {
      tasks: Array<{ nodeId: string; allowlistedEnv: string[] }>;
    };
    const mutableRc = mutated.tasks.find((task) => task.nodeId === 'test:rc');
    if (mutableRc === undefined) throw new Error('test fixture is missing mutable test:rc');
    mutableRc.allowlistedEnv.push('DATABASE_PASSWORD');
    const report = withRunnerScope(() =>
      buildTaskPlan({
        repoRoot: state.root,
        descriptor: mutated as unknown as ReturnType<typeof readTaskDescriptor>,
        target: 'rc',
        toolchain: TOOLCHAIN,
        environment: { DATABASE_PASSWORD: secret },
        cacheState: () => ({ cacheState: 'execute', reason: 'test' }),
      }),
    );
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(secret);
    const changed = withRunnerScope(() =>
      buildTaskPlan({
        repoRoot: state.root,
        descriptor: mutated as unknown as ReturnType<typeof readTaskDescriptor>,
        target: 'rc',
        toolchain: TOOLCHAIN,
        environment: { DATABASE_PASSWORD: `${secret}-changed` },
        cacheState: () => ({ cacheState: 'execute', reason: 'test' }),
      }),
    );
    expect(changed.tasks.at(-1)?.taskKey).not.toBe(report.tasks.at(-1)?.taskKey);
    expect(JSON.stringify(changed)).not.toContain(`${secret}-changed`);
  });

  it('delivers only each task own allowlisted environment at runtime', () => {
    const state = repository();
    const environmentKey = 'DEVAI_CHECK_RUNNER_SECRET_FIXTURE';
    const secret = 'task-scoped-secret-value';
    const declared = JSON.parse(readFileSync(join(state.root, 'test-tasks.json'), 'utf8')) as {
      tasks: Array<{
        nodeId: string;
        argv: string[];
        allowlistedEnv: string[];
      }>;
    };
    const unit = declared.tasks.find((task) => task.nodeId === 'test:unit');
    const rc = declared.tasks.find((task) => task.nodeId === 'test:rc');
    if (unit === undefined || rc === undefined) throw new Error('test fixture tasks are missing');
    unit.allowlistedEnv = [environmentKey];
    rc.allowlistedEnv = [];
    file(state.root, 'test-tasks.json', `${JSON.stringify(declared, null, 2)}\n`);

    const observed = new Map<string, Readonly<Record<string, string>>>();
    const first = run(state.root, {
      target: 'rc',
      environment: { [environmentKey]: secret, UNDECLARED_SECRET: 'never-selected' },
      executeTask: (argv, _cwd, _timeoutMs, environment) => {
        observed.set(argv.join(' '), environment);
        return PASS;
      },
    });

    expect(first.exitCode).toBe(0);
    expect([...observed.values()]).toContainEqual({ [environmentKey]: secret });
    expect([...observed.values()].filter((value) => environmentKey in value)).toHaveLength(1);
    expect([...observed.values()].every((value) => !('UNDECLARED_SECRET' in value))).toBe(true);
    expect(JSON.stringify(first)).not.toContain(secret);
    expect(JSON.stringify(first)).not.toContain('never-selected');

    const changed = run(state.root, {
      target: 'rc',
      operation: 'plan',
      cacheRoot: join(state.root, '.devai/state/changed-environment-cache'),
      environment: { [environmentKey]: `${secret}-changed` },
    });
    const firstById = new Map(first.plan.tasks.map((task) => [task.nodeId, task.taskKey]));
    const changedById = new Map(changed.plan.tasks.map((task) => [task.nodeId, task.taskKey]));
    expect(changedById.get('test:unit')).not.toBe(firstById.get('test:unit'));
    expect(changedById.get('test:rc')).not.toBe(firstById.get('test:rc'));
    expect(changedById.get('generate')).toBe(firstById.get('generate'));
  });

  it('does not expose a sibling task credential through the default process runner', () => {
    const state = repository();
    const environmentKey = 'DEVAI_CHECK_RUNNER_SECRET_FIXTURE';
    const secret = 'sibling-only-secret';
    const declared = JSON.parse(readFileSync(join(state.root, 'test-tasks.json'), 'utf8')) as {
      tasks: Array<{
        nodeId: string;
        argv: string[];
        allowlistedEnv: string[];
      }>;
    };
    const unit = declared.tasks.find((task) => task.nodeId === 'test:unit');
    const rc = declared.tasks.find((task) => task.nodeId === 'test:rc');
    if (unit === undefined || rc === undefined) throw new Error('test fixture tasks are missing');
    unit.allowlistedEnv = [environmentKey];
    unit.argv = ['node', '-e', `process.exit(process.env.${environmentKey} !== undefined ? 0 : 8)`];
    rc.allowlistedEnv = [];
    rc.argv = ['node', '-e', `process.exit(process.env.${environmentKey} === undefined ? 0 : 7)`];
    file(state.root, 'test-tasks.json', `${JSON.stringify(declared, null, 2)}\n`);

    const report = withRunnerScope(() =>
      runCheckTasks({
        repoRoot: state.root,
        target: 'rc',
        operation: 'run',
        toolchain: TOOLCHAIN,
        environment: { [environmentKey]: secret },
        now: () => '2026-08-10T00:00:00.000Z',
      }),
    );
    expect(report.exitCode).toBe(0);
    expect(report.execution?.every((task) => task.outcome === 'PASS')).toBe(true);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('builds the runtime before every local lane that executes built artifacts', () => {
    const actual = readTaskDescriptor(
      fileURLToPath(new URL('../../../../test-tasks.json', import.meta.url)),
    );
    for (const nodeId of ['test:cli', 'test:skills', 'test:root']) {
      expect(actual.tasks.find((task) => task.nodeId === nodeId)?.dependencies).toContain('build');
    }
    expect(actual.tasks.find((task) => task.nodeId === 'test:schemas')).toMatchObject({
      argv: ['pnpm', 'run', 'test:schemas', '--configLoader', 'runner', '--no-cache'],
    });
    expect(actual.tasks.find((task) => task.nodeId === 'test:local-full')?.dependencies).toContain(
      'test:schemas',
    );
    expect(actual.tasks.find((task) => task.nodeId === 'build')?.outputContract?.paths).toEqual([
      'scratch/coverage/rc-reachable-sources.json',
      'packages/authority/tsconfig.tsbuildinfo',
      'packages/cli/tsconfig.tsbuildinfo',
      'packages/effects-check/tsconfig.tsbuildinfo',
      'packages/evidence/tsconfig.tsbuildinfo',
      'packages/loop/tsconfig.tsbuildinfo',
      'packages/schemas/tsconfig.tsbuildinfo',
      'packages/sensors/tsconfig.tsbuildinfo',
      'packages/skills/tsconfig.tsbuildinfo',
      'packages/spec/tsconfig.tsbuildinfo',
      'packages/utils/tsconfig.tsbuildinfo',
    ]);
    expect(actual.tasks.find((task) => task.nodeId === 'test:coverage:rc')?.dependencies).toEqual([
      'build',
    ]);
    expect(actual.tasks.find((task) => task.nodeId === 'lint')?.dependencies).toEqual(['generate']);
    expect(actual.tasks.find((task) => task.nodeId === 'typecheck')?.dependencies).toEqual([
      'build',
    ]);
    expect(actual.tasks.find((task) => task.nodeId === 'test:local-full')?.dependencies).toEqual(
      expect.arrayContaining(['lint', 'typecheck']),
    );
    expect(actual.profiles.find((profile) => profile.profileId === 'rc')?.requiredNodes).toEqual([
      'lint',
      'typecheck',
      'test:coverage:rc',
    ]);
  });

  it.each([
    ['source', 'src/app.ts', 'export const value = 2;\n'],
    ['test', 'tests/app.test.ts', 'test(newValue);\n'],
    ['helper', 'helpers.ts', 'export const helper = false;\n'],
    ['config', 'config.json', '{"enabled":false}\n'],
    ['lockfile', 'lock.yaml', 'version: 2\n'],
  ])('invalidates the owning concern for a %s change', (_label, path, content) => {
    const state = repository();
    commit(state.root, path, content);
    const affected = plan(state.root, 'affected', state.base);
    expect(affected.changedPaths).toEqual([path]);
    expect(affected.tasks.map((task) => task.nodeId)).toContain('test:unit');
    expect(affected.tasks.map((task) => task.nodeId)).not.toContain('test:rc');
    expect(
      affected.tasks.find((task) => task.nodeId === 'test:unit')?.matchedChangedPaths,
    ).toContain(path);
    expect(affected.tasks.map((task) => task.nodeId)).not.toContain('test:local-full');
  });

  it('selects authority after a committed utils change in a detached repository fixture', () => {
    const fixture = createSelfContainedRepositoryFixture(REPOSITORY_ROOT);
    sourceFixtures.push(fixture);
    const clone = fixture.root;
    const base = fixture.commit;
    fixture.git(['checkout', '--detach', '--quiet', base]);
    file(
      clone,
      'packages/utils/src/index.ts',
      `${readFileSync(join(clone, 'packages/utils/src/index.ts'), 'utf8')}\nexport const selectorFixture = true;\n`,
    );
    fixture.git(['add', '--', 'packages/utils/src/index.ts']);
    fixture.git(['commit', '--quiet', '-m', 'change packages/utils/src/index.ts']);
    const affected = withRunnerScope(() =>
      buildTaskPlan({
        repoRoot: clone,
        descriptor: readTaskDescriptor(join(clone, 'test-tasks.json')),
        target: 'affected',
        baseCommit: base,
        toolchain: {
          node: 'v-test',
          pnpm: '9.15.0',
          eslint: 'eslint@9.0.0',
          vitest: '4.1.10',
          typescript: '5.9.3',
          postgres: 'psql-test',
        },
        environment: {},
        cacheState: () => ({ cacheState: 'execute', reason: 'fixture' }),
      }),
    );
    expect(affected.changedPaths).toContain('packages/utils/src/index.ts');
    expect(affected.tasks.map((task) => task.nodeId)).toContain('test:authority');
  }, 15_000);

  it('accounts for both sides of renames and for deleted paths', () => {
    const renamed = repository();
    git(renamed.root, ['mv', 'src/app.ts', 'src/renamed.ts']);
    git(renamed.root, ['commit', '-qm', 'rename']);
    expect(plan(renamed.root, 'affected', renamed.base).changedPaths).toEqual([
      'src/app.ts',
      'src/renamed.ts',
    ]);

    const deleted = repository();
    rmSync(join(deleted.root, 'helpers.ts'));
    git(deleted.root, ['add', '-A']);
    git(deleted.root, ['commit', '-qm', 'delete']);
    const deletedPlan = plan(deleted.root, 'affected', deleted.base);
    expect(deletedPlan.changedPaths).toEqual(['helpers.ts']);
    expect(deletedPlan.tasks.map((task) => task.nodeId)).toContain('test:unit');
  });

  it('widens dynamic and unknown changes to the declared full local fallback', () => {
    const dynamic = repository();
    commit(dynamic.root, 'scripts/dynamic/load.mjs', 'export {};\n');
    const dynamicPlan = plan(dynamic.root, 'affected', dynamic.base);
    expect(dynamicPlan.tasks.map((task) => task.nodeId)).toContain('test:local-full');
    expect(dynamicPlan.tasks.map((task) => task.nodeId)).toContain('test:unit');

    const unknown = repository();
    commit(unknown.root, 'notes/new.txt', 'unknown\n');
    const unknownPlan = plan(unknown.root, 'affected', unknown.base);
    expect(unknownPlan.tasks.map((task) => task.nodeId)).toContain('test:local-full');
    expect(unknownPlan.tasks.map((task) => task.nodeId)).toContain('test:unit');
  });

  it('propagates dependency-key invalidation without commit identity in reusable keys', () => {
    const state = repository();
    const initial = plan(state.root, 'local');
    const initialUnit = initial.tasks.find((task) => task.nodeId === 'test:unit');
    const initialGenerate = initial.tasks.find((task) => task.nodeId === 'generate');
    commit(state.root, 'config.json', '{"enabled":false}\n');
    const changed = plan(state.root, 'local');
    expect(changed.tasks.find((task) => task.nodeId === 'generate')?.taskKey).not.toBe(
      initialGenerate?.taskKey,
    );
    expect(changed.tasks.find((task) => task.nodeId === 'test:unit')?.taskKey).not.toBe(
      initialUnit?.taskKey,
    );

    commit(state.root, 'config.json', '{"enabled":true}\n');
    const restored = plan(state.root, 'local');
    expect(restored.tasks.find((task) => task.nodeId === 'generate')?.taskKey).toBe(
      initialGenerate?.taskKey,
    );
    expect(restored.tasks.find((task) => task.nodeId === 'test:unit')?.taskKey).toBe(
      initialUnit?.taskKey,
    );
    expect(restored.repository.commit).not.toBe(initial.repository.commit);
  });

  it('does not bind ambient resolved executable bytes into portable task keys', () => {
    const state = repository();
    file(state.root, 'node_modules/.bin/node', '#!/bin/sh\nexit 0\n');
    chmodSync(join(state.root, 'node_modules/.bin/node'), 0o755);
    const first = plan(state.root, 'rc');
    file(state.root, 'node_modules/.bin/node', '#!/bin/sh\nexit 1\n');
    const changed = plan(state.root, 'rc');
    expect(changed.tasks.map((task) => task.taskKey)).toEqual(
      first.tasks.map((task) => task.taskKey),
    );
    expect(first.tasks[0]?.executable.path).toBe(
      realpathSync(join(state.root, 'node_modules/.bin/node')),
    );
  });

  it('rejects a protected executable identity that does not match the executable it will run', () => {
    const state = repository();
    const descriptorValue = readTaskDescriptor(join(state.root, 'test-tasks.json'));
    const build = (sha256: string) =>
      withRunnerScope(() =>
        buildTaskPlan({
          repoRoot: state.root,
          descriptor: descriptorValue,
          target: 'local',
          toolchain: {
            ...TOOLCHAIN,
            'executable:node': JSON.stringify({
              path: '/protected/toolchain/node',
              sha256,
            }),
          },
          environment: {},
          cacheState: () => ({ cacheState: 'execute', reason: 'test' }),
        }),
      );
    expect(() => build('a'.repeat(64))).toThrow('CHECK_RUNNER_EXECUTABLE_IDENTITY_MISMATCH');
  });

  it('does not require release-candidate toolchains for the cheap local closure', () => {
    const state = repository();
    const declared = JSON.parse(readFileSync(join(state.root, 'test-tasks.json'), 'utf8')) as {
      tasks: Array<{ nodeId: string; toolchainKeys: string[] }>;
    };
    const rcTask = declared.tasks.find((task) => task.nodeId === 'test:rc');
    if (rcTask === undefined) throw new Error('test fixture is missing test:rc');
    rcTask.toolchainKeys = ['rc-only-toolchain'];
    writeFileSync(join(state.root, 'test-tasks.json'), `${JSON.stringify(declared, null, 2)}\n`);

    expect(() => run(state.root)).not.toThrow();
    expect(() => plan(state.root, 'rc')).toThrow(/CHECK_RUNNER_TOOLCHAIN_MISSING/u);
  });

  it('preserves absent allowlisted environment and binds it distinctly from explicit empty', () => {
    const state = repository();
    const environmentKey = 'DEVAI_CHECK_RUNNER_OPTIONAL_FIXTURE';
    const declared = JSON.parse(readFileSync(join(state.root, 'test-tasks.json'), 'utf8')) as {
      tasks: Array<{
        nodeId: string;
        argv: string[];
        allowlistedEnv: string[];
      }>;
    };
    const rcTask = declared.tasks.find((task) => task.nodeId === 'test:rc');
    if (rcTask === undefined) throw new Error('test fixture is missing test:rc');
    rcTask.allowlistedEnv = ['DEVAI_DB_TESTS', environmentKey];
    rcTask.argv = [
      'node',
      '-e',
      `process.exit(process.env.${environmentKey} === undefined ? 0 : 7)`,
    ];
    writeFileSync(join(state.root, 'test-tasks.json'), `${JSON.stringify(declared, null, 2)}\n`);

    const previousValue = process.env[environmentKey];
    Reflect.deleteProperty(process.env, environmentKey);
    try {
      const absent = withRunnerScope(() =>
        runCheckTasks({
          repoRoot: state.root,
          target: 'rc',
          operation: 'run',
          cacheRoot: join(state.root, '.devai/state/absent-cache'),
          toolchain: TOOLCHAIN,
          environment: { DEVAI_DB_TESTS: '1' },
          now: () => '2026-08-10T00:00:00.000Z',
        }),
      );
      const explicitEmpty = withRunnerScope(() =>
        runCheckTasks({
          repoRoot: state.root,
          target: 'rc',
          operation: 'run',
          cacheRoot: join(state.root, '.devai/state/empty-cache'),
          toolchain: TOOLCHAIN,
          environment: { DEVAI_DB_TESTS: '1', [environmentKey]: '' },
          now: () => '2026-08-10T00:00:00.000Z',
        }),
      );
      const absentTask = absent.plan.tasks.find((task) => task.nodeId === 'test:rc');
      const emptyTask = explicitEmpty.plan.tasks.find((task) => task.nodeId === 'test:rc');

      expect(absent.exitCode).toBe(0);
      expect(absent.execution?.find((task) => task.nodeId === 'test:rc')).toMatchObject({
        outcome: 'PASS',
        exitCode: 0,
      });
      expect(explicitEmpty.exitCode).toBe(1);
      expect(explicitEmpty.execution?.find((task) => task.nodeId === 'test:rc')).toMatchObject({
        outcome: 'FAIL',
        exitCode: 7,
      });
      expect(absentTask?.taskKey).not.toBe(emptyTask?.taskKey);
      expect(absentTask?.inputDigest).not.toBe(emptyTask?.inputDigest);
    } finally {
      if (previousValue === undefined) Reflect.deleteProperty(process.env, environmentKey);
      else process.env[environmentKey] = previousValue;
    }
  });

  it('does not impose the DEVAI source sentinel on adopter RC profiles', () => {
    const state = repository();
    expect(() =>
      withRunnerScope(() =>
        runCheckTasks({
          repoRoot: state.root,
          target: 'rc',
          operation: 'plan',
          toolchain: TOOLCHAIN,
          environment: {},
        }),
      ),
    ).not.toThrow();
  });

  it('refuses RC planning when a descriptor-declared database sentinel is disabled', () => {
    const state = repository();
    const declared = JSON.parse(readFileSync(join(state.root, 'test-tasks.json'), 'utf8')) as {
      tasks: Array<{ nodeId: string; allowlistedEnv: string[] }>;
    };
    const rcTask = declared.tasks.find((task) => task.nodeId === 'test:rc');
    if (rcTask === undefined) throw new Error('test fixture is missing test:rc');
    rcTask.allowlistedEnv.push('DEVAI_DB_TESTS');
    writeFileSync(join(state.root, 'test-tasks.json'), `${JSON.stringify(declared, null, 2)}\n`);

    expect(() =>
      withRunnerScope(() =>
        runCheckTasks({
          repoRoot: state.root,
          target: 'rc',
          operation: 'plan',
          toolchain: TOOLCHAIN,
          environment: { DEVAI_DB_TESTS: '' },
        }),
      ),
    ).toThrow(/CHECK_RC_DB_TESTS_REQUIRED/u);

    const actual = readTaskDescriptor(
      fileURLToPath(new URL('../../../../test-tasks.json', import.meta.url)),
    );
    expect(
      actual.tasks.find((task) => task.nodeId === 'test:coverage:rc')?.allowlistedEnv,
    ).toContain('DEVAI_DB_TESTS');
  });

  it('reuses PASS only, binds output digests, and detects changed durable output', () => {
    const state = repository();
    const first = run(state.root);
    expect(first.execution?.every((task) => task.disposition === 'executed')).toBe(true);
    const generateResult = first.execution?.find((task) => task.nodeId === 'generate');
    expect(generateResult?.resultDigest).toMatch(/^[0-9a-f]{64}$/u);
    const stored = JSON.parse(
      readFileSync(
        join(
          state.root,
          '.devai/state/check-cache/v1/results',
          `${generateResult?.resultDigest}.json`,
        ),
        'utf8',
      ),
    ) as { outputDigests: Record<string, string> };
    expect(Object.keys(stored).sort()).toEqual(
      [
        'dependencyResultDigests',
        'finishedAt',
        'inputDigest',
        'nodeId',
        'outputDigests',
        'schemaVersion',
        'startedAt',
        'status',
        'taskKey',
      ].sort(),
    );
    expect(stored.outputDigests.stdout).toBe(sha256Hex(Buffer.from('ok\n')));
    expect(stored.outputDigests['generated.txt']).toBe(
      sha256Hex(readFileSync(join(state.root, 'generated.txt'))),
    );

    const second = run(state.root);
    expect(second.execution?.every((task) => task.disposition === 'reused')).toBe(true);
    file(state.root, 'generated.txt', 'tampered\n');
    const status = run(state.root, { operation: 'status' });
    expect(status.plan.tasks.find((task) => task.nodeId === 'generate')).toMatchObject({
      cacheState: 'stale',
      reason: 'output-digest-changed',
    });
  });

  it('never lets harness-mutated paths become glob inputs while preserving source invalidation', () => {
    const state = repository();
    commit(state.root, '.gitignore', '');

    const first = run(state.root);
    expect(first.execution?.every((task) => task.disposition === 'executed')).toBe(true);

    file(state.root, '.devai/state/manual-counter.json', '{"count":1}\n');
    file(state.root, 'record/proofs/harness.json', '{"verdict":"pass"}\n');
    file(state.root, 'scratch/transient.txt', 'ephemeral\n');
    const second = run(state.root);
    expect(second.execution?.every((task) => task.disposition === 'reused')).toBe(true);
    expect(
      second.plan.tasks
        .flatMap((task) => task.inputPaths)
        .some(
          (path) =>
            path.startsWith('.devai/state/') ||
            path.startsWith('record/') ||
            path.startsWith('scratch/'),
        ),
    ).toBe(false);

    file(state.root, 'src/app.ts', 'export const value = 2;\n');
    const third = run(state.root);
    expect(third.execution?.find((task) => task.nodeId === 'test:unit')).toMatchObject({
      disposition: 'executed',
      reason: 'task-key-changed',
    });

    file(state.root, '.devai/config/thresholds.json', '{"coverage":90}\n');
    const fourth = run(state.root);
    expect(fourth.execution?.find((task) => task.nodeId === 'test:local-full')).toMatchObject({
      disposition: 'executed',
      reason: 'task-key-changed',
    });
  });

  it('reuses a persisted multi-dependency result regardless of dependency declaration order', () => {
    const state = repository();
    const declared = JSON.parse(readFileSync(join(state.root, 'test-tasks.json'), 'utf8')) as {
      tasks: Array<{ nodeId: string; dependencies: string[] }>;
    };
    const localFull = declared.tasks.find((task) => task.nodeId === 'test:local-full');
    if (localFull === undefined) throw new Error('test fixture is missing test:local-full');
    localFull.dependencies = ['test:unit', 'generate'];
    writeFileSync(join(state.root, 'test-tasks.json'), `${JSON.stringify(declared, null, 2)}\n`);

    const first = run(state.root);
    const localFullResult = first.execution?.find((task) => task.nodeId === 'test:local-full');
    expect(localFullResult).toMatchObject({ disposition: 'executed', outcome: 'PASS' });
    const stored = JSON.parse(
      readFileSync(
        join(
          state.root,
          '.devai/state/check-cache/v1/results',
          `${String(localFullResult?.resultDigest)}.json`,
        ),
        'utf8',
      ),
    ) as { dependencyResultDigests: Record<string, string> };
    expect(Object.keys(stored.dependencyResultDigests)).toEqual(['generate', 'test:unit']);

    const second = run(state.root);
    expect(second.execution?.find((task) => task.nodeId === 'test:local-full')).toMatchObject({
      disposition: 'reused',
      outcome: 'PASS',
      reason: 'fresh-pass',
    });
  });

  it('binds declared generated artifacts for non-file-specific output contracts', () => {
    const state = repository();
    const declared = JSON.parse(readFileSync(join(state.root, 'test-tasks.json'), 'utf8')) as {
      tasks: Array<{ nodeId: string; outputContract: Record<string, unknown> }>;
    };
    const generate = declared.tasks.find((task) => task.nodeId === 'generate');
    if (generate === undefined) throw new Error('test fixture is missing generate');
    generate.outputContract = {
      kind: 'workspace-build',
      requiredResult: 'pass',
      paths: ['generated.txt'],
    };
    writeFileSync(join(state.root, 'test-tasks.json'), `${JSON.stringify(declared, null, 2)}\n`);

    const first = run(state.root);
    expect(first.execution?.every((task) => task.outcome === 'PASS')).toBe(true);
    file(state.root, 'generated.txt', 'changed outside the build result\n');
    const status = run(state.root, { operation: 'status' });
    expect(status.plan.tasks.find((task) => task.nodeId === 'generate')).toMatchObject({
      cacheState: 'stale',
      reason: 'output-digest-changed',
    });
  });

  it('persists bounded private failure diagnostics without adding content to the report', () => {
    const state = repository();
    const marker = 'private-diagnostic-marker';
    const failed: TaskExecutionResult = {
      status: 9,
      signal: null,
      stdout: `stdout-${marker}-${'x'.repeat(20_000)}`,
      stderr: `stderr-${marker}-${'y'.repeat(20_000)}`,
    };
    const report = run(state.root, { executeTask: () => failed });
    const diagnosticPath = report.execution?.[0]?.diagnosticPath;

    expect(report.execution?.[0]).toMatchObject({
      outcome: 'FAIL',
      reason: 'process-exit-9',
      exitCode: 9,
    });
    expect(diagnosticPath).toBeDefined();
    expect(statSync(diagnosticPath ?? '').mode & 0o777).toBe(0o600);
    const diagnosticBytes = readFileSync(diagnosticPath ?? '');
    const diagnostic = JSON.parse(diagnosticBytes.toString('utf8')) as {
      stdoutTail: string;
      stderrTail: string;
    };
    expect(Buffer.byteLength(diagnostic.stdoutTail)).toBeLessThanOrEqual(8 * 1024);
    expect(Buffer.byteLength(diagnostic.stderrTail)).toBeLessThanOrEqual(8 * 1024);
    expect(JSON.stringify(report)).not.toContain(marker);
    expect(report.receipt).toBeUndefined();
  });

  it.each([
    ['FAIL', { status: 1, signal: null, stdout: '', stderr: 'failed' }],
    [
      'TIMEOUT',
      { status: null, signal: 'SIGTERM', stdout: '', stderr: '', errorCode: 'ETIMEDOUT' },
    ],
    ['KILLED', { status: null, signal: 'SIGKILL', stdout: '', stderr: '' }],
  ] as const)('never reuses a %s attempt', (outcome, failed) => {
    const state = repository();
    const first = run(state.root, { executeTask: () => failed });
    expect(first.execution?.[0]).toMatchObject({ outcome, disposition: 'executed' });
    const second = run(state.root);
    expect(second.execution?.[0]).toMatchObject({ outcome: 'PASS', disposition: 'executed' });
    expect(second.execution?.[0]?.reason).toBe(`previous-${outcome.toLowerCase()}`);
  });

  it('allows dirty iteration but refuses every candidate receipt from a dirty tree', () => {
    const state = repository();
    file(state.root, 'src/app.ts', 'export const value = 99;\n');
    const report = run(state.root, {
      target: 'affected',
      baseCommit: state.base,
    });
    expect(report.plan.clean).toBe(false);
    expect(report.execution?.every((task) => task.outcome === 'PASS')).toBe(true);
    expect(report.receipt).toBeUndefined();
    expect(report.receiptRefusal).toBe('dirty-start');
  });

  it('refuses a candidate receipt when execution changes the committed tree', () => {
    const state = repository();
    commit(state.root, 'src/app.ts', 'export const value = 2;\n');
    let ordinal = 0;
    const report = run(state.root, {
      target: 'affected',
      baseCommit: state.base,
      executeTask: () => {
        ordinal += 1;
        if (ordinal === 1) file(state.root, 'src/app.ts', 'export const value = 3;\n');
        return PASS;
      },
    });
    expect(report.execution?.every((task) => task.outcome === 'PASS')).toBe(true);
    expect(report.receipt).toBeUndefined();
    expect(report.receiptRefusal).toBe('repository-changed-during-run');
  });

  it('emits verifier-shaped unsigned results and a clean exact-tree candidate receipt', () => {
    const state = repository();
    commit(state.root, 'src/app.ts', 'export const value = 2;\n');
    const report = run(state.root, {
      target: 'affected',
      baseCommit: state.base,
    });
    expect(report.receiptRefusal).toBeUndefined();
    expect(report.receipt?.value).toMatchObject({
      schemaVersion: '1.1.0',
      profile: 'affected',
      repository: {
        id: 'example/repo',
        commit: git(state.root, ['rev-parse', 'HEAD']),
        tree: git(state.root, ['show', '-s', '--format=%T', 'HEAD']),
      },
      taskPolicyDigest: report.plan.taskPolicyDigest,
    });
    expect(report.receipt?.value.tasks).toHaveLength(report.plan.tasks.length);
    const receiptBytes = readFileSync(report.receipt?.path ?? '', 'utf8');
    expect(Object.keys(JSON.parse(receiptBytes) as object).sort()).toEqual(
      ['createdAt', 'profile', 'repository', 'schemaVersion', 'taskPolicyDigest', 'tasks'].sort(),
    );
    expect(receiptBytes).not.toContain('signature');
  });

  it('retains the complete protected candidate result population in planned order', () => {
    const state = repository();
    commit(state.root, 'src/app.ts', 'export const value = 2;\n');
    const report = run(state.root, {
      target: 'affected',
      baseCommit: state.base,
      protectedExecutionIdentity: { kind: 'check-runner-test' },
      readTaskOutput: (path) => readFileSync(join(state.root, path)),
      capturedTaskOutputPaths: () => [],
    });

    expect(report.receipt).toBeDefined();
    expect(report.execution?.every((task) => task.disposition === 'executed')).toBe(true);
    const results = readProtectedCompletedTaskResults(report);
    expect(results.map((result) => result.nodeId)).toEqual(
      report.plan.tasks.map((task) => task.nodeId),
    );
    expect(results.map((result) => result.taskKey)).toEqual(
      report.plan.tasks.map((task) => task.taskKey),
    );
    expect(results.map((result) => result.status)).toEqual(report.plan.tasks.map(() => 'PASS'));
    expect(results.every((result) => result.schemaVersion === '1.0.0')).toBe(true);
  });

  it('retains reused protected task results as the complete planned population', () => {
    const state = repository();
    commit(state.root, 'src/app.ts', 'export const value = 2;\n');
    const protectedOptions = {
      target: 'affected' as const,
      baseCommit: state.base,
      protectedExecutionIdentity: { kind: 'check-runner-test' },
      readTaskOutput: (path: string) => readFileSync(join(state.root, path)),
      capturedTaskOutputPaths: () => [] as const,
    };
    const first = run(state.root, protectedOptions);
    const second = run(state.root, protectedOptions);

    expect(second.receipt).toBeDefined();
    expect(second.execution?.every((task) => task.disposition === 'reused')).toBe(true);
    expect(readProtectedCompletedTaskResults(second)).toEqual(
      readProtectedCompletedTaskResults(first),
    );
    expect(readProtectedCompletedTaskResults(second).map((result) => result.nodeId)).toEqual(
      second.plan.tasks.map((task) => task.nodeId),
    );
  });

  it('refuses ordinary and non-receipt reports at the protected result boundary', () => {
    const state = repository();
    commit(state.root, 'src/app.ts', 'export const value = 2;\n');
    const ordinary = run(state.root, {
      target: 'affected',
      baseCommit: state.base,
    });
    const nonReceipt = run(state.root, {
      protectedExecutionIdentity: { kind: 'check-runner-test' },
      readTaskOutput: (path) => readFileSync(join(state.root, path)),
      capturedTaskOutputPaths: () => [],
    });

    expect(ordinary.receipt).toBeDefined();
    expect(nonReceipt.receipt).toBeUndefined();
    expect(() => readProtectedCompletedTaskResults(ordinary)).toThrow(
      'release-certification-task-results-unavailable',
    );
    expect(() => readProtectedCompletedTaskResults(nonReceipt)).toThrow(
      'release-certification-task-results-unavailable',
    );
  });

  it('returns defensive snapshots without exposing retained protected results', () => {
    const state = repository();
    commit(state.root, 'src/app.ts', 'export const value = 2;\n');
    const report = run(state.root, {
      target: 'affected',
      baseCommit: state.base,
      protectedExecutionIdentity: { kind: 'check-runner-test' },
      readTaskOutput: (path) => readFileSync(join(state.root, path)),
      capturedTaskOutputPaths: () => [],
    });
    const expected = readProtectedCompletedTaskResults(report);
    const returned = readProtectedCompletedTaskResults(report) as Array<{
      outputDigests: Record<string, string>;
    }>;

    returned.pop();
    const firstReturned = returned.at(0);
    if (firstReturned === undefined)
      throw new Error('protected result population unexpectedly empty');
    expect(Reflect.set(firstReturned.outputDigests, 'forged', 'f'.repeat(64))).toBe(false);
    expect(readProtectedCompletedTaskResults(report)).toEqual(expected);
  });

  it('keeps ordinary RC task keys identical to independent portable-policy reconstruction', () => {
    const state = repository();
    const report = run(state.root, { target: 'rc' });
    const toolchainPath = join(state.root, 'protected-toolchain.json');
    const environmentPath = join(state.root, 'protected-environment.json');
    const outputPath = join(state.root, 'protected-task-policy.json');
    writeFileSync(toolchainPath, `${JSON.stringify({ node: TOOLCHAIN.node })}\n`);
    writeFileSync(environmentPath, '{}\n');
    const reconstructed = spawnSync(
      process.execPath,
      [
        join(REPOSITORY_ROOT, 'packages/cli/vendor/evidence-verification/src/build-policy-cli.js'),
        '--repo',
        state.root,
        '--descriptor',
        join(state.root, 'test-tasks.json'),
        '--profile',
        'rc',
        '--schema-version',
        '1.1.0',
        '--commit',
        report.plan.repository.commit,
        '--tree',
        report.plan.repository.tree,
        '--toolchain',
        toolchainPath,
        '--environment',
        environmentPath,
        '--output',
        outputPath,
      ],
      { cwd: state.root, encoding: 'utf8' },
    );
    expect(reconstructed.status, reconstructed.stderr).toBe(0);
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual(report.plan.taskPolicy);
  });

  it('validates and binds exact release intent into the candidate receipt', () => {
    const state = repository();
    commitRelease(state.root, 'src/app.ts', 'export const value = 2;\n');
    const releaseIntent = {
      schemaVersion: '1.0.0',
      release_unit: 'example/repo',
      current_version: '1.0.0',
      target_version: '1.0.1',
      support: 'current',
      changed_paths: ['package.json', 'src/app.ts'],
      changed_packages: [],
      candidate: {
        commit: git(state.root, ['rev-parse', 'HEAD']),
        tree: git(state.root, ['show', '-s', '--format=%T', 'HEAD']),
      },
      base: {
        commit: state.base,
        tree: git(state.root, ['show', '-s', '--format=%T', state.base]),
      },
    } as const;
    const preflight = run(state.root, {
      target: 'affected',
      baseCommit: state.base,
      releaseIntent,
      releaseProfile: releaseProfile(),
    });
    expect(preflight.plan.releaseIntentDigest).toBe(sha256Hex(releaseIntent));
    expect(preflight.plan.taskPolicy.schemaVersion).toBe('1.2.0');
    expect(preflight.plan.taskPolicy.inputProjection).toEqual({
      schemaVersion: '1.0.0',
      source: 'exact-candidate-tree',
      excludedPrefixes: ['.devai/state/', 'record/', 'scratch/'],
      digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    const releasePlan = run(state.root, {
      target: 'release',
      operation: 'plan',
      baseCommit: state.base,
      releaseCandidate: releaseIntent.candidate,
      releaseIntent,
      releaseProfile: releaseProfile(),
    });
    expect(Object.keys(releasePlan.plan.taskPolicy).sort()).toEqual(
      ['inputProjection', 'repositoryId', 'requiredNodes', 'schemaVersion'].sort(),
    );
    expect(releasePlan.plan.taskPolicy.schemaVersion).toBe('1.2.0');
    expect(releasePlan.plan.taskPolicy.inputProjection).toEqual({
      schemaVersion: '1.0.0',
      source: 'exact-candidate-tree',
      excludedPrefixes: ['.devai/state/', 'record/', 'scratch/'],
      digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(preflight.preflightReceipt?.value.verdict).toBe('pass');
    expect(preflight.receipt).toBeUndefined();
    expect(preflight.releaseVerification).toContainEqual({
      nodeId: 'test:rc',
      status: 'not-required',
      reasonCode: 'capability-not-selected',
    });
    const report = run(state.root, {
      target: 'affected',
      baseCommit: state.base,
      releaseIntent,
      releaseProfile: releaseProfile(),
      releaseStage: 'certify',
      preflightReceipt: preflight.preflightReceipt?.value,
    });
    expect(report.receipt?.value.profile).toBe('rc');
    expect(report.plan.releaseDecision).toMatchObject({
      verdict: 'ready',
      transition: 'patch',
    });
    expect(report.releaseVerification?.every((entry) => entry.status !== 'unknown')).toBe(true);
  });

  it('refuses required mutation certification before executing ordinary check callbacks', () => {
    const state = repository();
    commitRelease(state.root, 'src/app.ts', 'export const value = 2;\n');
    const releaseIntent = {
      schemaVersion: '1.0.0',
      release_unit: 'example/repo',
      current_version: '1.0.0',
      target_version: '1.0.1',
      support: 'current',
      changed_paths: ['package.json', 'src/app.ts'],
      changed_packages: [],
      candidate: {
        commit: git(state.root, ['rev-parse', 'HEAD']),
        tree: git(state.root, ['show', '-s', '--format=%T', 'HEAD']),
      },
      base: {
        commit: state.base,
        tree: git(state.root, ['show', '-s', '--format=%T', state.base]),
      },
    } as const;
    const profile = {
      ...releaseProfile(),
      mutation_roster: [
        {
          id: 'ordinary-unit-check',
          package: 'example-repo',
          task_node: 'test:unit',
          source_selectors: ['src/'],
          test_selectors: ['tests/'],
          manifest_path: 'package.json',
          config_paths: ['test-tasks.json'],
          sanitizer_paths: ['tools/mutation-sanitizer.mjs'],
          orchestration_paths: ['test-tasks.json'],
          lockfile_path: 'lock.yaml',
          toolchain_keys: ['node'],
          thresholds: { score_min: 90 },
        },
      ],
    } as const;
    const preflight = run(state.root, {
      target: 'affected',
      baseCommit: state.base,
      releaseIntent,
      releaseProfile: profile,
    });
    expect(preflight.preflightReceipt?.value.verdict).toBe('pass');

    let callbacks = 0;
    expect(() =>
      run(state.root, {
        target: 'affected',
        baseCommit: state.base,
        releaseIntent,
        releaseProfile: profile,
        releaseStage: 'certify',
        preflightReceipt: preflight.preflightReceipt?.value,
        executeTask: () => {
          callbacks += 1;
          return PASS;
        },
      }),
    ).toThrow('CHECK_RELEASE_MUTATION_EVIDENCE_UNAVAILABLE');
    expect(callbacks).toBe(0);

    // A wrong or absent declaration is not a producer: only the exact protected
    // host token lets required mutation be planned for execution.
    for (const declaration of [() => 'protected-mutation-producer-v20', () => '', () => 'true']) {
      expect(() =>
        run(state.root, {
          target: 'affected',
          baseCommit: state.base,
          releaseIntent,
          releaseProfile: profile,
          releaseStage: 'certify',
          preflightReceipt: preflight.preflightReceipt?.value,
          resolveProtectedMutationProducer: declaration,
          executeTask: () => {
            callbacks += 1;
            return PASS;
          },
        }),
      ).toThrow('CHECK_RELEASE_MUTATION_EVIDENCE_UNAVAILABLE');
    }
    expect(callbacks).toBe(0);

    // With the protected producer declared, the same plan reaches execution and
    // binds the roster entry to its task node.
    const certified = run(state.root, {
      target: 'affected',
      baseCommit: state.base,
      releaseIntent,
      releaseProfile: profile,
      releaseStage: 'certify',
      preflightReceipt: preflight.preflightReceipt?.value,
      resolveProtectedMutationProducer: () => 'protected-mutation-producer-v21',
      executeTask: () => {
        callbacks += 1;
        return PASS;
      },
    });
    expect(callbacks).toBeGreaterThan(0);
    expect(certified.plan.releaseDecision?.mutation).not.toBe('none');
  });

  it('uses the exact release candidate without resolving HEAD and refuses tracked mutation', () => {
    const state = repository();
    const candidateCommit = commitRelease(state.root, 'src/app.ts', 'export const value = 2;\n');
    const releaseIntent = {
      schemaVersion: '1.0.0',
      release_unit: 'example/repo',
      current_version: '1.0.0',
      target_version: '1.0.1',
      support: 'current',
      changed_paths: ['package.json', 'src/app.ts'],
      changed_packages: [],
      candidate: {
        commit: candidateCommit,
        tree: git(state.root, ['show', '-s', '--format=%T', candidateCommit]),
      },
      base: {
        commit: state.base,
        tree: git(state.root, ['show', '-s', '--format=%T', state.base]),
      },
    } as const;
    git(state.root, ['symbolic-ref', 'HEAD', 'refs/heads/intentionally-missing']);
    const detachedFromHead = run(state.root, {
      target: 'affected',
      baseCommit: state.base,
      releaseIntent,
      releaseProfile: releaseProfile(),
    });
    expect(detachedFromHead.preflightReceipt?.value.verdict).toBe('pass');
    rmSync(join(state.root, '.devai/state'), { recursive: true, force: true });

    let mutated = false;
    const refused = run(state.root, {
      target: 'affected',
      baseCommit: state.base,
      releaseIntent,
      releaseProfile: releaseProfile(),
      executeTask: () => {
        if (!mutated) {
          file(state.root, 'src/app.ts', 'export const value = 999;\n');
          mutated = true;
        }
        return PASS;
      },
    });
    expect(refused.preflightReceipt).toBeUndefined();
    expect(refused.receiptRefusal).toBe('repository-changed-during-run');
  });

  it('refuses certification without the exact cheap-preflight receipt', () => {
    const state = repository();
    commitRelease(state.root, 'src/app.ts', 'export const value = 2;\n');
    const releaseIntent = {
      schemaVersion: '1.0.0',
      release_unit: 'example/repo',
      current_version: '1.0.0',
      target_version: '1.0.1',
      support: 'current',
      changed_paths: ['package.json', 'src/app.ts'],
      changed_packages: [],
      candidate: {
        commit: git(state.root, ['rev-parse', 'HEAD']),
        tree: git(state.root, ['show', '-s', '--format=%T', 'HEAD']),
      },
      base: {
        commit: state.base,
        tree: git(state.root, ['show', '-s', '--format=%T', state.base]),
      },
    } as const;
    expect(() =>
      run(state.root, {
        target: 'affected',
        baseCommit: state.base,
        releaseIntent,
        releaseProfile: releaseProfile(),
        releaseStage: 'certify',
      }),
    ).toThrow('CHECK_RELEASE_PREFLIGHT_REQUIRED');
  });

  it('rejects a release intent bound to the wrong candidate tree', () => {
    const state = repository();
    commitRelease(state.root, 'src/app.ts', 'export const value = 2;\n');
    expect(() =>
      run(state.root, {
        target: 'affected',
        baseCommit: state.base,
        releaseIntent: {
          schemaVersion: '1.0.0',
          release_unit: 'example/repo',
          current_version: '1.0.0',
          target_version: '1.0.1',
          support: 'current',
          changed_paths: ['src/app.ts'],
          changed_packages: [],
          candidate: { commit: git(state.root, ['rev-parse', 'HEAD']), tree: 'f'.repeat(40) },
          base: {
            commit: state.base,
            tree: git(state.root, ['show', '-s', '--format=%T', state.base]),
          },
        },
        releaseProfile: releaseProfile(),
      }),
    ).toThrow('CHECK_RELEASE_INTENT_CANDIDATE_MISMATCH');
  });

  it('rejects release intent changed paths that do not match the exact candidate diff', () => {
    const state = repository();
    commitRelease(state.root, 'src/app.ts', 'export const value = 2;\n');
    expect(() =>
      run(state.root, {
        target: 'affected',
        baseCommit: state.base,
        releaseIntent: {
          schemaVersion: '1.0.0',
          release_unit: 'example/repo',
          current_version: '1.0.0',
          target_version: '1.0.1',
          support: 'current',
          changed_paths: ['tests/not-the-change.test.ts'],
          changed_packages: [],
          candidate: {
            commit: git(state.root, ['rev-parse', 'HEAD']),
            tree: git(state.root, ['show', '-s', '--format=%T', 'HEAD']),
          },
          base: {
            commit: state.base,
            tree: git(state.root, ['show', '-s', '--format=%T', state.base]),
          },
        },
        releaseProfile: releaseProfile(),
      }),
    ).toThrow('CHECK_RELEASE_INTENT_CHANGED_PATHS_MISMATCH');
  });

  it('binds declared versions to the exact base and candidate version source', () => {
    const state = repository();
    commitRelease(state.root, 'src/app.ts', 'export const value = 2;\n');
    const intent = {
      schemaVersion: '1.0.0',
      release_unit: 'example/repo',
      current_version: '1.0.0',
      target_version: '1.0.2',
      support: 'current',
      changed_paths: ['package.json', 'src/app.ts'],
      changed_packages: [],
      candidate: {
        commit: git(state.root, ['rev-parse', 'HEAD']),
        tree: git(state.root, ['show', '-s', '--format=%T', 'HEAD']),
      },
      base: {
        commit: state.base,
        tree: git(state.root, ['show', '-s', '--format=%T', state.base]),
      },
    } as const;
    expect(() =>
      run(state.root, {
        target: 'affected',
        baseCommit: state.base,
        releaseIntent: intent,
        releaseProfile: releaseProfile(),
      }),
    ).toThrow('CHECK_RELEASE_TARGET_VERSION_SOURCE_MISMATCH');
    expect(() =>
      run(state.root, {
        target: 'affected',
        baseCommit: state.base,
        releaseIntent: { ...intent, current_version: '0.9.9', target_version: '1.0.1' },
        releaseProfile: releaseProfile(),
      }),
    ).toThrow('CHECK_RELEASE_CURRENT_VERSION_SOURCE_MISMATCH');
  });

  it('fails closed when the declared release-unit version source is unavailable', () => {
    const state = repository();
    commitRelease(state.root, 'src/app.ts', 'export const value = 2;\n');
    expect(() =>
      run(state.root, {
        target: 'affected',
        baseCommit: state.base,
        releaseIntent: {
          schemaVersion: '1.0.0',
          release_unit: 'example/repo',
          current_version: '1.0.0',
          target_version: '1.0.1',
          support: 'current',
          changed_paths: ['package.json', 'src/app.ts'],
          changed_packages: [],
          candidate: {
            commit: git(state.root, ['rev-parse', 'HEAD']),
            tree: git(state.root, ['show', '-s', '--format=%T', 'HEAD']),
          },
          base: {
            commit: state.base,
            tree: git(state.root, ['show', '-s', '--format=%T', state.base]),
          },
        },
        releaseProfile: { ...releaseProfile(), version_source: 'packages/missing/package.json' },
      }),
    ).toThrow('CHECK_RELEASE_VERSION_SOURCE_UNREADABLE');
  });

  it('binds a materialized authority policy into an allowlisted RC task key', () => {
    const state = repository();
    const taskDescriptor = JSON.parse(
      readFileSync(join(state.root, 'test-tasks.json'), 'utf8'),
    ) as {
      tasks: { nodeId: string; allowlistedEnv: string[] }[];
    };
    const rcTask = taskDescriptor.tasks.find((task) => task.nodeId === 'test:rc');
    if (rcTask === undefined) throw new Error('test fixture RC task missing');
    rcTask.allowlistedEnv.push('DEVAI_AUTHORITY_POLICY_SHA256');
    file(state.root, 'test-tasks.json', `${JSON.stringify(taskDescriptor, null, 2)}\n`);
    file(state.root, '.gitignore', '.devai/state/*\n.devai/config/authority-policy.json\n');
    git(state.root, ['add', '.']);
    git(state.root, ['commit', '-qm', 'bind authority policy identity']);
    expect(() => run(state.root, { target: 'rc', environment: { DEVAI_DB_TESTS: '1' } })).toThrow(
      'CHECK_AUTHORITY_POLICY_REQUIRED',
    );
    file(state.root, '.devai/config/authority-policy.json', '{"policy":"first"}\n');
    const first = run(state.root, { target: 'rc', environment: { DEVAI_DB_TESTS: '1' } });
    file(state.root, '.devai/config/authority-policy.json', '{"policy":"second"}\n');
    const second = run(state.root, { target: 'rc', environment: { DEVAI_DB_TESTS: '1' } });

    expect(Object.keys(first.plan.taskPolicy).sort()).toEqual(
      ['repositoryId', 'requiredNodes', 'schemaVersion'].sort(),
    );
    expect(first.plan.taskPolicy.schemaVersion).toBe('1.1.0');
    expect(first.plan.taskPolicy).not.toHaveProperty('inputProjection');
    expect(second.plan.tasks.at(-1)?.taskKey).not.toBe(first.plan.tasks.at(-1)?.taskKey);
    expect(second.plan.taskPolicyDigest).not.toBe(first.plan.taskPolicyDigest);
  });

  it('authorizes only exact descriptor argv and repository-contained cwd for --run', () => {
    const state = repository();
    const request = (
      executable: string,
      argv: readonly string[],
      cwd: string,
      shell: boolean | undefined = undefined,
    ): AuthorityHostEffectRequest => ({
      kind: 'process',
      symbol: 'spawnSync',
      arguments: [executable, argv, { cwd, ...(shell !== undefined && { shell }) }],
    });
    const invocation = ['node', 'devai', 'check', '--local', '--run', '--write'];
    const immutableDescriptor = readTaskDescriptor(join(state.root, 'test-tasks.json'));
    const candidate = {
      commit: git(state.root, ['rev-parse', 'HEAD']),
      tree: git(state.root, ['rev-parse', 'HEAD^{tree}']),
    };
    const releaseRequest = (
      argv: readonly string[],
      shell = false,
      identity = resolveTaskExecutable(state.root, 'node'),
    ): AuthorityHostEffectRequest => ({
      kind: 'process',
      symbol: 'spawnSync',
      arguments: [
        identity.path,
        argv.slice(1),
        bindReleaseTaskProcessOptions(
          { cwd: realpathSync(state.root), shell },
          {
            candidate,
            descriptor_digest: sha256Hex(immutableDescriptor),
            task_policy_digest: 'a'.repeat(64),
            node_id: 'test:local-full',
            executable: identity,
            argv,
            cwd: '.',
          },
        ),
      ],
    });
    expect(
      matchDeclaredCheckTaskProcess(
        state.root,
        invocation,
        request(
          'node',
          ['-e', "process.stdout.write('local test dependency closure complete\\n')"],
          state.root,
          false,
        ),
      ),
    ).toMatchObject({ nodeId: 'test:local-full', cwd: realpathSync(state.root) });
    expect(
      matchDeclaredReleaseTaskProcess(
        state.root,
        releaseRequest([
          'node',
          '-e',
          "process.stdout.write('local test dependency closure complete\\n')",
        ]),
      ),
    ).toMatchObject({ nodeId: 'test:local-full', cwd: realpathSync(state.root) });
    expect(
      matchDeclaredReleaseTaskProcess(
        state.root,
        releaseRequest([
          'node',
          '-e',
          "process.stdout.write('local test dependency closure complete\\n')",
          '--extra',
        ]),
      ),
    ).toBeUndefined();
    expect(
      matchDeclaredReleaseTaskProcess(
        state.root,
        releaseRequest(
          ['node', '-e', "process.stdout.write('local test dependency closure complete\\n')"],
          true,
        ),
      ),
    ).toBeUndefined();
    expect(
      matchDeclaredCheckTaskProcess(
        state.root,
        invocation,
        request(
          realpathSync(process.execPath),
          ['-e', "process.stdout.write('local test dependency closure complete\\n')"],
          state.root,
          false,
        ),
      ),
    ).toMatchObject({ nodeId: 'test:local-full', cwd: realpathSync(state.root) });
    expect(
      matchDeclaredCheckTaskProcess(
        state.root,
        ['node', 'devai', 'check', '--suite', 'quick', '--write'],
        request(
          'node',
          ['-e', "process.stdout.write('local test dependency closure complete\\n')"],
          state.root,
          false,
        ),
      ),
    ).toMatchObject({ nodeId: 'test:local-full', cwd: realpathSync(state.root) });
    const declared = JSON.parse(readFileSync(join(state.root, 'test-tasks.json'), 'utf8')) as {
      tasks: Array<Record<string, unknown>>;
    };
    const mutableReleaseTask = declared.tasks.find((task) => task['nodeId'] === 'test:local-full');
    if (mutableReleaseTask === undefined) throw new Error('release task fixture missing');
    mutableReleaseTask['argv'] = ['node', '-e', 'process.stdout.write("mutable attack")'];
    writeFileSync(join(state.root, 'test-tasks.json'), `${JSON.stringify(declared, null, 2)}\n`);
    expect(
      matchDeclaredReleaseTaskProcess(
        state.root,
        releaseRequest([
          'node',
          '-e',
          "process.stdout.write('local test dependency closure complete\\n')",
        ]),
      ),
    ).toMatchObject({ nodeId: 'test:local-full', cwd: realpathSync(state.root) });
    expect(
      matchDeclaredReleaseTaskProcess(
        state.root,
        releaseRequest(['node', '-e', 'process.stdout.write("mutable attack")']),
      ),
    ).toBeUndefined();
    declared.tasks.push({
      nodeId: 'build',
      dependencies: [],
      argv: ['pnpm', '-r', 'build'],
      cwd: '.',
      runner: 'pnpm-v1',
      inputSelectors: [{ kind: 'prefix', pattern: 'src/' }],
      toolchainKeys: ['pnpm'],
      allowlistedEnv: [],
      outputContract: { kind: 'build', requiredResult: 'pass' },
    });
    declared.tasks.push({
      nodeId: 'npm-test',
      dependencies: [],
      argv: ['npm', 'test', '--', '--runInBand'],
      cwd: '.',
      runner: 'npm-v1',
      inputSelectors: [{ kind: 'prefix', pattern: 'src/' }],
      toolchainKeys: [],
      allowlistedEnv: [],
      outputContract: { kind: 'test', requiredResult: 'pass' },
    });
    writeFileSync(join(state.root, 'test-tasks.json'), `${JSON.stringify(declared, null, 2)}\n`);
    expect(
      matchDeclaredCheckTaskProcess(
        state.root,
        invocation,
        request('pnpm', ['-r', 'build'], state.root, false),
      ),
    ).toMatchObject({ nodeId: 'build', cwd: realpathSync(state.root) });
    expect(
      matchDeclaredCheckTaskProcess(
        state.root,
        invocation,
        request('npm', ['test', '--', '--runInBand'], state.root, false),
      ),
    ).toMatchObject({ nodeId: 'npm-test', cwd: realpathSync(state.root) });
    expect(
      matchDeclaredCheckTaskProcess(
        state.root,
        invocation,
        request('sh', ['-c', 'node test'], state.root),
      ),
    ).toBeUndefined();
    expect(
      describeDeclaredCheckTaskRefusal(
        state.root,
        request('node', ['-e', 'process.stdout.write("different")'], state.root),
      ),
    ).toMatchObject({
      executable: 'node',
      argv: ['-e', 'process.stdout.write("different")'],
      descriptor_path: join(realpathSync(state.root), 'test-tasks.json'),
      closest_declared_node: 'generate',
      reason: 'process is not an exact declared task',
    });
    expect(
      matchDeclaredCheckTaskProcess(
        state.root,
        invocation,
        request('node', ['-e', 'process.stdout.write("different")'], state.root),
      ),
    ).toBeUndefined();
    expect(
      matchDeclaredCheckTaskProcess(
        state.root,
        invocation,
        request(
          'node',
          ['-e', "process.stdout.write('local test dependency closure complete\\n')"],
          dirname(state.root),
        ),
      ),
    ).toBeUndefined();
    expect(
      matchDeclaredCheckTaskProcess(
        state.root,
        invocation,
        request(
          'node',
          ['-e', "process.stdout.write('local test dependency closure complete\\n')"],
          state.root,
          true,
        ),
      ),
    ).toBeUndefined();
  });

  it('rejects path-shaped executables in task descriptors', () => {
    const state = repository();
    const descriptorPath = join(state.root, 'test-tasks.json');
    const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as {
      tasks: Array<{ argv: unknown[] }>;
    };
    const firstTask = descriptor.tasks[0];
    if (firstTask === undefined) throw new Error('test fixture task missing');
    firstTask.argv[0] = '../bin/tool';
    writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
    expect(() => readTaskDescriptor(descriptorPath)).toThrow('CHECK_RUNNER_DESCRIPTOR');
  });

  it('explains the reserved local-closure root when a descriptor omits it', () => {
    const state = repository();
    const descriptorPath = join(state.root, 'test-tasks.json');
    const declared = JSON.parse(readFileSync(descriptorPath, 'utf8')) as {
      fallbackNodeId: string | null;
      tasks: Array<{ nodeId: string }>;
      profiles: Array<{ requiredNodes: string[]; eligibleNodes?: string[] }>;
    };
    declared.fallbackNodeId = 'test:unit';
    declared.tasks = declared.tasks.filter((task) => task.nodeId !== 'test:local-full');
    for (const profile of declared.profiles) {
      profile.requiredNodes = profile.requiredNodes.filter(
        (nodeId) => nodeId !== 'test:local-full',
      );
      if (profile.eligibleNodes !== undefined) {
        profile.eligibleNodes = profile.eligibleNodes.filter(
          (nodeId) => nodeId !== 'test:local-full',
        );
      }
    }
    writeFileSync(descriptorPath, `${JSON.stringify(declared, null, 2)}\n`);

    expect(() => plan(state.root, 'local')).toThrow(
      'local target requires a node named test:local-full (the local-closure root)',
    );
  });

  it('keeps planning/status/explain read-only while --run requires write consent', () => {
    for (const operation of ['--task-plan', '--status', '--explain']) {
      expect(invocationIsNonMutating('check', ['--local', operation])).toBe(true);
    }
    expect(invocationIsNonMutating('check', ['--local', '--run'])).toBe(false);
  });
});
