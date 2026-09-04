import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  verifyReleasePackageSnapshot,
  type ReleasePackageFile,
  type ReleasePackageIdentity,
} from './release-package-snapshot.js';
import {
  verifyReleaseCandidateSnapshot,
  type ReleaseCandidateSnapshot,
  type ReleaseGitObject,
} from './release-candidate-snapshot.js';

export interface ReleaseHostPackageControls {
  /** Trusted host locator, never a candidate-supplied path. Root links are resolved once. */
  readonly package_root: string;
  readonly expected: ReleasePackageIdentity;
  readonly archive: Uint8Array;
  readonly maximum_archive_bytes: number;
  readonly maximum_unpacked_bytes: number;
  readonly maximum_entries: number;
  readonly maximum_depth: number;
}

export interface ReleaseHostCandidateControls {
  /** Trusted host execution locator; not part of the portable repository identity. */
  readonly repository_root: string;
  readonly repository: ReleaseCandidateSnapshot['repository'];
  readonly git: {
    readonly executable: string;
    readonly sha256: string;
    readonly maximum_executable_bytes: number;
  };
  readonly maximum_bytes: number;
  readonly maximum_entries: number;
  /** Total collection deadline, not a fresh budget for each subprocess. */
  readonly timeout_ms: number;
}

const PACKAGE_INVALID = 'rpl-package-identity-mismatch';
const CANDIDATE_INVALID = 'rpl-policy-resolution-mismatch';
const DIGEST = /^[a-f0-9]{64}$/u;
const stat = (path: string): BigIntStats => lstatSync(path, { bigint: true });
const fstat = (fd: number): BigIntStats => fstatSync(fd, { bigint: true });
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function refuse(code: string): never {
  // Do not forward native errors: they can disclose rejected paths or bytes.
  throw new Error(code);
}

function limit(value: number, minimum = 1): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > 0x7fffffff)
    refuse(PACKAGE_INVALID);
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function safeName(name: string): boolean {
  return (
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    name.length <= 255 &&
    !/[\\/:*?]/u.test(name) &&
    ![...name].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    Buffer.from(name).toString('utf8') === name
  );
}

/** Streaming directory census: bound entry count before growing the population array. */
function names(path: string, maximum: number): string[] {
  const directory = opendirSync(path, { bufferSize: 32 });
  const result: string[] = [];
  try {
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      if (result.length >= maximum || !safeName(entry.name)) refuse(PACKAGE_INVALID);
      result.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return result.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

function readRegular(path: string, maximum: number): { bytes: Buffer; metadata: BigIntStats } {
  const before = stat(path);
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximum))
    refuse(PACKAGE_INVALID);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!sameStat(before, fstat(fd))) refuse(PACKAGE_INVALID);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) refuse(PACKAGE_INVALID);
      offset += count;
    }
    if (
      readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0 ||
      !sameStat(before, fstat(fd)) ||
      !sameStat(before, stat(path))
    )
      refuse(PACKAGE_INVALID);
    return { bytes, metadata: before };
  } finally {
    closeSync(fd);
  }
}

/**
 * Capture in an externally controlled host root, then require exact archive equality.
 * Node does not expose openat: descriptor/path/directory revalidation detects races,
 * but cannot exclude adversarial ABA substitutions in an attacker-controlled parent.
 * This is approved-byte/code binding, NOT OS filesystem containment. Callers must not
 * place this root under candidate control. Accepted consumers reuse captured bytes.
 */
