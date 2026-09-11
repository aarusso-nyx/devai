import { describe, expect, it } from 'vitest';
import type { ContainerArchiveEntry } from '../../src/services/container-archive.js';
import type { TaskDescriptor } from '../../src/services/check-runner/types.js';
import { resolveProtectedGeneratedNamespaces } from '../../src/services/release-production-outputs.js';

const INVALID = 'release-certification-output-declaration-invalid';

function entry(path: string, value: unknown): ContainerArchiveEntry {
  return {
    path,
    mode: '100644',
    bytes: Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(JSON.stringify(value)),
  };
}

function descriptor(declaration: unknown): TaskDescriptor {
  return {
    schemaVersion: '1.0.0',
    descriptorVersion: 'package-output-test-v1',
    repositoryId: 'aarusso-nyx/devai',
    fallbackNodeId: null,
    dynamicFallbackSelectors: [],
    tasks: [
      {
        nodeId: 'build-demo',
        dependencies: [],
        argv: ['pnpm', '--filter', '@scope/demo', 'build'],
        cwd: '.',
        runner: 'process',
        inputSelectors: [],
        toolchainKeys: [],
        allowlistedEnv: [],
        outputContract: { generated_namespaces: [declaration] },
      },
    ],
    profiles: [],
  };
}

function baseConfig() {
  return {
    compilerOptions: {
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      composite: true,
      incremental: true,
      module: 'ESNext',
      target: 'ES2023',
    },
  };
}

function declaration(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    derivation: 'devai-package-dist-v1',
    prefix: 'packages/demo/dist',
    package_manifest: 'packages/demo/package.json',
    required_artifacts: ['NOTICE'],
    ...overrides,
  };
}

function packageSource(
  build: unknown = 'tsc -b',
  compilerOptions: Readonly<Record<string, unknown>> = {},
  manifestOverrides: Readonly<Record<string, unknown>> = {},
): ContainerArchiveEntry[] {
  return [
    entry('tsconfig.base.json', baseConfig()),
    entry('packages/demo/src/index.ts', Buffer.from('export const demo = true;')),
    entry('packages/demo/tsconfig.json', {
      extends: '../../tsconfig.base.json',
      compilerOptions: { rootDir: './src', outDir: './dist', ...compilerOptions },
      include: ['src/**/*'],
    }),
    entry('packages/demo/package.json', {
      name: '@scope/demo',
      private: false,
      scripts: { build },
      main: './dist/index.js',
      ...manifestOverrides,
    }),
  ];
}

function replaceJson(
  source: readonly ContainerArchiveEntry[],
  path: string,
  transform: (value: Record<string, unknown>) => unknown,
): ContainerArchiveEntry[] {
  return source.map((current) =>
    current.path === path
      ? entry(
          path,
          transform(JSON.parse(current.bytes.toString('utf8')) as Record<string, unknown>),
        )
      : current,
  );
}

