import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@devai-nyx/utils';
import {
  isVerifiedReleasePackageSnapshot,
  verifyReleasePackageSnapshot,
  type ReleasePackageFile,
  type ReleasePackageIdentity,
} from '../../src/services/release-package-snapshot.js';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  target.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'ascii');
  target[offset + length - 1] = 0;
}

function splitUstarPath(path: string): { readonly name: string; readonly prefix: string } {
  if (Buffer.byteLength(path, 'utf8') <= 100) return { name: path, prefix: '' };
  const split = path.lastIndexOf('/');
  if (split < 1) throw new Error('fixture path cannot use USTAR prefix');
  const prefix = path.slice(0, split);
  const name = path.slice(split + 1);
  if (Buffer.byteLength(prefix, 'utf8') > 155 || Buffer.byteLength(name, 'utf8') > 100)
    throw new Error('fixture USTAR fields overflow');
  return { name, prefix };
}

type TarEntry = Readonly<{
  path: string;
  mode: number;
  bytes?: Uint8Array;
  type?: number;
  linkname?: string;
}>;

function tarHeader(entry: TarEntry): Buffer {
  const bytes = Buffer.from(entry.bytes ?? []);
  const { name, prefix } = splitUstarPath(entry.path);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, entry.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, bytes.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = entry.type ?? 0x30;
  header.write(entry.linkname ?? '', 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(prefix, 345, 155, 'utf8');
  writeOctal(
    header,
    148,
    8,
    header.reduce((sum, byte) => sum + byte, 0),
  );
  return header;
}

function archive(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const bytes = Buffer.from(entry.bytes ?? []);
    blocks.push(tarHeader(entry), bytes, Buffer.alloc((512 - (bytes.byteLength % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function directories(files: readonly ReleasePackageFile[]): string[] {
  return [
    ...new Set(
      files.flatMap(({ path }) => {
        const parts = path.split('/');
        return Array.from({ length: Math.max(0, parts.length - 1) }, (_, index) =>
          parts.slice(0, index + 1).join('/'),
        );
      }),
    ),
  ].sort();
}

function fixture(entries?: readonly TarEntry[]) {
  const longPath = `package/${'a'.repeat(86)}/file.js`;
  expect(Buffer.byteLength(longPath, 'utf8')).toBe(102);
  const tarEntries: readonly TarEntry[] = entries ?? [
    {
      path: 'package/package.json',
      mode: 0o644,
      bytes: Buffer.from('{"name":"@aarusso-nyx/devai","version":"1.4.5"}\n'),
    },
    { path: longPath, mode: 0o755, bytes: Buffer.from('export const answer = 42;\n') },
    { path: 'package/dist/index.js', mode: 0o644, bytes: Buffer.from('export {};\n') },
  ];
  const compressed = archive(tarEntries);
  const files = tarEntries
    .filter((entry) => (entry.type ?? 0x30) === 0 || (entry.type ?? 0x30) === 0x30)
    .map(
      (entry) =>
        ({
          path: entry.path.slice('package/'.length),
          mode: entry.mode,
          bytes: Buffer.from(entry.bytes ?? []),
        }) satisfies ReleasePackageFile,
    );
  const manifest = files
    .map(({ path, mode, bytes }) => ({ path, mode, size: bytes.byteLength, sha256: sha256(bytes) }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const expected = {
    name: '@aarusso-nyx/devai',
    version: '1.4.5',
    archive_sha256: sha256(compressed),
    content_manifest_sha256: canonicalSha256(manifest),
  } satisfies ReleasePackageIdentity;
  return {
    archive: compressed,
    expected,
    files,
    directories: directories(files),
    manifest,
  };
}

function verify(
  value: ReturnType<typeof fixture>,
  overrides: Partial<Parameters<typeof verifyReleasePackageSnapshot>[0]> = {},
) {
  return verifyReleasePackageSnapshot({
    expected: value.expected,
    archive: value.archive,
    installed_files: value.files,
    installed_directories: value.directories,
    maximum_archive_bytes: value.archive.byteLength,
    maximum_unpacked_bytes: 64 * 1024,
    ...overrides,
  });
}

function expectRefusal(run: () => unknown): void {
  expect(run).toThrow(/^rpl-package-identity-mismatch$/u);
}

describe('release package archive snapshot', () => {
  it('verifies a complete USTAR .tgz population and full raw-byte manifest', () => {
    const value = fixture();
    const snapshot = verify(value);

    expect(snapshot.identity).toEqual(value.expected);
    expect(snapshot.manifest).toEqual(value.manifest);
    expect(snapshot.read('package.json')).toEqual(value.files[0]?.bytes);
    expect(snapshot.read(`${'a'.repeat(86)}/file.js`)).toEqual(value.files[1]?.bytes);
    expect(isVerifiedReleasePackageSnapshot(snapshot)).toBe(true);
    expect(isVerifiedReleasePackageSnapshot({ ...snapshot })).toBe(false);
    expect(
      isVerifiedReleasePackageSnapshot({
        identity: snapshot.identity,
        manifest: snapshot.manifest,
        read: snapshot.read,
      }),
    ).toBe(false);
  });

  it('copies inputs and read buffers so subsequent mutation cannot alter the verified snapshot', () => {
    const value = fixture();
    const archiveBytes = Buffer.from(value.archive);
    const installed = value.files.map((entry) => ({ ...entry, bytes: Buffer.from(entry.bytes) }));
    const snapshot = verify(value, { archive: archiveBytes, installed_files: installed });
    archiveBytes.fill(0);
    installed[0]?.bytes.fill(0);
    value.expected.version = 'mutated';

    const first = snapshot.read('package.json');
    first.fill(0);
    expect(snapshot.identity.version).toBe('1.4.5');
    expect(snapshot.read('package.json')).toEqual(
      Buffer.from('{"name":"@aarusso-nyx/devai","version":"1.4.5"}\n'),
    );
  });

  it.each([
    [
      'missing installed file',
      (value: ReturnType<typeof fixture>) => ({ installed_files: value.files.slice(1) }),
    ],
    [
      'extra installed file',
      (value: ReturnType<typeof fixture>) => ({
        installed_files: [
          ...value.files,
          { path: 'extra.js', mode: 0o644, bytes: Buffer.from('extra') },
        ],
      }),
    ],
    [
      'installed mode drift',
      (value: ReturnType<typeof fixture>) => ({
        installed_files: value.files.map((entry, index) =>
          index === 0 ? { ...entry, mode: 0o755 } : entry,
        ),
      }),
    ],
    [
      'installed byte drift',
      (value: ReturnType<typeof fixture>) => ({
        installed_files: value.files.map((entry, index) =>
          index === 0 ? { ...entry, bytes: Buffer.from('drift') } : entry,
        ),
      }),
    ],
    [
      'an extra installed directory',
      (value: ReturnType<typeof fixture>) => ({
        installed_directories: [...value.directories, 'extra'],
      }),
    ],
    ['a missing installed directory', () => ({ installed_directories: [] })],
  ])('%s refuses', (_label, alteration) => {
    const value = fixture();
    expectRefusal(() => verify(value, alteration(value)));
  });

  it.each([
    [
      'archive digest mismatch',
      (value: ReturnType<typeof fixture>) => ({
        expected: { ...value.expected, archive_sha256: '0'.repeat(64) },
      }),
    ],
    [
      'content manifest mismatch',
      (value: ReturnType<typeof fixture>) => ({
        expected: { ...value.expected, content_manifest_sha256: '0'.repeat(64) },
      }),
    ],
    ['a decompression bound below the USTAR payload', () => ({ maximum_unpacked_bytes: 1024 })],
  ])('%s refuses before exposing a snapshot', (_label, alteration) => {
    const value = fixture();
    expectRefusal(() => verify(value, alteration(value)));
  });

  it.each([
    [
      'duplicate archive paths',
      () =>
        fixture([
          {
            path: 'package/package.json',
            mode: 0o644,
            bytes: Buffer.from('{"name":"@aarusso-nyx/devai","version":"1.4.5"}'),
          },
          { path: 'package/package.json', mode: 0o644, bytes: Buffer.from('duplicate') },
        ]),
    ],
    [
      'an escaping archive path',
      () =>
        fixture([
          {
            path: 'package/package.json',
            mode: 0o644,
            bytes: Buffer.from('{"name":"@aarusso-nyx/devai","version":"1.4.5"}'),
          },
          { path: 'package/../escape.js', mode: 0o644, bytes: Buffer.from('escape') },
        ]),
    ],
    [
      'a linked archive entry',
      () =>
        fixture([
          {
            path: 'package/package.json',
            mode: 0o644,
            bytes: Buffer.from('{"name":"@aarusso-nyx/devai","version":"1.4.5"}'),
          },
          { path: 'package/link.js', mode: 0o644, type: 0x32, linkname: 'package.json' },
        ]),
    ],
    [
      'a non-regular archive entry',
      () =>
        fixture([
          {
            path: 'package/package.json',
            mode: 0o644,
            bytes: Buffer.from('{"name":"@aarusso-nyx/devai","version":"1.4.5"}'),
          },
          { path: 'package/device', mode: 0o644, type: 0x33 },
        ]),
    ],
  ])('%s is rejected without extraction', (_label, build) => {
    expectRefusal(() => verify(build()));
  });
});
