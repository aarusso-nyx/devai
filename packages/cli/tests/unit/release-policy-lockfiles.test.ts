import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@devai-nyx/utils';
import {
  verifyReleasePackageSnapshot,
  type ReleasePackageIdentity,
} from '../../src/services/release-package-snapshot.js';
import { verifyReleasePolicyLockfiles } from '../../src/services/release-policy-lockfiles.js';

const PACKAGE = '@aarusso-nyx/devai';
const VERSION = '1.4.5';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  target.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'ascii');
  target[offset + length - 1] = 0;
}

function packageArchive(): Buffer {
  const bytes = Buffer.from(`{"name":"${PACKAGE}","version":"${VERSION}"}\n`);
  const header = Buffer.alloc(512);
  header.write('package/package.json', 0, 'utf8');
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, bytes.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  writeOctal(
    header,
    148,
    8,
    header.reduce((sum, byte) => sum + byte, 0),
  );
  return gzipSync(
    Buffer.concat([header, bytes, Buffer.alloc(512 - bytes.byteLength), Buffer.alloc(1024)]),
  );
}

function snapshot() {
  const archive = packageArchive();
  const packageBytes = Buffer.from(`{"name":"${PACKAGE}","version":"${VERSION}"}\n`);
  const manifest = [
    {
      path: 'package.json',
      mode: 0o644,
      size: packageBytes.byteLength,
      sha256: sha256(packageBytes),
    },
  ];
  const expected = {
    name: PACKAGE,
    version: VERSION,
    archive_sha256: sha256(archive),
    content_manifest_sha256: canonicalSha256(manifest),
  } satisfies ReleasePackageIdentity;
  return verifyReleasePackageSnapshot({
    expected,
    archive,
    installed_files: [{ path: 'package.json', mode: 0o644, bytes: packageBytes }],
    installed_directories: [],
    maximum_archive_bytes: archive.byteLength,
    maximum_unpacked_bytes: 8192,
  });
}

function sri(algorithm: 'sha256' | 'sha512' = 'sha512'): string {
  return `${algorithm}-${createHash(algorithm).update(snapshot().readArchive()).digest('base64')}`;
}

function manifest(
  manager: 'npm' | 'pnpm',
  dependencies: Record<string, string> = { [PACKAGE]: VERSION },
): Record<string, unknown> {
  return {
    name: 'fixture-root',
    version: '1.0.0',
    packageManager: `${manager}@${manager === 'npm' ? '10.8.2' : '9.15.4'}`,
    dependencies,
  };
}

function npmLock(
  version: 2 | 3,
  dependencies: Record<string, string> = { [PACKAGE]: VERSION },
  integrity = sri(),
): Record<string, unknown> {
  return {
    name: 'fixture-root',
    version: '1.0.0',
    lockfileVersion: version,
    packages: {
      '': { dependencies },
      [`node_modules/${PACKAGE}`]: {
        version: VERSION,
        integrity,
        ...(dependencies[PACKAGE]?.startsWith('file:') === true
          ? { resolved: dependencies[PACKAGE] }
          : {}),
      },
    },
  };
}

function pnpmLock(
  specifier = VERSION,
  reference = VERSION,
  integrity = sri('sha256'),
  extraImporter: Record<string, unknown> = {},
): string {
  return `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      '${PACKAGE}':
        specifier: ${specifier}
        version: ${reference}
${Object.entries(extraImporter)
  .map(
    ([name, value]) =>
      `      '${name}':\n        specifier: ${String(value)}\n        version: ${String(value)}`,
  )
  .join('\n')}
packages:
  '${PACKAGE}@${reference}':
    ${reference.startsWith('file:') ? `version: ${VERSION}\n    ` : ''}resolution:
      integrity: ${integrity}
`;
}

function verify(files: Record<string, string>, requireInstalled = true) {
  const contents = new Map(Object.entries(files).map(([path, text]) => [path, Buffer.from(text)]));
  return verifyReleasePolicyLockfiles({
    paths: [...contents.keys()],
    read: (path) =>
      Buffer.from(
        contents.get(path) ??
          (() => {
            throw new Error('unreadable');
          })(),
      ),
    installed_package: snapshot(),
    require_installed_dependency: requireInstalled,
  });
}

function expectRefusal(run: () => unknown): void {
  expect(run).toThrow(/^rpl-adopter-binding-mismatch$/u);
}

