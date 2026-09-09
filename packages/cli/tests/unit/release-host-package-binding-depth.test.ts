import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import type { ReleasePackageSnapshot } from '../../src/services/release-package-snapshot.js';

const originalReadFile = ts.sys.readFile;
const originalFileExists = ts.sys.fileExists;

interface LoadOptions {
  readonly verified?: boolean;
  readonly sensorError?: Error;
  readonly presetError?: Error;
  readonly schemaError?: Error;
  readonly mutationError?: Error;
  readonly runtimePath?: string;
}

async function loadSubject(options: LoadOptions = {}) {
  const bindSchemaPackageSnapshot = vi.fn(() => {
    if (options.schemaError !== undefined) throw options.schemaError;
  });
  const assertBundledSensorRegistry = vi.fn(() => {
    if (options.sensorError !== undefined) throw options.sensorError;
  });
  const assertBundledSensePresets = vi.fn(() => {
    if (options.presetError !== undefined) throw options.presetError;
  });
  const bindMutationEvidenceV21PackageSnapshot = vi.fn(() => {
    if (options.mutationError !== undefined) throw options.mutationError;
  });

  vi.resetModules();
  vi.doMock('@devai-nyx/schemas', () => ({ bindSchemaPackageSnapshot }));
  vi.doMock('@devai-nyx/sensors', () => ({ assertBundledSensorRegistry }));
  vi.doMock('@devai-nyx/sensors/presets', () => ({ assertBundledSensePresets }));
  vi.doMock('../../src/services/mutation-evidence-v21.js', () => ({
    bindMutationEvidenceV21PackageSnapshot,
  }));
  vi.doMock('../../src/services/release-package-snapshot.js', () => ({
    isVerifiedReleasePackageSnapshot: () => options.verified !== false,
  }));
  vi.doMock('node:url', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:url')>()),
    fileURLToPath: () =>
      options.runtimePath ?? '/approved/runtime/index/release-host-package-binding.js',
  }));

  const subject = await import('../../src/services/release-host-package-binding.js');
  return {
    ...subject,
    bindSchemaPackageSnapshot,
    assertBundledSensorRegistry,
    assertBundledSensePresets,
    bindMutationEvidenceV21PackageSnapshot,
  };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function snapshot(
  declarationOverrides: Record<string, unknown> = {},
  byteOverrides: Readonly<Record<string, Buffer>> = {},
): ReleasePackageSnapshot {
  const libraries = {
    'lib.d.ts': Buffer.from('interface Array<T> { readonly length: number }'),
    'lib.es5.d.ts': Buffer.from('interface String { readonly length: number }'),
  };
  const declaration = {
    schemaVersion: '1.0.0',
    compiler_version: ts.version,
    files: Object.entries(libraries).map(([path, bytes]) => ({ path, sha256: sha256(bytes) })),
    ...declarationOverrides,
  };
  const population = new Map<string, Buffer>([
    ['dist/runtime/index/sensor-registry.json', Buffer.from('{"registry":true}')],
    ['dist/runtime/index/sense-presets.json', Buffer.from('{"presets":true}')],
    ['dist/runtime/index/schemas/alpha.json', Buffer.from('{"type":"object"}')],
    ['dist/runtime/index/schemas/nested/beta.json', Buffer.from('{"type":"string"}')],
    ['dist/runtime/index/typescript-libraries.json', Buffer.from(JSON.stringify(declaration))],
    ...Object.entries(libraries)
      .reverse()
      .map(([path, bytes]) => [`dist/runtime/index/${path}`, bytes] as const),
    ['dist/runtime/index/not-lib.d.ts', Buffer.from('lookalike prefix')],
    ['dist/runtime/index/lib.d.ts.extra', Buffer.from('lookalike suffix')],
    ['dist/runtime/other.json', Buffer.from('{}')],
  ]);
  for (const [path, bytes] of Object.entries(byteOverrides)) population.set(path, bytes);
  const manifest = [...population.entries()].map(([path, bytes]) => ({
    path,
    mode: 0o644,
    size: bytes.byteLength,
    sha256: sha256(bytes),
  }));
  return {
    identity: {
      name: '@aarusso-nyx/devai',
      version: '1.5.0',
      archive_sha256: 'a'.repeat(64),
      content_manifest_sha256: 'b'.repeat(64),
    },
    manifest,
    read: (path) => {
      const bytes = population.get(path);
      if (bytes === undefined) throw new Error(`missing fixture member: ${path}`);
      return Buffer.from(bytes);
    },
    readArchive: () => Buffer.from('archive'),
  };
}