describe('CLI shard 09 release production outputs package contract', () => {
  it('rejects package paths and prefixes that only resemble the closed namespace contract', () => {
    const sourceAt = (root: string, manifestPath = `${root}/package.json`) => [
      entry('tsconfig.base.json', baseConfig()),
      entry(`${root}/src/index.ts`, Buffer.from('export const demo = true;')),
      entry(`${root}/tsconfig.json`, {
        extends: '../../tsconfig.base.json',
        compilerOptions: { rootDir: './src', outDir: './dist' },
        include: ['src/**/*'],
      }),
      entry(manifestPath, {
        name: '@scope/demo',
        private: false,
        scripts: { build: 'tsc -b' },
        main: './dist/index.js',
      }),
    ];

    const prefixLookalikeRoot = 'xpackages/demo';
    const suffixLookalikeRoot = 'packages/demo/package.json';
    const suffixLookalikeManifest = `${suffixLookalikeRoot}ABCDEFGHIJKLM`;
    const prefixMismatchSource = replaceJson(
      packageSource(),
      'packages/demo/package.json',
      (manifest) => {
        const copy = { ...manifest };
        delete copy.main;
        return copy;
      },
    );
    const cases: readonly (readonly [unknown, readonly ContainerArchiveEntry[]])[] = [
      [
        declaration({
          package_manifest: `${prefixLookalikeRoot}/package.json`,
          prefix: `${prefixLookalikeRoot}/dist`,
        }),
        sourceAt(prefixLookalikeRoot),
      ],
      [
        declaration({
          package_manifest: suffixLookalikeManifest,
          prefix: `${suffixLookalikeRoot}/dist`,
        }),
        sourceAt(suffixLookalikeRoot, suffixLookalikeManifest),
      ],
      [declaration({ prefix: 'packages/other/dist' }), prefixMismatchSource],
    ];

    for (const [candidateDeclaration, candidateSource] of cases) {
      expect(() =>
        resolveProtectedGeneratedNamespaces(descriptor(candidateDeclaration), candidateSource),
      ).toThrow(INVALID);
    }
  });
  it('refuses malformed package identity and each incompatible compiler layout', () => {
    const source = packageSource();
    const cases: readonly (readonly [unknown, readonly ContainerArchiveEntry[]])[] = [
      [declaration({ package_manifest: 'other/package.json' }), source],
      [declaration({ package_manifest: 'xpackages/demo/package.json' }), source],
      [declaration({ package_manifest: 'packages/demo/package.json/extra' }), source],
      [declaration({ prefix: 'packages/demo/output' }), source],
      [
        declaration(),
        replaceJson(source, 'packages/demo/package.json', (manifest) => ({
          ...manifest,
          name: 42,
        })),
      ],
      [
        declaration(),
        replaceJson(source, 'packages/demo/tsconfig.json', (config) => ({
          ...config,
          extends: '../tsconfig.base.json',
        })),
      ],
      [declaration(), packageSource('tsc -b', { rootDir: 'src' })],
      [declaration(), packageSource('tsc -b', { outDir: 'dist' })],
      [
        declaration(),
        replaceJson(source, 'packages/demo/tsconfig.json', (config) => ({
          ...config,
          include: ['src/index.ts'],
        })),
      ],
      ...['outFile', 'declarationDir', 'noEmit', 'emitDeclarationOnly', 'tsBuildInfoFile'].map(
        (key) => [declaration(), packageSource('tsc -b', { [key]: true })] as const,
      ),
    ];

    for (const [candidateDeclaration, candidateSource] of cases) {
      expect(() =>
        resolveProtectedGeneratedNamespaces(descriptor(candidateDeclaration), candidateSource),
      ).toThrow(INVALID);
    }
  });

  it('accepts every approved build recipe and preserves public versus private execution custody', () => {
    const builds = [
      'tsc -b',
      'tsc -b && node scripts/copy-law.mjs',
      'tsc -b && node scripts/copy-constitution.mjs && node scripts/copy-policy.mjs',
      'tsc -b --force && node scripts/assemble-package.mjs',
    ] as const;

    for (const build of builds) {
      const [resolved] = resolveProtectedGeneratedNamespaces(
        descriptor(declaration()),
        packageSource(build),
      );
      expect(resolved).toMatchObject({
        package_manifest: 'packages/demo/package.json',
        package_id: '@scope/demo',
        execution_only: false,
      });
    }

    const [privatePackage] = resolveProtectedGeneratedNamespaces(
      descriptor(declaration()),
      packageSource('tsc -b', {}, { private: true }),
    );
    expect(privatePackage?.execution_only).toBe(true);
    expect(() =>
      resolveProtectedGeneratedNamespaces(descriptor(declaration()), packageSource(42)),
    ).toThrow(INVALID);
    expect(() =>
      resolveProtectedGeneratedNamespaces(descriptor(declaration()), packageSource('tsc --build')),
    ).toThrow(INVALID);
  });
});
