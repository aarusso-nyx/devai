import { describe, expect, it } from 'vitest';
import type { ContainerArchiveEntry } from '../../src/services/container-archive.js';
import type { TaskDescriptor } from '../../src/services/check-runner/types.js';
import { resolveProtectedGeneratedNamespaces } from '../../src/services/release-production-outputs.js';

const INVALID = 'release-certification-output-declaration-invalid';

function entry(
  path: string,
  value: unknown,
  mode: ContainerArchiveEntry['mode'] = '100644',
): ContainerArchiveEntry {
  return {
    path,
    mode,
    bytes: Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(JSON.stringify(value)),
  };
}

function descriptor(generatedNamespaces: unknown, nodeId = 'build-demo'): TaskDescriptor {
  return {
    schemaVersion: '1.0.0',
    descriptorVersion: 'scratch-production-outputs-v1',
    repositoryId: 'aarusso-nyx/devai',
    fallbackNodeId: null,
    dynamicFallbackSelectors: [],
    tasks: [
      {
        nodeId,
        dependencies: [],
        argv: ['pnpm', '--filter', '@scope/demo', 'build'],
        cwd: '.',
        runner: 'process',
        inputSelectors: [],
        toolchainKeys: [],
        allowlistedEnv: [],
        outputContract: { generated_namespaces: generatedNamespaces },
      },
    ],
    profiles: [],
  };
}

function packageDeclaration(requiredArtifacts: unknown = ['NOTICE', 'nested/asset.json']) {
  return {
    derivation: 'devai-package-dist-v1',
    prefix: 'packages/demo/dist',
    package_manifest: 'packages/demo/package.json',
    required_artifacts: requiredArtifacts,
  };
}

function packageSource(): ContainerArchiveEntry[] {
  return [
    entry('README.md', Buffer.from('excluded input')),
    entry('law/policy/example.json', { policy: 'bound' }),
    entry('packages/skills/resources/shared.txt', Buffer.from('shared resource')),
    entry('packages/demo/scripts/postbuild.mjs', Buffer.from('export {};')),
    entry('packages/demo/src/z.ts', Buffer.from('export const z = 1;')),
    entry('packages/demo/src/index.ts', Buffer.from('export const index = 1;')),
    entry('packages/demo/src/cli.ts', Buffer.from('export const cli = 1;'), '100755'),
    entry('packages/demo/src/types.d.ts', Buffer.from('export type T = string;')),
    entry('packages/demo/src/.gitkeep', Buffer.alloc(0)),
    entry('packages/demo/tsconfig.json', {
      extends: '../../tsconfig.base.json',
      compilerOptions: { rootDir: './src', outDir: './dist' },
      include: ['src/**/*'],
    }),
    entry('packages/demo/package.json', {
      name: '@scope/demo',
      private: false,
      scripts: { build: 'tsc -b' },
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': { import: './dist/index.js', types: './dist/index.d.ts' },
        './wildcard': './dist/*.js',
      },
      bin: { demo: './dist/cli.js' },
    }),
    entry('tsconfig.base.json', {
      compilerOptions: {
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        composite: true,
        incremental: true,
        module: 'ESNext',
        target: 'ES2023',
      },
    }),
  ];
}

function replace(
  source: readonly ContainerArchiveEntry[],
  path: string,
  change: (current: ContainerArchiveEntry) => ContainerArchiveEntry,
): ContainerArchiveEntry[] {
  return source.map((current) => (current.path === path ? change(current) : current));
}

