import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../../utils/src/canonical-json/index.js';
import {
  captureReleaseHostCandidate,
  captureReleaseHostPackage,
  type ReleaseHostCandidateControls,
  type ReleaseHostPackageControls,
} from '../../src/services/release-policy-host-snapshot.js';
import {
  isVerifiedReleaseCandidateSnapshot,
  verifyReleaseCandidateSnapshot,
} from '../../src/services/release-candidate-snapshot.js';
import { isVerifiedReleasePackageSnapshot } from '../../src/services/release-package-snapshot.js';

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `devai-${label}-`));
  scratchRoots.push(root);
  return root;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  target.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'ascii');
  target[offset + length - 1] = 0;
}

interface TarEntry {
  readonly path: string;
  readonly mode: number;
  readonly bytes: Buffer;
}

function archive(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, 'utf8');
    writeOctal(header, 100, 8, entry.mode);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.bytes.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    writeOctal(
      header,
      148,
      8,
      header.reduce((sum, byte) => sum + byte, 0),
    );
    blocks.push(header, entry.bytes, Buffer.alloc((512 - (entry.bytes.byteLength % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function packageFixture() {
  const root = temporaryRoot('host-package');
  const packageJson = Buffer.from('{"name":"@aarusso-nyx/devai","version":"1.5.0"}\n');
  const runtime = Buffer.from('export const marker = "captured";\n');
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'package.json'), packageJson);
  writeFileSync(join(root, 'dist', 'index.js'), runtime);
  chmodSync(join(root, 'package.json'), 0o644);
  chmodSync(join(root, 'dist', 'index.js'), 0o755);

  const entries: TarEntry[] = [
    { path: 'package/package.json', mode: 0o644, bytes: packageJson },
    { path: 'package/dist/index.js', mode: 0o755, bytes: runtime },
  ];
  const compressed = archive(entries);
  const manifest = entries
    .map((entry) => ({
      path: entry.path.slice('package/'.length),
      mode: entry.mode,
      size: entry.bytes.byteLength,
      sha256: sha256(entry.bytes),
    }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const controls: ReleaseHostPackageControls = {
    package_root: root,
    expected: {
      name: '@aarusso-nyx/devai',
      version: '1.5.0',
      archive_sha256: sha256(compressed),
      content_manifest_sha256: canonicalSha256(manifest),
    },
    archive: compressed,
    maximum_archive_bytes: compressed.byteLength,
    maximum_unpacked_bytes: 64 * 1024,
    maximum_entries: 3,
    maximum_depth: 1,
  };
  return { controls, packageJson, runtime };
}

function expectPackageRefusal(run: () => unknown): void {
  expect(run).toThrow(/^rpl-package-identity-mismatch$/u);
}

function resolveSystemGit(): string {
  if (process.platform === 'darwin') {
    return execFileSync('/usr/bin/xcrun', ['-f', 'git'], { encoding: 'utf8' }).trim();
  }
  for (const directory of (process.env['PATH'] ?? '').split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, 'git');
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue through the caller's explicit executable search path.
    }
  }
  throw new Error('git executable unavailable for release snapshot fixture');
}

const SYSTEM_GIT = resolveSystemGit();

function git(repo: string, args: readonly string[]): string {
  return execFileSync(SYSTEM_GIT, ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function candidateFixture() {
  const hostRoot = temporaryRoot('host-candidate');
  const repo = join(hostRoot, 'repository');
  mkdirSync(repo);
  git(repo, ['init', '-q']);
  writeFileSync(join(repo, 'package.json'), '{"name":"fixture"}\n');
  writeFileSync(join(repo, 'run.sh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(repo, 'run.sh'), 0o755);
  symlinkSync('package.json', join(repo, 'linked'));
  git(repo, ['add', '-A']);
  git(repo, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  const commit = git(repo, ['rev-parse', 'HEAD']);
  const tree = git(repo, ['rev-parse', 'HEAD^{tree}']);
  const linkedBlob = git(repo, ['rev-parse', 'HEAD:linked']);
  const controls: ReleaseHostCandidateControls = {
    repository_root: repo,
    repository: { id: 'fixture/repository', commit, tree },
    git: {
      executable: SYSTEM_GIT,
      sha256: sha256(readFileSync(SYSTEM_GIT)),
      maximum_executable_bytes: 8 * 1024 * 1024,
    },
    maximum_bytes: 1024 * 1024,
    maximum_entries: 16,
    timeout_ms: 10_000,
  };
  return { controls, linkedBlob };
}

function expectCandidateRefusal(run: () => unknown): void {
  expect(run).toThrow(/^rpl-policy-resolution-mismatch$/u);
}

describe('release policy host package capture boundaries', () => {
  it('captures an exact installation and returns defensive archive/file copies', () => {
    const { controls, packageJson, runtime } = packageFixture();
    const capture = captureReleaseHostPackage(controls);

    expect(capture.root).toBe(realpathSync(controls.package_root));
    expect(isVerifiedReleasePackageSnapshot(capture.snapshot)).toBe(true);
    expect(capture.snapshot.read('package.json')).toEqual(packageJson);
    expect(capture.snapshot.read('dist/index.js')).toEqual(runtime);
    expect(capture.snapshot.manifest.map(({ path }) => path)).toEqual([
      'dist/index.js',
      'package.json',
    ]);

    const first = capture.readVerificationInput();
    first.archive.fill(0);
    first.installed_files[0]?.bytes.fill(0);
    const second = capture.readVerificationInput();
    expect(second.archive).toEqual(controls.archive);
    expect(second.installed_files.map(({ path }) => path)).toEqual([
      'dist/index.js',
      'package.json',
    ]);
    expect(second.installed_files.find(({ path }) => path === 'package.json')?.bytes).toEqual(
      packageJson,
    );
  });

  it.each([
    [
      'archive bytes below the exact bound',
      (value: ReturnType<typeof packageFixture>) => ({
        maximum_archive_bytes: value.controls.archive.byteLength - 1,
      }),
    ],
    ['unpacked limit below the 1024-byte floor', () => ({ maximum_unpacked_bytes: 1023 })],
    ['population one below two files plus one directory', () => ({ maximum_entries: 2 })],
    ['depth below the nested dist directory', () => ({ maximum_depth: 0 })],
    ['a non-absolute trusted root', () => ({ package_root: 'relative/package' })],
    ['a mismatched archive digest', () => ({ expected: { archive_sha256: '0'.repeat(64) } })],
  ])('refuses %s with only the canonical package code', (_label, alteration) => {
    const value = packageFixture();
    const patch = alteration(value);
    const expected =
      'expected' in patch
        ? { ...value.controls.expected, ...patch.expected }
        : value.controls.expected;
    expectPackageRefusal(() =>
      captureReleaseHostPackage({ ...value.controls, ...patch, expected }),
    );
  });

  it.each([
    [
      'a forbidden colon in a directory entry',
      (root: string) => writeFileSync(join(root, 'bad:name'), 'bad'),
    ],
    ['a symbolic-link member', (root: string) => symlinkSync('package.json', join(root, 'linked'))],
    [
      'a multiply linked regular file',
      (root: string) => linkSync(join(root, 'package.json'), join(root, 'hardlink')),
    ],
  ])('refuses %s before package verification', (_label, arrange) => {
    const value = packageFixture();
    arrange(value.controls.package_root);
    expectPackageRefusal(() => captureReleaseHostPackage(value.controls));
  });
});

describe('release policy host candidate capture boundaries', () => {
  it('captures raw commit/tree/regular blobs while leaving symlink bytes unreadable', () => {
    const { controls, linkedBlob } = candidateFixture();
    const verification = captureReleaseHostCandidate(controls);
    const totalBytes = [...verification.objects.values()].reduce(
      (sum, object) => sum + object.bytes.byteLength,
      0,
    );
    const snapshot = verifyReleaseCandidateSnapshot(verification);

    expect(isVerifiedReleaseCandidateSnapshot(snapshot)).toBe(true);
    expect(snapshot.repository).toEqual(controls.repository);
    expect(snapshot.paths).toEqual(['linked', 'package.json', 'run.sh']);
    expect(snapshot.read('package.json')).toEqual(Buffer.from('{"name":"fixture"}\n'));
    expectCandidateRefusal(() => snapshot.read('linked'));
    expect(verification.objects.has(linkedBlob)).toBe(false);

    const exact = captureReleaseHostCandidate({ ...controls, maximum_bytes: totalBytes });
    expect(
      [...exact.objects.values()].reduce((sum, object) => sum + object.bytes.byteLength, 0),
    ).toBe(totalBytes);
    expectCandidateRefusal(() =>
      captureReleaseHostCandidate({ ...controls, maximum_bytes: totalBytes - 1 }),
    );
  });

  it('enforces the complete fetched-object census at its exact boundary', () => {
    const { controls } = candidateFixture();
    const captured = captureReleaseHostCandidate(controls);
    const objectCount = captured.objects.size;

    expect(
      captureReleaseHostCandidate({ ...controls, maximum_entries: objectCount }).objects.size,
    ).toBe(objectCount);
    expectCandidateRefusal(() =>
      captureReleaseHostCandidate({ ...controls, maximum_entries: objectCount - 1 }),
    );
  });

  it.each([
    ['a zero collection deadline', () => ({ timeout_ms: 0 })],
    ['a non-absolute repository root', () => ({ repository_root: 'relative/repository' })],
    ['a non-absolute Git executable', () => ({ git: { executable: 'git' } })],
    ['a malformed Git digest', () => ({ git: { sha256: 'A'.repeat(64) } })],
    ['a mismatched Git digest', () => ({ git: { sha256: '0'.repeat(64) } })],
    [
      'mixed commit and tree object formats',
      (value: ReturnType<typeof candidateFixture>) => ({
        repository: { tree: value.controls.repository.tree.padEnd(64, '0') },
      }),
    ],
  ])('refuses %s with only the canonical candidate code', (_label, alteration) => {
    const value = candidateFixture();
    const patch = alteration(value);
    const repository =
      'repository' in patch
        ? { ...value.controls.repository, ...patch.repository }
        : value.controls.repository;
    const gitControl =
      'git' in patch ? { ...value.controls.git, ...patch.git } : value.controls.git;
    expectCandidateRefusal(() =>
      captureReleaseHostCandidate({ ...value.controls, ...patch, repository, git: gitControl }),
    );
  });
});
