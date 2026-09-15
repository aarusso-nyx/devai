import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { canonicalSha256 } from '@devai-nyx/utils';

export interface ReleasePackageIdentity {
  readonly name: '@aarusso-nyx/devai';
  readonly version: string;
  readonly archive_sha256: string;
  readonly content_manifest_sha256: string;
}

export interface ReleasePackageFile {
  readonly path: string;
  readonly mode: number;
  readonly bytes: Uint8Array;
}

export interface ReleasePackageSnapshot {
  readonly identity: ReleasePackageIdentity;
  readonly manifest: readonly {
    readonly path: string;
    readonly mode: number;
    readonly size: number;
    readonly sha256: string;
  }[];
  readonly read: (path: string) => Buffer;
  readonly readArchive: () => Buffer;
}

export interface ReleaseHostArchiveControls {
  readonly expected: ReleasePackageIdentity;
  readonly archive: Uint8Array;
  readonly maximum_archive_bytes: number;
  readonly maximum_unpacked_bytes: number;
  /** Complete file/ancestor-directory population, excluding the package root. */
  readonly maximum_entries: number;
  /** Directory depth below the package root, matching host capture semantics. */
  readonly maximum_depth: number;
}

/** Checked archive data only: this is NOT a verified installation or loaded runtime. */
export interface ReleaseHostArchiveProjection {
  readonly identity: ReleasePackageIdentity;
  readonly manifest: ReleasePackageSnapshot['manifest'];
  readonly directories: readonly string[];
  readonly read: (path: string) => Buffer;
  readonly readArchive: () => Buffer;
  /** Exact bounded uncompressed USTAR bytes accepted by the parser; never re-encoded. */
  readonly readTar: () => Buffer;
}

const INVALID = 'rpl-package-identity-mismatch';
const DIGEST = /^[a-f0-9]{64}$/u;
const verifiedSnapshots = new WeakSet<object>();

/** An object-shaped claim is not a snapshot verified by this running implementation. */
export function isVerifiedReleasePackageSnapshot(value: unknown): value is ReleasePackageSnapshot {
  return value !== null && typeof value === 'object' && verifiedSnapshots.has(value);
}