afterEach(() => {
  ts.sys.readFile = originalReadFile;
  ts.sys.fileExists = originalFileExists;
  vi.doUnmock('@devai-nyx/schemas');
  vi.doUnmock('@devai-nyx/sensors');
  vi.doUnmock('@devai-nyx/sensors/presets');
  vi.doUnmock('../../src/services/mutation-evidence-v21.js');
  vi.doUnmock('../../src/services/release-package-snapshot.js');
  vi.doUnmock('node:url');
  vi.resetModules();
});

describe('release host package binding depth', () => {
  it('requires a verifier-created snapshot before consuming the one-shot binder', async () => {
    const rejected = await loadSubject({ verified: false });
    const candidate = snapshot();
    expect(() => rejected.assertBoundReleaseHostPackageSnapshot(candidate)).toThrow(
      'rpl-package-identity-mismatch',
    );
    expect(() => rejected.bindReleaseHostPackageSnapshot(candidate)).toThrow(
      'rpl-package-identity-mismatch',
    );
    expect(rejected.assertBundledSensorRegistry).not.toHaveBeenCalled();
  });

  it.each([
    ['sensor registry', { sensorError: new Error('sensor detail') }],
    ['sense presets', { presetError: new Error('preset detail') }],
    ['schema package', { schemaError: new Error('schema detail') }],
    ['mutation evidence', { mutationError: new Error('mutation detail') }],
  ] as const)(
    'closes and consumes binding after a %s composition failure',
    async (_name, options) => {
      const subject = await loadSubject(options);
      const candidate = snapshot();
      expect(() => subject.bindReleaseHostPackageSnapshot(candidate)).toThrow(
        'rpl-package-identity-mismatch',
      );
      expect(() => subject.assertBoundReleaseHostPackageSnapshot(candidate)).toThrow(
        'rpl-package-identity-mismatch',
      );
      expect(() => subject.bindReleaseHostPackageSnapshot(snapshot())).toThrow(
        'rpl-package-identity-mismatch',
      );
    },
  );

  it.each([
    ['schema version', { schemaVersion: '2.0.0' }],
    ['compiler version', { compiler_version: '0.0.0' }],
    ['required default library', { files: [] }],
    [
      'complete ordered population',
      {
        files: [
          { path: 'lib.es5.d.ts', sha256: '0'.repeat(64) },
          { path: 'lib.d.ts', sha256: '0'.repeat(64) },
        ],
      },
    ],
  ])('rejects an invalid compiler-library %s declaration', async (_name, overrides) => {
    const subject = await loadSubject();
    expect(() => subject.bindReleaseHostPackageSnapshot(snapshot(overrides))).toThrow(
      'rpl-package-identity-mismatch',
    );
    expect(subject.bindMutationEvidenceV21PackageSnapshot).not.toHaveBeenCalled();
  });

  it('rejects changed and non-UTF-8 compiler library bytes', async () => {
    const changed = await loadSubject();
    expect(() =>
      changed.bindReleaseHostPackageSnapshot(
        snapshot({}, { 'dist/runtime/index/lib.d.ts': Buffer.from('changed') }),
      ),
    ).toThrow('rpl-package-identity-mismatch');

    ts.sys.readFile = originalReadFile;
    ts.sys.fileExists = originalFileExists;
    const malformed = await loadSubject();
    const bytes = Buffer.from([0xc3, 0x28]);
    expect(() =>
      malformed.bindReleaseHostPackageSnapshot(
        snapshot(
          {
            files: [
              { path: 'lib.d.ts', sha256: sha256(bytes) },
              {
                path: 'lib.es5.d.ts',
                sha256: sha256(Buffer.from('interface String { readonly length: number }')),
              },
            ],
          },
          { 'dist/runtime/index/lib.d.ts': bytes },
        ),
      ),
    ).toThrow('rpl-package-identity-mismatch');
  });

  it.each([
    '/approved/runtime/services/release-host-package-binding.js',
    '/approved/other/index/release-host-package-binding.js',
  ])('rejects a binder loaded from an invalid runtime layout at %s', async (runtimePath) => {
    const subject = await loadSubject({ runtimePath });
    expect(() => subject.bindReleaseHostPackageSnapshot(snapshot())).toThrow(
      'rpl-package-identity-mismatch',
    );
    expect(subject.bindMutationEvidenceV21PackageSnapshot).not.toHaveBeenCalled();
  });

  it('publishes only the exact composed snapshot and serves only bundled compiler libraries', async () => {
    const subject = await loadSubject();
    const candidate = snapshot();
    const delegatedRead = vi.fn(() => 'ambient');
    const delegatedExists = vi.fn(() => true);
    ts.sys.readFile = delegatedRead;
    ts.sys.fileExists = delegatedExists;

    subject.bindReleaseHostPackageSnapshot(candidate);

    expect(() => subject.assertBoundReleaseHostPackageSnapshot(candidate)).not.toThrow();
    expect(() => subject.assertBoundReleaseHostPackageSnapshot({ ...candidate })).toThrow(
      'rpl-package-identity-mismatch',
    );
    expect(subject.assertBundledSensorRegistry).toHaveBeenCalledWith(
      Buffer.from('{"registry":true}'),
    );
    expect(subject.assertBundledSensePresets).toHaveBeenCalledWith(Buffer.from('{"presets":true}'));
    expect(subject.bindSchemaPackageSnapshot).toHaveBeenCalledOnce();
    expect(subject.bindSchemaPackageSnapshot).toHaveBeenCalledWith({
      schemas: new Map([
        ['alpha.json', Buffer.from('{"type":"object"}')],
        ['nested/beta.json', Buffer.from('{"type":"string"}')],
      ]),
      sensor_registry: Buffer.from('{"registry":true}'),
    });
    expect(subject.bindMutationEvidenceV21PackageSnapshot).toHaveBeenCalledWith(candidate);
    expect(ts.sys.readFile('/approved/runtime/index/lib.d.ts')).toContain('interface Array');
    expect(ts.sys.fileExists('/approved/runtime/index/lib.es5.d.ts')).toBe(true);
    expect(ts.sys.readFile('/approved/runtime/index/lib.dom.d.ts')).toBeUndefined();
    expect(ts.sys.fileExists('/approved/runtime/index/lib.dom.d.ts')).toBe(false);
    expect(ts.sys.readFile('/approved/runtime/index/not-lib.d.ts')).toBe('ambient');
    expect(ts.sys.fileExists('/approved/runtime/index/not-lib.d.ts')).toBe(true);
    expect(ts.sys.readFile('/approved/runtime/index/lib.d.ts.extra')).toBe('ambient');
    expect(ts.sys.fileExists('/approved/runtime/index/lib.d.ts.extra')).toBe(true);
    expect(ts.sys.readFile('/candidate/lib.d.ts')).toBe('ambient');
    expect(ts.sys.fileExists('/candidate/lib.d.ts')).toBe(true);
    expect(delegatedRead).toHaveBeenCalledWith('/candidate/lib.d.ts', undefined);
    expect(delegatedExists).toHaveBeenCalledWith('/candidate/lib.d.ts');
    expect(() => subject.bindReleaseHostPackageSnapshot(snapshot())).toThrow(
      'rpl-package-identity-mismatch',
    );
  });
});