export function captureReleaseHostPackage(input: ReleaseHostPackageControls) {
  const directories: {
    path: string;
    relative: string;
    fd: number;
    metadata: BigIntStats;
    names: string[];
  }[] = [];
  try {
    limit(input.maximum_archive_bytes);
    limit(input.maximum_unpacked_bytes, 1024);
    limit(input.maximum_entries);
    limit(input.maximum_depth);
    if (!isAbsolute(input.package_root) || input.archive.byteLength > input.maximum_archive_bytes)
      refuse(PACKAGE_INVALID);
    const archive = Buffer.from(input.archive);
    const expected = Object.freeze({ ...input.expected });
    if (!DIGEST.test(expected.archive_sha256) || hash(archive) !== expected.archive_sha256)
      refuse(PACKAGE_INVALID);
    const root = realpathSync(input.package_root);
    const files: ReleasePackageFile[] = [];
    const fileStats: { path: string; metadata: BigIntStats }[] = [];
    let entries = 0;
    let totalBytes = 0;
    const visit = (path: string, relative: string, depth: number): void => {
      if (depth > input.maximum_depth) refuse(PACKAGE_INVALID);
      const metadata = stat(path);
      if (!metadata.isDirectory()) refuse(PACKAGE_INVALID);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
      const directory = { path, relative, fd, metadata, names: [] as string[] };
      directories.push(directory);
      if (!sameStat(metadata, fstat(fd))) refuse(PACKAGE_INVALID);
      directory.names = names(path, input.maximum_entries - entries);
      entries += directory.names.length;
      for (const name of directory.names) {
        const child = join(path, name);
        const childRelative = relative === '' ? name : `${relative}/${name}`;
        if (childRelative.length > 4096 || !sameStat(metadata, fstat(fd))) refuse(PACKAGE_INVALID);
        const childStat = stat(child);
        if (childStat.isDirectory()) visit(child, childRelative, depth + 1);
        else {
          const captured = readRegular(child, input.maximum_unpacked_bytes - totalBytes);
          if (!sameStat(childStat, captured.metadata)) refuse(PACKAGE_INVALID);
          totalBytes += captured.bytes.length;
          files.push({
            path: childRelative,
            mode: Number(childStat.mode & 0o7777n),
            bytes: captured.bytes,
          });
          fileStats.push({ path: child, metadata: childStat });
        }
      }
    };
    visit(root, '', 0);
    // Revalidate every descriptor, pathname and complete directory population after all reads.
    for (const directory of directories) {
      if (
        !sameStat(directory.metadata, fstat(directory.fd)) ||
        !sameStat(directory.metadata, stat(directory.path)) ||
        JSON.stringify(directory.names) !==
          JSON.stringify(names(directory.path, input.maximum_entries))
      )
        refuse(PACKAGE_INVALID);
    }
    for (const file of fileStats)
      if (!sameStat(file.metadata, stat(file.path))) refuse(PACKAGE_INVALID);
    const verification = {
      expected,
      archive,
      installed_files: files,
      installed_directories: directories
        .map((entry) => entry.relative)
        .filter((path) => path !== ''),
      maximum_archive_bytes: input.maximum_archive_bytes,
      maximum_unpacked_bytes: input.maximum_unpacked_bytes,
    };
    const snapshot = verifyReleasePackageSnapshot(verification);
    return Object.freeze({
      // Host-only execution locator, deliberately absent from portable evidence.
      root,
      snapshot,
      readVerificationInput: () => ({
        ...verification,
        archive: Buffer.from(archive),
        installed_files: files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) })),
        installed_directories: [...verification.installed_directories],
      }),
    });
  } catch {
    return refuse(PACKAGE_INVALID);
  } finally {
    let failed = false;
    for (const directory of directories) {
      try {
        closeSync(directory.fd);
      } catch {
        failed = true;
      }
    }
    if (failed) refuse(PACKAGE_INVALID);
  }
}