function fail(): never {
  throw new Error(INVALID);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function portablePath(path: string): boolean {
  return (
    path.length > 0 &&
    Buffer.from(path, 'utf8').toString('utf8') === path &&
    !/[\\:*?]/u.test(path) &&
    ![...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function field(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const nul = raw.indexOf(0);
  const content = nul < 0 ? raw : raw.subarray(0, nul);
  if (nul >= 0 && raw.subarray(nul).some((byte) => byte !== 0)) return fail();
  const value = content.toString('utf8');
  return Buffer.from(value, 'utf8').equals(content) ? value : fail();
}

function octal(block: Buffer, offset: number, length: number): number {
  const text = block.subarray(offset, offset + length).toString('utf8');
  if (!/^ *[0-7]+[\0 ]*$/u.test(text)) return fail();
  const value = Number.parseInt(text.replaceAll('\0', '').trim(), 8);
  return Number.isSafeInteger(value) && value >= 0 ? value : fail();
}

/** Read a package archive into memory only; never extract or execute its contents. */
function archiveFiles(
  archive: Buffer,
  maximumBytes: number,
  limits?: Pick<ReleaseHostArchiveControls, 'maximum_entries' | 'maximum_depth'>,
) {
  const bytes = gunzipSync(archive, { maxOutputLength: maximumBytes });
  if (bytes.length % 512 !== 0 || bytes.length < 1024) return fail();
  const files: ReleasePackageFile[] = [];
  const seen = new Set<string>();
  const directories = new Set<string>();
  const ancestors = new Set<string>(['package']);
  const populationPaths = new Set<string>();
  let offset = 0;
  let terminated = false;
  while (offset + 512 <= bytes.length) {
    const block = bytes.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) {
      if (bytes.length - offset < 1024 || bytes.subarray(offset).some((byte) => byte !== 0))
        return fail();
      terminated = true;
      break;
    }
    const checksum = block.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (octal(block, 148, 8) !== checksum || field(block, 257, 6) !== 'ustar') return fail();
    const prefix = field(block, 345, 155);
    let path = `${prefix === '' ? '' : `${prefix}/`}${field(block, 0, 100)}`;
    const type = block[156];
    const size = octal(block, 124, 12);
    const end = offset + 512 + size;
    const next = end + ((512 - (size % 512)) % 512);
    if (next > bytes.length || field(block, 157, 100) !== '') return fail();
    if (bytes.subarray(end, next).some((byte) => byte !== 0)) return fail();
    if (type === 0x35 && path.endsWith('/')) path = path.slice(0, -1);
    if (!portablePath(path) || seen.has(path)) return fail();
    const isDirectory = type === 0x35;
    if (
      isDirectory
        ? path !== 'package' && !path.startsWith('package/')
        : !path.startsWith('package/')
    )
      return fail();
    const parts = path.split('/');
    const depth = parts.length - (isDirectory ? 1 : 2);
    if (limits !== undefined && depth > limits.maximum_depth) return fail();
    // Bound before growing any population or copying a file body. Implicit
    // ancestors count too: an archive need not contain directory headers.
    for (let index = 2; index <= parts.length; index += 1) {
      const member = parts.slice(1, index).join('/');
      if (!populationPaths.has(member)) {
        if (limits !== undefined && populationPaths.size >= limits.maximum_entries) return fail();
        populationPaths.add(member);
      }
    }
    seen.add(path);
    if (isDirectory) {
      if (size !== 0 || (path !== 'package' && !path.startsWith('package/'))) return fail();
      directories.add(path);
    } else {
      if ((type !== 0 && type !== 0x30) || !path.startsWith('package/')) return fail();
      const mode = octal(block, 100, 8);
      if (mode > 0o7777) return fail();
      for (let index = 1; index < parts.length; index += 1)
        ancestors.add(parts.slice(0, index).join('/'));
      files.push({
        path: path.slice('package/'.length),
        mode,
        bytes: Buffer.from(bytes.subarray(offset + 512, end)),
      });
    }
    offset = next;
  }
  if (!terminated || files.length === 0) return fail();
  if ([...directories].some((path) => !ancestors.has(path))) return fail();
  if (files.some((file) => ancestors.has(`package/${file.path}`))) return fail();
  return {
    files,
    tar: bytes,
    directories: [...ancestors]
      .filter((path) => path !== 'package')
      .map((path) => path.slice('package/'.length))
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
  };
}

type ArchiveInput = Pick<
  ReleaseHostArchiveControls,
  'expected' | 'archive' | 'maximum_archive_bytes' | 'maximum_unpacked_bytes'
>;

/** One parser/identity computation for archive provisioning and installation verification. */
function checkedArchive(
  input: ArchiveInput,
  limits?: Pick<ReleaseHostArchiveControls, 'maximum_entries' | 'maximum_depth'>,
) {
  const expected = { ...input.expected };
  if (
    Object.keys(expected).sort().join(',') !==
      'archive_sha256,content_manifest_sha256,name,version' ||
    expected.name !== '@aarusso-nyx/devai' ||
    typeof expected.version !== 'string' ||
    expected.version.length === 0 ||
    !DIGEST.test(expected.archive_sha256) ||
    !DIGEST.test(expected.content_manifest_sha256) ||
    !Number.isSafeInteger(input.maximum_archive_bytes) ||
    input.maximum_archive_bytes < 1 ||
    !Number.isSafeInteger(input.maximum_unpacked_bytes) ||
    input.maximum_unpacked_bytes < 1024 ||
    input.archive.byteLength > input.maximum_archive_bytes
  )
    return fail();
  const archive = Buffer.from(input.archive);
  if (sha256(archive) !== expected.archive_sha256) return fail();
  const { files, tar, directories } = archiveFiles(archive, input.maximum_unpacked_bytes, limits);
  const population = new Map(files.map((file) => [file.path, file]));
  const manifest = files
    .map((file) =>
      Object.freeze({
        path: file.path,
        mode: file.mode,
        size: file.bytes.byteLength,
        sha256: sha256(Buffer.from(file.bytes)),
      }),
    )
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  if (canonicalSha256(manifest) !== expected.content_manifest_sha256) return fail();
  const packageBytes = population.get('package.json');
  if (packageBytes === undefined) return fail();
  const metadata: unknown = JSON.parse(Buffer.from(packageBytes.bytes).toString('utf8'));
  if (
    metadata === null ||
    typeof metadata !== 'object' ||
    !('name' in metadata) ||
    metadata.name !== expected.name ||
    !('version' in metadata) ||
    metadata.version !== expected.version
  )
    return fail();
  return {
    identity: Object.freeze(expected),
    manifest: Object.freeze(manifest),
    directories: Object.freeze(directories),
    population,
    archive,
    tar,
  };
}

/**
 * Pure external-host prerequisite. No filesystem/process effects, runtime loading,
 * or installation brand. A provisioner may consume the captured TAR bytes; it must
 * still call bootstrapReleaseHost on the complete resulting root before use.
 */
export function verifyReleaseHostArchive(
  input: ReleaseHostArchiveControls,
): ReleaseHostArchiveProjection {
  try {
    const keys = Reflect.ownKeys(input);
    if (
      keys.some((key) => typeof key !== 'string') ||
      keys.sort().join(',') !==
        'archive,expected,maximum_archive_bytes,maximum_depth,maximum_entries,maximum_unpacked_bytes' ||
      !(input.archive instanceof Uint8Array)
    )
      return fail();
    const controls = { ...input, expected: { ...input.expected } };
    for (const value of [
      controls.maximum_archive_bytes,
      controls.maximum_unpacked_bytes,
      controls.maximum_entries,
      controls.maximum_depth,
    ])
      if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff) return fail();
    const { identity, manifest, directories, population, archive, tar } = checkedArchive(
      controls,
      controls,
    );
    return Object.freeze({
      identity,
      manifest,
      directories,
      read: (path: string): Buffer => {
        const file = population.get(path);
        return file === undefined ? fail() : Buffer.from(file.bytes);
      },
      readArchive: (): Buffer => Buffer.from(archive),
      readTar: (): Buffer => Buffer.from(tar),
    });
  } catch {
    return fail();
  }
}

/**
 * Verify a complete supplied installation against an externally expected package.
 * Inputs are copied; reads return copies, so later pathname or buffer changes cannot
 * change the checked snapshot. The host must collect the installation without links
 * or races and bind the executing implementation separately before using its code.
 */
export function verifyReleasePackageSnapshot(input: {
  readonly expected: ReleasePackageIdentity;
  readonly archive: Uint8Array;
  readonly installed_files: readonly ReleasePackageFile[];
  readonly installed_directories: readonly string[];
  readonly maximum_archive_bytes: number;
  readonly maximum_unpacked_bytes: number;
}): ReleasePackageSnapshot {
  try {
    const { identity, manifest, population, archive } = checkedArchive(input);
    const observed = new Set<string>();
    for (const entry of input.installed_files) {
      const source = population.get(entry.path);
      if (
        !portablePath(entry.path) ||
        observed.has(entry.path) ||
        source === undefined ||
        source.mode !== entry.mode ||
        !Buffer.from(source.bytes).equals(Buffer.from(entry.bytes))
      )
        return fail();
      observed.add(entry.path);
    }
    if (observed.size !== population.size) return fail();
    const directories = new Set<string>();
    for (const path of observed) {
      const parts = path.split('/');
      for (let index = 1; index < parts.length; index += 1)
        directories.add(parts.slice(0, index).join('/'));
    }
    if (
      input.installed_directories.length !== directories.size ||
      new Set(input.installed_directories).size !== directories.size ||
      input.installed_directories.some((path) => !directories.has(path))
    )
      return fail();
    const snapshot = Object.freeze({
      identity,
      manifest,
      readArchive: (): Buffer => Buffer.from(archive),
      read: (path: string): Buffer => {
        const file = population.get(path);
        return file === undefined ? fail() : Buffer.from(file.bytes);
      },
    });
    verifiedSnapshots.add(snapshot);
    return snapshot;
  } catch {
    return fail();
  }
}
