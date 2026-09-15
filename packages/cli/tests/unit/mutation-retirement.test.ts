import { describe, expect, it } from 'vitest';
import { withoutMutationTestTasks } from '../../src/services/check-runner/policy.js';
import type { TaskDescriptor, TaskDescriptorNode } from '../../src/services/check-runner/types.js';
import {
  createContainerReleaseCertificationAdapters,
  createContainerReleasePreflightProvider,
  type ContainerReleaseCertificationOptions,
} from '../../src/services/release-certification-provider.js';

const task = (nodeId: string, dependencies: readonly string[] = []): TaskDescriptorNode => ({
  nodeId,
  dependencies,
  argv: ['node', 'ordinary.js'],
  cwd: '.',
  runner: 'node',
  inputSelectors: [],
  toolchainKeys: ['node'],
  allowlistedEnv: [],
  outputContract: { paths: [] },
});

describe('mutation retirement boundaries', () => {
  it('removes legacy mutation tasks and dependency/profile references without changing source-write tasks', () => {
    const input: TaskDescriptor = {
      schemaVersion: '1.0.0',
      descriptorVersion: 'test',
      repositoryId: 'fixture',
      fallbackNodeId: 'mutation:cli',
      dynamicFallbackSelectors: [],
      tasks: [
        { ...task('mutation:cli'), outputContract: { kind: 'mutation-report-set-v1' } },
        task('ordinary', ['mutation:cli']),
        task('source-write-mutation'),
        { ...task('opaque-engine'), argv: ['pnpm', 'exec', 'stryker', 'run'] },
      ],
      profiles: [
        {
          profileId: 'rc',
          mode: 'fixed',
          requiredNodes: ['ordinary', 'mutation:cli', 'opaque-engine'],
          eligibleNodes: ['mutation:cli', 'ordinary'],
        },
      ],
    };
    const before = structuredClone(input);
    const result = withoutMutationTestTasks(input);
    expect(result.tasks.map((task) => task.nodeId)).toEqual(['ordinary', 'source-write-mutation']);
    expect(result.tasks[0]?.dependencies).toEqual([]);
    expect(result.profiles[0]).toMatchObject({
      requiredNodes: ['ordinary'],
      eligibleNodes: ['ordinary'],
    });
    expect(result.fallbackNodeId).toBeNull();
    expect(input).toEqual(before);
  });

  it.each<[string, string[]]>([
    ['mutation', ['pnpm', 'exec', 'vitest', 'run', 'authority.test.ts']],
    ['mutation:authorization-denial', ['pnpm', 'exec', 'vitest', 'run', 'authority.test.ts']],
    ['source-write', ['pnpm', 'run', 'test:mutation:report-readers']],
    ['historical-report', ['bedel', 'report', 'existing-run']],
  ])('preserves ordinary task %s and all its security requirements', (nodeId, argv) => {
    const input: TaskDescriptor = {
      schemaVersion: '1.0.0',
      descriptorVersion: 'test',
      repositoryId: 'fixture',
      fallbackNodeId: nodeId,
      dynamicFallbackSelectors: [],
      tasks: [{ ...task(nodeId), argv }],
      profiles: [
        {
          profileId: 'rc',
          mode: 'fixed',
          requiredNodes: [nodeId],
          eligibleNodes: [nodeId],
        },
      ],
    };
    expect(withoutMutationTestTasks(input)).toBe(input);
  });

  it.each([
    ['bedel', 'run', '--all'],
    ['pnpm', 'exec', 'bedel', 'run', '--all'],
    ['bedel', 'resume', 'previous-run'],
    ['pnpm', 'exec', '/tools/bedel', 'resume', 'previous-run'],
    ['pnpm', 'dlx', '@stryker-mutator/core@9.6.1', 'run'],
    ['npx', '@stryker-mutator/core', 'run'],
    ['node', '/tools/stryker.js', 'run'],
    ['pnpm', 'run', 'test:mutation'],
  ])('retires explicit engine invocation %j without executing it', (...argv) => {
    const input: TaskDescriptor = {
      schemaVersion: '1.0.0',
      descriptorVersion: 'test',
      repositoryId: 'fixture',
      fallbackNodeId: 'security-check',
      dynamicFallbackSelectors: [],
      tasks: [{ ...task('security-check'), argv }],
      profiles: [{ profileId: 'rc', mode: 'fixed', requiredNodes: ['security-check'] }],
    };
    const result = withoutMutationTestTasks(input);
    expect(result.tasks).toEqual([]);
    expect(result.fallbackNodeId).toBeNull();
    expect(result.profiles[0]?.requiredNodes).toEqual([]);
  });

  it.each(['toolchain_fixture', 'fixture_context'] as const)(
    'retires explicit %s before any filesystem or Docker access',
    (field) => {
      const input = {
        repository_root: '/path-that-does-not-exist',
        [field]: {},
      } as unknown as ContainerReleaseCertificationOptions;
      expect(() => createContainerReleaseCertificationAdapters(input)).toThrow(
        'MUTATION_OFFLOADED_TO_BEDEL',
      );
      expect(() => createContainerReleasePreflightProvider(input)).toThrow(
        'MUTATION_OFFLOADED_TO_BEDEL',
      );
    },
  );
});