describe('release policy root lockfiles', () => {
  it.each([2, 3] as const)('binds npm lockfile v%i to the verified archive SRI', (lockVersion) => {
    const root = manifest('npm');
    const result = verify({
      'package.json': JSON.stringify(root),
      'package-lock.json': JSON.stringify(npmLock(lockVersion)),
    });

    expect(result.package_manager).toBe('npm');
    expect(result.lockfiles).toHaveLength(1);
    expect(result.lockfiles[0]?.path).toBe('package-lock.json');
  });

  it('binds npm local tarball declarations to the same immutable archive', () => {
    const local = 'file:../devai-1.4.5.tgz';
    expect(
      verify({
        'package.json': JSON.stringify(manifest('npm', { [PACKAGE]: local })),
        'package-lock.json': JSON.stringify(npmLock(3, { [PACKAGE]: local })),
      }).package_manager,
    ).toBe('npm');
  });

  it('binds pnpm 9 registry and local-tarball identities to the verified archive', () => {
    expect(
      verify({
        'package.json': JSON.stringify(manifest('pnpm')),
        'pnpm-lock.yaml': pnpmLock(),
      }).package_manager,
    ).toBe('pnpm');

    const local = 'file:../devai-1.4.5.tgz';
    expect(
      verify({
        'package.json': JSON.stringify(manifest('pnpm', { [PACKAGE]: local })),
        'pnpm-lock.yaml': pnpmLock(local, local),
      }).package_manager,
    ).toBe('pnpm');
  });

  it('refuses package-root and importer declaration drift, including extra or missing dependencies', () => {
    expectRefusal(() =>
      verify({
        'package.json': JSON.stringify(manifest('npm')),
        'package-lock.json': JSON.stringify(npmLock(3, {})),
      }),
    );
    expectRefusal(() =>
      verify({
        'package.json': JSON.stringify(manifest('pnpm')),
        'pnpm-lock.yaml': pnpmLock(VERSION, VERSION, sri(), { other: '2.0.0' }),
      }),
    );
    expectRefusal(() =>
      verify({
        'package.json': JSON.stringify(manifest('pnpm', {})),
        'pnpm-lock.yaml': pnpmLock(),
      }),
    );
  });

  it('refuses an SRI that does not describe the verified package archive', () => {
    expectRefusal(() =>
      verify({
        'package.json': JSON.stringify(manifest('npm')),
        'package-lock.json': JSON.stringify(
          npmLock(3, { [PACKAGE]: VERSION }, sri().replace(/.$/u, 'A')),
        ),
      }),
    );
  });

  it('binds a declared dual-lock population and refuses disagreement in either lock', () => {
    expect(
      verify({
        'package.json': JSON.stringify(manifest('npm')),
        'package-lock.json': JSON.stringify(npmLock(3)),
        'pnpm-lock.yaml': pnpmLock(),
      }).lockfiles,
    ).toHaveLength(2);
    expectRefusal(() =>
      verify({
        'package.json': JSON.stringify(manifest('npm')),
        'package-lock.json': JSON.stringify(npmLock(3)),
        'pnpm-lock.yaml': pnpmLock(VERSION, VERSION, 'sha512-not-the-archive'),
      }),
    );
  });

  it('refuses ambiguous or unsupported lock-manager populations', () => {
    expectRefusal(() =>
      verify({
        'package.json': JSON.stringify({ ...manifest('npm'), packageManager: 'yarn@4.5.0' }),
        'yarn.lock': 'lockfile v1\n',
      }),
    );
    expectRefusal(() =>
      verify({
        'package.json': JSON.stringify({ ...manifest('npm'), packageManager: undefined }),
        'package-lock.json': JSON.stringify(npmLock(3)),
        'pnpm-lock.yaml': pnpmLock(),
      }),
    );
  });

  it('does not require DEVAI when the producer does not need it, but still binds every root declaration', () => {
    const root = manifest('npm', { leftpad: '1.3.0' });
    expect(
      verify(
        {
          'package.json': JSON.stringify(root),
          'package-lock.json': JSON.stringify(npmLock(2, { leftpad: '1.3.0' })),
        },
        false,
      ).package_manager,
    ).toBe('npm');
    expectRefusal(() =>
      verify(
        {
          'package.json': JSON.stringify(root),
          'package-lock.json': JSON.stringify(npmLock(2, {})),
        },
        false,
      ),
    );
  });
});