describe('release production output namespace derivation', () => {
  it('derives the complete sorted output obligation and ignores wildcard/declaration-only sources', () => {
    const [resolved] = resolveProtectedGeneratedNamespaces(
      descriptor([packageDeclaration()]),
      packageSource(),
    );

    expect(resolved).toMatchObject({
      task_node: 'build-demo',
      prefix: 'packages/demo/dist',
      package_manifest: 'packages/demo/package.json',
      package_id: '@scope/demo',
      execution_only: false,
    });
    expect(resolved?.required_paths).toEqual([
      'packages/demo/dist/NOTICE',
      'packages/demo/dist/cli.d.ts',
      'packages/demo/dist/cli.d.ts.map',
      'packages/demo/dist/cli.js',
      'packages/demo/dist/cli.js.map',
      'packages/demo/dist/index.d.ts',
      'packages/demo/dist/index.d.ts.map',
      'packages/demo/dist/index.js',
      'packages/demo/dist/index.js.map',
      'packages/demo/dist/nested/asset.json',
      'packages/demo/dist/z.d.ts',
      'packages/demo/dist/z.d.ts.map',
      'packages/demo/dist/z.js',
      'packages/demo/dist/z.js.map',
    ]);
    expect(resolved?.required_paths).not.toContain('packages/demo/dist/*.js');
    expect(resolved?.required_paths).not.toContain('packages/demo/dist/types.js');
  });

  it('is invariant to source entry ordering while binding path bytes and executable mode', () => {
    const source = packageSource();
    const declaration = descriptor([packageDeclaration()]);
    const forward = resolveProtectedGeneratedNamespaces(declaration, source);
    const reversed = resolveProtectedGeneratedNamespaces(declaration, [...source].reverse());
    const byteSubstitution = resolveProtectedGeneratedNamespaces(
      declaration,
      replace(source, 'packages/demo/src/index.ts', (current) => ({
        ...current,
        bytes: Buffer.from('export const index = 2;'),
      })),
    );
    const modeSubstitution = resolveProtectedGeneratedNamespaces(
      declaration,
      replace(source, 'packages/demo/src/index.ts', (current) => ({
        ...current,
        mode: '100755',
      })),
    );

    expect(reversed).toEqual(forward);
    expect(byteSubstitution[0]?.required_paths).toEqual(forward[0]?.required_paths);
    expect(byteSubstitution[0]?.input_digest_sha256).not.toBe(forward[0]?.input_digest_sha256);
    expect(modeSubstitution[0]?.input_digest_sha256).not.toBe(forward[0]?.input_digest_sha256);
  });

  it('does not widen the digest boundary for an unrelated extra source path', () => {
    const source = packageSource();
    const declaration = descriptor([packageDeclaration()]);
    const baseline = resolveProtectedGeneratedNamespaces(declaration, source);
    const unrelatedSubstitution = resolveProtectedGeneratedNamespaces(
      declaration,
      replace(source, 'README.md', (current) => ({
        ...current,
        bytes: Buffer.from('different excluded input'),
      })),
    );

    expect(unrelatedSubstitution).toEqual(baseline);
  });

  it('refuses missing contract inputs and an extra pre-existing output under the closed prefix', () => {
    const source = packageSource();
    const declaration = descriptor([packageDeclaration()]);

    expect(() =>
      resolveProtectedGeneratedNamespaces(
        declaration,
        source.filter((current) => current.path !== 'packages/demo/package.json'),
      ),
    ).toThrow(INVALID);
    expect(() =>
      resolveProtectedGeneratedNamespaces(declaration, [
        ...source,
        entry('packages/demo/dist/rogue.js', Buffer.from('pre-existing output')),
      ]),
    ).toThrow(INVALID);
  });

  it('refuses escaping required outputs, unknown derivations, and empty namespace declarations', () => {
    const source = packageSource();

    expect(() =>
      resolveProtectedGeneratedNamespaces(
        descriptor([packageDeclaration(['../escape.js'])]),
        source,
      ),
    ).toThrow(INVALID);
    expect(() =>
      resolveProtectedGeneratedNamespaces(
        descriptor([
          {
            ...packageDeclaration(),
            derivation: 'caller-invented-v1',
          },
        ]),
        source,
      ),
    ).toThrow(INVALID);
    expect(() => resolveProtectedGeneratedNamespaces(descriptor([]), source)).toThrow(INVALID);
  });

  it('refuses duplicate namespace claims across task declarations', () => {
    const source = packageSource();
    const first = descriptor([packageDeclaration()]).tasks[0];
    if (first === undefined) throw new Error('scratch fixture invalid');
    const declaration: TaskDescriptor = {
      ...descriptor([packageDeclaration()]),
      tasks: [
        first,
        {
          ...first,
          nodeId: 'build-demo-again',
        },
      ],
    };

    expect(() => resolveProtectedGeneratedNamespaces(declaration, source)).toThrow(INVALID);
  });
});
