import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { enabled } from '../fixtures/mutation-toolchain/subject.js';

const FIXTURE_ROOT = resolve(import.meta.dirname, '../fixtures/mutation-toolchain');
const FIXTURE_FILES = {
  'diagnostic-adoption.json': 'ebb56c73eb5cf8a26ae8c66174c7ebe4a1e4357684474996315881adb25c13c5',
  'fixture-root-gitignore': '8a80263f7b27eeb1fb4bced0d1b9d50b742273f9f16cb2c0ee69727aee42562e',
  'fixture-root-readme.md': '8f200735268e17e6148538ee5079d1fa91de2955c09721ad47c4d60a05040402',
  'root-package.json': 'ebe0ee4f4553fc683d91e269d9f15ee07de7b855e87ba7bfaa4d21b3a4424c95',
  'root-pnpm-workspace.yaml': '477e6c5f8b033a1ecb7f8919ad2726e4328c7893c4ad6228d62471425b22dbe7',
  'subject.ts': 'e136708b60695bb8cedf0148e459840682b3be75b238876df6af042ca23fd939',
  'test-tasks.json': '40a55391b53201a07b76e49e76c591ad0c188eec3b36e66cd7fafca8fa77dd9c',
  'packages/fixture/package.json':
    '75969b3d5453618a0e4a28aedb0822d98d25a8edcc6f30b06e592567fbf58a11',
  'packages/fixture/src/zero.ts':
    'e0e255113e4ee9779b73c9a186e94903b63df448bb8b6c502809d5816494bfa8',
  'packages/fixture/tests/subject.test.ts.fixture':
    '7e1d555e7743b00f82d2372377a2c8b89be02dedf38d0259dd3bf2fa7d0ce5a2',
  'packages/fixture/stryker.config.json':
    '4df182cff11e200a996eccb518775dc3d0c1ccc37b4e016613891a3083cdc713',
  'packages/fixture/tsconfig.json':
    '95034c38b351b89dae9c2212a7f71beed2cce9ccb2a3d992209a887b6cfee318',
  'packages/fixture/vitest.config.cjs':
    '63ae83001abe4d10f9eeabc6a7fb023c25a699a1a2dcb33c838e6548ccbf8feb',
} as const;

const TARGET_PATHS = {
  'diagnostic-adoption.json': 'law/policy/diagnostic-adoption.json',
  'fixture-root-gitignore': '.gitignore',
  'fixture-root-readme.md': 'README.md',
  'root-package.json': 'package.json',
  'root-pnpm-workspace.yaml': 'pnpm-workspace.yaml',
  'subject.ts': 'packages/fixture/src/subject.ts',
  'test-tasks.json': 'test-tasks.json',
  'packages/fixture/package.json': 'packages/fixture/package.json',
  'packages/fixture/src/zero.ts': 'packages/fixture/src/zero.ts',
  'packages/fixture/tests/subject.test.ts.fixture': 'packages/fixture/tests/subject.test.ts',
  'packages/fixture/stryker.config.json': 'packages/fixture/stryker.config.json',
  'packages/fixture/tsconfig.json': 'packages/fixture/tsconfig.json',
  'packages/fixture/vitest.config.cjs': 'packages/fixture/vitest.config.cjs',
} as const;

