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
    descriptorVersion: 'typecheck-output-test-v1',
    repositoryId: 'aarusso-nyx/devai',
    fallbackNodeId: null,
    dynamicFallbackSelectors: [],
    tasks: [
      {
        nodeId: 'typecheck-cli',
        dependencies: [],
        argv: ['pnpm', '--filter', '@devai-nyx/cli', 'typecheck'],
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

function typecheckSource(): ContainerArchiveEntry[] {
  return [
    entry('tsconfig.base.json', baseConfig()),
    entry('packages/cli/tsconfig.json', { extends: '../../tsconfig.base.json' }),
    entry('packages/cli/tsconfig.typecheck.json', {
      extends: './tsconfig.json',
      compilerOptions: {
        outDir: '../../scratch/typecheck/cli',
        tsBuildInfoFile: '../../scratch/typecheck/cli.tsbuildinfo',
      },
    }),
    entry('packages/cli/src/index.ts', Buffer.from('export const cli = true;')),
    entry('packages/cli/src/commands/run.ts', Buffer.from('export const run = true;')),
    entry('packages/cli/src/contracts.d.ts', Buffer.from('export type Contract = string;')),
    entry('packages/cli/src/generated/.gitkeep', Buffer.alloc(0)),
    entry('packages/other/src/ignored.ts', Buffer.from('export const ignored = true;')),
  ];
}

const declaration = {
  derivation: 'devai-cli-typecheck-v1',
  prefix: 'scratch/typecheck/cli',
};

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

describe('CLI shard 09 release production outputs typecheck contract', () => {
  it('derives only emitted CLI outputs and binds every declared typecheck input', () => {
    const source = typecheckSource();
    const [resolved] = resolveProtectedGeneratedNamespaces(descriptor(declaration), source);

    expect(resolved).toMatchObject({
      task_node: 'typecheck-cli',
      prefix: 'scratch/typecheck/cli',
      package_manifest: null,
      package_id: null,
      execution_only: true,
    });
    expect(resolved?.required_paths).toEqual([
      'scratch/typecheck/cli/commands/run.d.ts',
      'scratch/typecheck/cli/commands/run.d.ts.map',
      'scratch/typecheck/cli/commands/run.js',
      'scratch/typecheck/cli/commands/run.js.map',
      'scratch/typecheck/cli/index.d.ts',
      'scratch/typecheck/cli/index.d.ts.map',
      'scratch/typecheck/cli/index.js',
      'scratch/typecheck/cli/index.js.map',
    ]);

    const changedSource = source.map((current) =>
      current.path === 'packages/cli/src/index.ts'
        ? { ...current, bytes: Buffer.from('export const cli = false;') }
        : current,
    );
    expect(
      resolveProtectedGeneratedNamespaces(descriptor(declaration), changedSource)[0]
        ?.input_digest_sha256,
    ).not.toBe(resolved?.input_digest_sha256);

    const changedIgnoredSource = source.map((current) =>
      current.path === 'packages/other/src/ignored.ts'
        ? { ...current, bytes: Buffer.from('export const ignored = false;') }
        : current,
    );
    expect(
      resolveProtectedGeneratedNamespaces(descriptor(declaration), changedIgnoredSource)[0]
        ?.input_digest_sha256,
    ).toBe(resolved?.input_digest_sha256);
  });

  it('refuses every malformed CLI typecheck layout boundary', () => {
    const source = typecheckSource();
    const malformed: readonly (readonly [unknown, readonly ContainerArchiveEntry[]])[] = [
      [{ ...declaration, prefix: 'scratch/typecheck/wrong' }, source],
      [
        declaration,
        replaceJson(source, 'packages/cli/tsconfig.typecheck.json', (config) => ({
          ...config,
          extends: '../wrong.json',
        })),
      ],
      [
        declaration,
        replaceJson(source, 'packages/cli/tsconfig.typecheck.json', (config) => ({
          ...config,
          compilerOptions: {
            ...(config.compilerOptions as object),
            outDir: '../../scratch/typecheck/wrong',
          },
        })),
      ],
      [
        declaration,
        replaceJson(source, 'packages/cli/tsconfig.typecheck.json', (config) => ({
          ...config,
          compilerOptions: {
            ...(config.compilerOptions as object),
            tsBuildInfoFile: '../../scratch/typecheck/wrong.tsbuildinfo',
          },
        })),
      ],
      [
        declaration,
        replaceJson(source, 'packages/cli/tsconfig.typecheck.json', (config) => ({
          ...config,
          compilerOptions: { ...(config.compilerOptions as object), declaration: true },
        })),
      ],
      [
        declaration,
        [...source, entry('packages/cli/src/README.md', Buffer.from('not TypeScript'))],
      ],
    ];

    for (const [candidateDeclaration, candidateSource] of malformed) {
      expect(() =>
        resolveProtectedGeneratedNamespaces(descriptor(candidateDeclaration), candidateSource),
      ).toThrow(INVALID);
    }
  });

  it('refuses each weakened shared compiler invariant', () => {
    const source = typecheckSource();
    const invalidValues: Readonly<Record<string, unknown>> = {
      declaration: false,
      declarationMap: false,
      sourceMap: false,
      composite: false,
      incremental: false,
      module: 'CommonJS',
      target: 'ES2022',
    };

    for (const [key, value] of Object.entries(invalidValues)) {
      const candidate = replaceJson(source, 'tsconfig.base.json', (config) => ({
        ...config,
        compilerOptions: { ...(config.compilerOptions as object), [key]: value },
      }));
      expect(() => resolveProtectedGeneratedNamespaces(descriptor(declaration), candidate)).toThrow(
        INVALID,
      );
    }
  });
});
