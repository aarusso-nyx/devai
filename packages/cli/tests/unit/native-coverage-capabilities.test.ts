// Finite syntax and selection admission only; these checks do not execute or attest a runner.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assertNativeConfigCapabilities } from '../../src/commands/sense/native-config-capabilities.js';
import { nativeRunnerSelection } from '../../src/commands/sense/native-runner-selection.js';
import type { NativeTestResultContract } from '../../src/commands/sense/native-test-results.js';
import type { PlannedTask } from '../../src/services/check-runner/types.js';
import { trackedPaths } from '../../src/services/check-runner/policy-git.js';
import { installNativeVitest } from '../fixtures/native-test-results/native-runner-fixture.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const roots: string[] = [];
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function put(root: string, path: string, value: string | object) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai coverage syntax ç ')));
  roots.push(root);
  put(root, 'package.json', { name: 'native-coverage-admission', type: 'module' });
  return root;
}
function packageLink(root: string, name: string, target: string) {
  mkdirSync(dirname(join(root, 'node_modules', name)), { recursive: true });
  symlinkSync(target, join(root, 'node_modules', name), 'dir');
}
const scan = (root: string, text: string) => {
  put(root, 'config.mjs', text);
  return assertNativeConfigCapabilities(root, 'config.mjs');
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('finite native coverage import capabilities', () => {
  it.each([
    'createNativeCoverageAdapter',
    'createNativeCoverageAdapter as createOwnedCompiler',
    'isProxy',
    'sameNativeData as compareOwnedData',
    'createNativeCoverageAdapter, isProxy, sameNativeData',
  ])('admits only the public named factory (%s) without evaluating configuration', (binding) => {
    const root = fixture();
    const result = scan(
      root,
      `import {${binding}} from '@aarusso-nyx/devai/native-coverage-adapter'; throw new Error('must not execute');`,
    );
    expect(result.adapterImporters).toEqual(['config.mjs']);
    expect(result.packageManifests).toEqual([]);
  });
  it.each([
    "import factory from '@aarusso-nyx/devai/native-coverage-adapter';",
    "import * as factory from '@aarusso-nyx/devai/native-coverage-adapter';",
    "import { createNativeCoverageAdapter, installContext } from '@aarusso-nyx/devai/native-coverage-adapter';",
    "import '@aarusso-nyx/devai/native-coverage-adapter';",
    "await import('@aarusso-nyx/devai/native-coverage-adapter');",
    "const factory = require('@aarusso-nyx/devai/native-coverage-adapter');",
    "export { createNativeCoverageAdapter } from '@aarusso-nyx/devai/native-coverage-adapter';",
    "export * from '@aarusso-nyx/devai/native-coverage-adapter';",
  ])('refuses broader adapter acquisition: %s', (text) => {
    expect(() => scan(fixture(), text)).toThrow(
      'SENSE_NATIVE_CONFIG_COVERAGE_ADAPTER_IMPORT_UNSUPPORTED',
    );
  });
  it('admits the actual pinned V8 provider root/default and exact provider-class imports', () => {
    const root = fixture();
    const provider = realpathSync(join(ROOT, 'node_modules/@vitest/coverage-v8/package.json'));
    const vitest = realpathSync(createRequire(provider).resolve('vitest/package.json'));
    packageLink(root, '@vitest/coverage-v8', dirname(provider));
    packageLink(root, 'vitest', dirname(vitest));
    const result = scan(
      root,
      "import provider from '@vitest/coverage-v8'; import {V8CoverageProvider as NativeProvider} from '@vitest/coverage-v8/dist/provider.js';",
    );
    expect(result.coverageProviderManifests).toEqual([provider]);
    expect([...result.packageManifests].sort()).toEqual([provider, vitest].sort());
  });
  it.each([
    "import { V8CoverageProvider } from '@vitest/coverage-v8';",
    "import * as provider from '@vitest/coverage-v8';",
    "import provider from '@vitest/coverage-v8/dist/provider.js';",
    "import { V8CoverageProvider, unsafe } from '@vitest/coverage-v8/dist/provider.js';",
    "await import('@vitest/coverage-v8');",
  ])('refuses unsupported coverage provider acquisition: %s', (text) => {
    expect(() => scan(fixture(), text)).toThrow(
      'SENSE_NATIVE_CONFIG_COVERAGE_PROVIDER_IMPORT_UNSUPPORTED',
    );
  });
  it('refuses mismatched pinned provider versions before executing any package', () => {
    const root = fixture();
    put(root, 'node_modules/@vitest/coverage-v8/package.json', {
      name: '@vitest/coverage-v8',
      version: '4.1.10',
    });
    expect(() => scan(root, "import provider from '@vitest/coverage-v8';")).toThrow(
      'SENSE_NATIVE_CONFIG_PACKAGE_VERSION_UNSUPPORTED',
    );
  });
  it('refuses a provider resolving a different physical Vitest instance', () => {
    const root = fixture();
    put(root, 'node_modules/@vitest/coverage-v8/package.json', {
      name: '@vitest/coverage-v8',
      version: '4.1.11',
    });
    put(root, 'node_modules/@vitest/coverage-v8/node_modules/vitest/package.json', {
      name: 'vitest',
      version: '4.1.11',
    });
    put(root, 'node_modules/vitest/package.json', { name: 'vitest', version: '4.1.11' });
    expect(() => scan(root, "import provider from '@vitest/coverage-v8';")).toThrow(
      'SENSE_NATIVE_CONFIG_COVERAGE_PROVIDER_INSTANCE_MISMATCH',
    );
  });
  it('admits exactly named codec decode/encode with the required manifest version', () => {
    const root = fixture();
    put(root, 'node_modules/@jridgewell/sourcemap-codec/package.json', {
      name: '@jridgewell/sourcemap-codec',
      version: '1.6.0',
    });
    const result = scan(
      root,
      "import {decode as readMap, encode} from '@jridgewell/sourcemap-codec';",
    );
    expect(result.packageManifests).toEqual([
      join(root, 'node_modules/@jridgewell/sourcemap-codec/package.json'),
    ]);
  });
  it.each([
    "import codec from '@jridgewell/sourcemap-codec';",
    "import * as codec from '@jridgewell/sourcemap-codec';",
    "import {decode, unsafe} from '@jridgewell/sourcemap-codec';",
    "await import('@jridgewell/sourcemap-codec');",
  ])('refuses broader codec acquisition: %s', (text) => {
    expect(() => scan(fixture(), text)).toThrow(
      'SENSE_NATIVE_CONFIG_SOURCEMAP_CODEC_IMPORT_UNSUPPORTED',
    );
  });
  it('refuses codec version drift', () => {
    const root = fixture();
    put(root, 'node_modules/@jridgewell/sourcemap-codec/package.json', {
      name: '@jridgewell/sourcemap-codec',
      version: '1.5.5',
    });
    expect(() => scan(root, "import {decode} from '@jridgewell/sourcemap-codec';")).toThrow(
      'SENSE_NATIVE_CONFIG_PACKAGE_VERSION_UNSUPPORTED',
    );
  });
});

describe('finite coverage CLI selection', () => {
  let root: string;
  let task: PlannedTask;
  const contract: NativeTestResultContract = {
    schemaVersion: '1.0.0',
    format: 'vitest-json',
    projectId: 'coverage-fixture',
    transport: { kind: 'direct' },
    executableFiles: ['tests/one.test.ts'],
    requiredTestIds: [],
    selectionEvidence: { kind: 'devai-native-collection', reporter: 'vitest-v1', projectName: '' },
  };
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'devai coverage flags ç ')));
    put(root, 'package.json', {
      name: 'native-coverage-flags',
      type: 'module',
      dependencies: { vitest: '4.1.11', '@aarusso-nyx/devai': '2.6.0' },
    });
    put(root, '.gitignore', 'node_modules/\n');
    put(root, 'vitest.config.mjs', 'export default {test:{include:["tests/one.test.ts"]}};\n');
    put(root, 'tests/one.test.ts', "import {test} from 'vitest';test('one',()=>{});\n");
    installNativeVitest(ROOT, root);
    packageLink(root, '@aarusso-nyx/devai', join(ROOT, 'packages/cli'));
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'core.fsmonitor=false',
          '-c',
          'maintenance.auto=false',
          '-c',
          'gc.auto=0',
          '-c',
          'user.name=Inspector Fixture',
          '-c',
          'user.email=inspector@devai.local',
          '-c',
          'commit.gpgsign=false',
          '-c',
          'core.hooksPath=/dev/null',
          ...args,
        ],
        { cwd: root, encoding: 'utf8' },
      );
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'fixture inputs');
    const executable = realpathSync(join(root, 'node_modules/vitest/vitest.mjs'));
    task = {
      nodeId: 'native',
      taskKey: 'fixture',
      dependencies: [],
      outputContract: {},
      cwd: '.',
      argv: [
        'vitest',
        'run',
        '--configLoader',
        'native',
        '--config',
        './vitest.config.mjs',
        '--reporter',
        '@aarusso-nyx/devai/native-vitest-reporter',
      ],
      executable: { path: executable, sha256: sha(readFileSync(executable)) },
      inputDigest: 'fixture',
      inputPaths: trackedPaths(root),
      matchedChangedPaths: [],
      cacheState: 'execute',
      reason: 'test fixture',
    };
  });
  afterAll(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });
  it('admits explicit finite coverage flags with the required native collection reporter', () => {
    const baseline = nativeRunnerSelection(root, task, contract);
    const covered = nativeRunnerSelection(
      root,
      {
        ...task,
        argv: [
          ...task.argv,
          '--coverage',
          '--coverage.reporter=json',
          '--coverage.reporter=json-summary',
        ],
      },
      contract,
    );
    expect(baseline).toMatch(/^[0-9a-f]{64}$/u);
    expect(covered).toMatch(/^[0-9a-f]{64}$/u);
  });
  it.each(['identical', 'changed-helper', 'canonical-preload-link'] as const)(
    'refuses a %s physical adapter copy',
    (kind) => {
      const copiedRoot = realpathSync(mkdtempSync(join(tmpdir(), 'devai copied adapter ç ')));
      const local = join(copiedRoot, 'node_modules/@aarusso-nyx/devai');
      const originalConfig = readFileSync(join(root, 'vitest.config.mjs'));
      const source = join(ROOT, 'packages/cli');
      try {
        put(
          root,
          'vitest.config.mjs',
          "import {isProxy} from '@aarusso-nyx/devai/native-coverage-adapter'; export default {test:{include:['tests/one.test.ts']}};\n",
        );
        expect(nativeRunnerSelection(root, task, contract)).toMatch(/^[0-9a-f]{64}$/u);
        // Use a fresh resolver root: Node caches the real target of an earlier package symlink.
        cpSync(root, copiedRoot, { recursive: true });
        rmSync(local);
        put(local, 'package.json', readFileSync(join(source, 'package.json'), 'utf8'));
        cpSync(join(source, 'dist/runtime/index'), join(local, 'dist/runtime/index'), {
          recursive: true,
        });
        symlinkSync(join(source, 'node_modules'), join(local, 'node_modules'), 'dir');
        if (kind === 'changed-helper') {
          const helper = join(local, 'dist/runtime/index/native-coverage-data.js');
          writeFileSync(helper, `${readFileSync(helper, 'utf8')}\n// changed finite helper\n`);
        }
        if (kind === 'canonical-preload-link') {
          const copiedPreload = join(local, 'dist/runtime/index/native-input-provenance.js');
          rmSync(copiedPreload);
          symlinkSync(join(source, 'dist/runtime/index/native-input-provenance.js'), copiedPreload);
        }
        expect(
          createRequire(join(copiedRoot, 'vitest.config.mjs')).resolve(
            '@aarusso-nyx/devai/native-coverage-adapter',
          ),
        ).toBe(join(local, 'dist/runtime/index/native-coverage-adapter.js'));
        const executable = realpathSync(join(copiedRoot, 'node_modules/vitest/vitest.mjs'));
        const copiedTask = {
          ...task,
          executable: { path: executable, sha256: sha(readFileSync(executable)) },
        };
        expect(() => nativeRunnerSelection(copiedRoot, copiedTask, contract)).toThrow(
          kind === 'changed-helper'
            ? 'SENSE_NATIVE_COVERAGE_ADAPTER_BYTES_MISMATCH'
            : 'SENSE_NATIVE_COVERAGE_ADAPTER_INSTANCE_MISMATCH',
        );
      } finally {
        rmSync(copiedRoot, { recursive: true, force: true });
        writeFileSync(join(root, 'vitest.config.mjs'), originalConfig);
      }
    },
  );
  it.each([
    ['--coverage', '--coverage'],
    ['--coverage.reporter=json'],
    ['--coverage', '--coverage.reporter=json', '--coverage.reporter=json'],
    ['--coverage', '--coverage.reporter=json-summary', '--coverage.reporter=json-summary'],
  ])('refuses conflicting/incomplete coverage arguments %j (case %#)', (...flags) => {
    expect(() =>
      nativeRunnerSelection(root, { ...task, argv: [...task.argv, ...flags] }, contract),
    ).toThrow('SENSE_NATIVE_COVERAGE_SELECTION_INVALID');
  });
  it.each([
    '--coverage.reporter=html',
    '--coverage.enabled=false',
    '--coverage.provider=custom',
    '--coverage.include=src/one.ts',
    '--coverage.all=false',
  ])('refuses unsupported coverage selection %s', (flag) => {
    expect(() =>
      nativeRunnerSelection(root, { ...task, argv: [...task.argv, '--coverage', flag] }, contract),
    ).toThrow('SENSE_NATIVE_SELECTION_UNSUPPORTED');
  });
});