function bytes(path: keyof typeof FIXTURE_FILES): Buffer {
  return readFileSync(join(FIXTURE_ROOT, path));
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('mutation toolchain fixture', () => {
  it('preserves the original boolean assertions', () => {
    expect(enabled(true)).toBe(1);
    expect(enabled(false)).toBe(0);
  });

  it('retains the exact fixed diagnostic fixture bytes and target mapping', () => {
    for (const [path, expectedDigest] of Object.entries(FIXTURE_FILES)) {
      expect(sha256(bytes(path as keyof typeof FIXTURE_FILES))).toBe(expectedDigest);
    }
    expect(TARGET_PATHS).toEqual({
      'diagnostic-adoption.json': 'law/policy/diagnostic-adoption.json',
      'fixture-root-gitignore': '.gitignore',
      'fixture-root-readme.md': 'README.md',
      'root-package.json': 'package.json',
      'root-pnpm-workspace.yaml': 'pnpm-workspace.yaml',
      'subject.ts': 'packages/fixture/src/subject.ts',
      'test-tasks.json': 'test-tasks.json',
      'packages/fixture/package.json': 'packages/fixture/package.json',
      'packages/fixture/src/zero.ts': 'packages/fixture/src/zero.ts',
      'packages/fixture/tests/subject.test.ts.fixture': 'packages/fixture/tests/subject.test.ts',
      'packages/fixture/stryker.config.json': 'packages/fixture/stryker.config.json',
      'packages/fixture/tsconfig.json': 'packages/fixture/tsconfig.json',
      'packages/fixture/vitest.config.cjs': 'packages/fixture/vitest.config.cjs',
    });
    expect(Object.keys(TARGET_PATHS).sort()).toEqual(Object.keys(FIXTURE_FILES).sort());
  });

  it('pins the fixed diagnostic controls without defining a production release grant', () => {
    const rootPackage = JSON.parse(bytes('root-package.json').toString('utf8')) as {
      readonly packageManager: string;
      readonly dependencies: Readonly<Record<string, string>>;
      readonly pnpm: { readonly overrides: Readonly<Record<string, string>> };
    };
    const stryker = JSON.parse(bytes('packages/fixture/stryker.config.json').toString('utf8')) as {
      readonly mutate: readonly string[];
      readonly plugins: readonly string[];
      readonly thresholds: Readonly<Record<string, number>>;
      readonly jsonReporter: { readonly fileName: string };
      readonly incremental: boolean;
    };
    const descriptor = JSON.parse(bytes('test-tasks.json').toString('utf8')) as {
      readonly repositoryId: string;
      readonly tasks: readonly {
        readonly nodeId: string;
        readonly argv: readonly string[];
        readonly cwd: string;
        readonly runner: string;
        readonly allowlistedEnv: readonly string[];
        readonly outputContract: Readonly<Record<string, unknown>>;
      }[];
    };
    const adoption = JSON.parse(bytes('diagnostic-adoption.json').toString('utf8')) as {
      readonly release_verification: {
        readonly release_unit: string;
        readonly mutation_roster: readonly unknown[];
      };
    };

    expect(rootPackage).toMatchObject({
      packageManager:
        'pnpm@9.15.0+sha512.76e2379760a4328ec4415815bcd6628dee727af3779aaa4c914e3944156c4299921a89f976381ee107d41f12cfa4b66681ca9c718f0668fa0831ed4c6d8ba56c',
      dependencies: {
        '@aarusso-nyx/devai': 'file:host/devai.tgz',
        '@stryker-mutator/core': '9.6.1',
        '@stryker-mutator/typescript-checker': '9.6.1',
        '@stryker-mutator/vitest-runner': '9.6.1',
        typescript: '5.9.3',
        vitest: '4.1.10',
      },
      pnpm: { overrides: { 'qs@6.15.1': '6.16.0' } },
    });
    expect(stryker).toMatchObject({
      mutate: ['src/subject.ts', 'src/zero.ts'],
      plugins: ['@stryker-mutator/vitest-runner', '@stryker-mutator/typescript-checker'],
      thresholds: { break: 60, high: 60, low: 60 },
      jsonReporter: { fileName: 'reports/mutation/raw.json' },
      incremental: false,
    });
    expect(descriptor).toMatchObject({
      repositoryId: 'devai-diagnostic/mutation-toolchain-diagnostic',
      tasks: [
        {
          nodeId: 'diagnostic:mutation-toolchain',
          argv: ['node', '../../host/run-diagnostic.mjs'],
          cwd: 'packages/fixture',
          runner: 'node-v1',
          allowlistedEnv: [],
          outputContract: {
            kind: 'test',
            requiredResult: 'pass',
            git_view: 'candidate-local-shallow-v1',
          },
        },
      ],
    });
    expect(descriptor.tasks).toHaveLength(1);
    expect(Object.keys(descriptor.tasks[0]?.outputContract ?? {})).not.toContain('grant');
    expect(adoption.release_verification.release_unit).toBe('@devai-toolchain/diagnostic');
    expect(adoption.release_verification.mutation_roster).toEqual([]);
  });
});