/** Read only raw, hash-addressed Git objects; no checkout, filters, hooks, shell or lazy fetch. */
export function captureReleaseHostCandidate(input: ReleaseHostCandidateControls) {
  try {
    limit(input.maximum_bytes);
    limit(input.maximum_entries);
    limit(input.timeout_ms);
    limit(input.git.maximum_executable_bytes);
    const repository = Object.freeze({ ...input.repository });
    if (
      !isAbsolute(input.repository_root) ||
      !isAbsolute(input.git.executable) ||
      !DIGEST.test(input.git.sha256) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(repository.commit) ||
      repository.tree.length !== repository.commit.length ||
      !/^[a-f0-9]+$/u.test(repository.tree)
    )
      refuse(CANDIDATE_INVALID);
    const root = realpathSync(input.repository_root);
    const executable = realpathSync(input.git.executable);
    const executableCapture = readRegular(executable, input.git.maximum_executable_bytes);
    if (hash(executableCapture.bytes) !== input.git.sha256) refuse(CANDIDATE_INVALID);
    const deadline = Date.now() + input.timeout_ms;
    const format = repository.commit.length === 40 ? 'sha1' : 'sha256';
    const idBytes = repository.commit.length / 2;
    const objects = new Map<string, ReleaseGitObject>();
    let totalBytes = 0;
    const run = (
      option: '--batch-check' | '--batch',
      ids: readonly string[],
      maximum: number,
    ): Buffer => {
      const remaining = deadline - Date.now();
      if (remaining < 1) refuse(CANDIDATE_INVALID);
      const result = spawnSync(
        executable,
        [
          '--no-replace-objects',
          '--no-optional-locks',
          '--no-lazy-fetch',
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'protocol.allow=never',
          '-C',
          root,
          'cat-file',
          option,
        ],
        {
          env: {
            PATH: '/usr/bin:/bin',
            LANG: 'C',
            LC_ALL: 'C',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_CONFIG_COUNT: '0',
            GIT_NO_REPLACE_OBJECTS: '1',
            GIT_OPTIONAL_LOCKS: '0',
            GIT_TERMINAL_PROMPT: '0',
            GIT_NO_LAZY_FETCH: '1',
          },
          input: Buffer.from(`${ids.join('\n')}\n`),
          shell: false,
          timeout: remaining,
          killSignal: 'SIGKILL',
          maxBuffer: maximum,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      if (result.status !== 0 || result.signal !== null || result.error !== undefined)
        refuse(CANDIDATE_INVALID);
      return result.stdout;
    };
    const fetch = (ids: readonly string[], type: ReleaseGitObject['type']): void => {
      const unique = [...new Set(ids)].filter((id) => !objects.has(id));
      if (objects.size + unique.length > input.maximum_entries) refuse(CANDIDATE_INVALID);
      for (let cursor = 0; cursor < unique.length; cursor += 128) {
        const batch = unique.slice(cursor, cursor + 128);
        if (batch.some((id) => id.length !== repository.commit.length || !/^[a-f0-9]+$/u.test(id)))
          refuse(CANDIDATE_INVALID);
        const headers = run('--batch-check', batch, batch.length * 128)
          .toString('ascii')
          .split('\n');
        if (headers.pop() !== '' || headers.length !== batch.length) refuse(CANDIDATE_INVALID);
        let byteBudget = batch.length * 128;
        const sizes = headers.map((header, index) => {
          const fields = header.split(' ');
          const size = Number(fields[2]);
          if (
            fields.length !== 3 ||
            fields[0] !== batch[index] ||
            fields[1] !== type ||
            !/^(?:0|[1-9][0-9]*)$/u.test(fields[2] ?? '') ||
            !Number.isSafeInteger(size) ||
            size > input.maximum_bytes - totalBytes
          )
            refuse(CANDIDATE_INVALID);
          totalBytes += size;
          byteBudget += size;
          return size;
        });
        const bytes = run('--batch', batch, byteBudget);
        let offset = 0;
        for (const [index, id] of batch.entries()) {
          const end = bytes.indexOf(10, offset);
          const size = sizes[index];
          if (
            end < 0 ||
            size === undefined ||
            bytes.subarray(offset, end).toString('ascii') !== headers[index]
          )
            refuse(CANDIDATE_INVALID);
          const content = bytes.subarray(end + 1, end + 1 + size);
          offset = end + size + 2;
          if (
            content.length !== size ||
            bytes[offset - 1] !== 10 ||
            createHash(format).update(`${type} ${size}\0`).update(content).digest('hex') !== id
          )
            refuse(CANDIDATE_INVALID);
          objects.set(id, { type, bytes: Buffer.from(content) });
        }
        if (offset !== bytes.length) refuse(CANDIDATE_INVALID);
      }
    };
    fetch([repository.commit], 'commit');
    let pending = [repository.tree];
    const traversed = new Set<string>();
    const blobs = new Set<string>();
    let entries = 0;
    while (pending.length > 0) {
      fetch(pending, 'tree');
      const next = new Set<string>();
      for (const id of pending) {
        if (traversed.has(id)) continue;
        traversed.add(id);
        const tree = objects.get(id);
        if (tree?.type !== 'tree') refuse(CANDIDATE_INVALID);
        const bytes = Buffer.from(tree.bytes);
        let offset = 0;
        while (offset < bytes.length) {
          const space = bytes.indexOf(32, offset);
          const nul = bytes.indexOf(0, space + 1);
          if (space <= offset || nul <= space + 1 || nul + 1 + idBytes > bytes.length)
            refuse(CANDIDATE_INVALID);
          const mode = bytes.subarray(offset, space).toString('ascii');
          const child = bytes.subarray(nul + 1, nul + 1 + idBytes).toString('hex');
          if (mode === '40000') next.add(child);
          else if (mode === '100644' || mode === '100755') blobs.add(child);
          else if (mode !== '120000' && mode !== '160000') refuse(CANDIDATE_INVALID);
          offset = nul + 1 + idBytes;
          entries += 1;
          if (entries > input.maximum_entries) refuse(CANDIDATE_INVALID);
        }
      }
      pending = [...next].filter((id) => !traversed.has(id));
    }
    fetch([...blobs], 'blob');
    const after = readRegular(executable, input.git.maximum_executable_bytes);
    if (
      !sameStat(executableCapture.metadata, after.metadata) ||
      hash(after.bytes) !== input.git.sha256
    )
      refuse(CANDIDATE_INVALID);
    const verification = {
      repository,
      objects,
      maximum_bytes: input.maximum_bytes,
      maximum_entries: input.maximum_entries,
    };
    // The pure verifier independently checks all tree syntax, ordering and exact membership.
    verifyReleaseCandidateSnapshot(verification);
    return verification;
  } catch {
    return refuse(CANDIDATE_INVALID);
  }
}
