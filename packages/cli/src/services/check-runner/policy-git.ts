import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readCheckPolicyGitSync } from '@devai-nyx/authority';
import { sha256Hex } from './canonical.js';

const GIT_OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

interface SnapshotEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly contentDigest: string;
}

function git(
  repoRoot: string,
  args: readonly string[],
  options: Readonly<{
    encoding?: BufferEncoding | null;
    input?: string | Buffer;
  }> = {},
): string | Buffer {
  const result = readCheckPolicyGitSync(repoRoot, args, options.input);
  return options.encoding === null ? result : result.toString(options.encoding ?? 'utf8');
}

function objectContentDigests(
  repoRoot: string,
  objectIds: readonly string[],
): ReadonlyMap<string, string> {
  const unique = [...new Set(objectIds)].sort();
  if (unique.length === 0) return new Map();
  const sizes = new Map<string, number>();
  const sizeOutput = Buffer.from(
    git(repoRoot, ['cat-file', '--batch-check'], {
      encoding: null,
      input: `${unique.join('\n')}\n`,
    }),
  );
  let sizeOffset = 0;
  for (const expectedObjectId of unique) {
    const newline = sizeOutput.indexOf(0x0a, sizeOffset);
    if (newline < 0) throw new Error('CHECK_RUNNER_GIT: truncated cat-file size header');
    const header = sizeOutput.subarray(sizeOffset, newline).toString('utf8');
    const match = /^([0-9a-f]+) ([a-z]+) (\d+)$/u.exec(header);
    const size = Number(match?.[3]);
    if (match?.[1] !== expectedObjectId || !Number.isSafeInteger(size) || size < 0) {
      throw new Error('CHECK_RUNNER_GIT: unexpected cat-file size header');
    }
    sizes.set(expectedObjectId, size);
    sizeOffset = newline + 1;
  }
  if (sizeOffset !== sizeOutput.length) {
    throw new Error('CHECK_RUNNER_GIT: extra cat-file size output');
  }

  const digests = new Map<string, string>();
  const maxBatchBytes = 32 * 1024 * 1024;
  for (let start = 0; start < unique.length;) {
    const batch: string[] = [];
    let estimatedBytes = 0;
    while (start + batch.length < unique.length) {
      const objectId = unique[start + batch.length];
      if (objectId === undefined) throw new Error('CHECK_RUNNER_GIT: object identity missing');
      const size = sizes.get(objectId);
      if (size === undefined) throw new Error('CHECK_RUNNER_GIT: object size missing');
      const estimatedObjectBytes = objectId.length + 64 + size;
      if (batch.length > 0 && estimatedBytes + estimatedObjectBytes > maxBatchBytes) break;
      batch.push(objectId);
      estimatedBytes += estimatedObjectBytes;
    }
    const output = Buffer.from(
      git(repoRoot, ['cat-file', '--batch'], {
        encoding: null,
        input: `${batch.join('\n')}\n`,
      }),
    );
    let offset = 0;
    for (const expectedObjectId of batch) {
      const newline = output.indexOf(0x0a, offset);
      if (newline < 0) throw new Error('CHECK_RUNNER_GIT: truncated cat-file header');
      const header = output.subarray(offset, newline).toString('utf8');
      const match = /^([0-9a-f]+) ([a-z]+) (\d+)$/u.exec(header);
      if (match?.[1] === undefined || match[3] === undefined || match[1] !== expectedObjectId) {
        throw new Error('CHECK_RUNNER_GIT: unexpected cat-file header');
      }
      const size = Number(match[3]);
      const contentStart = newline + 1;
      const contentEnd = contentStart + size;
      if (!Number.isSafeInteger(size) || size < 0 || output[contentEnd] !== 0x0a) {
        throw new Error('CHECK_RUNNER_GIT: truncated cat-file content');
      }
      digests.set(expectedObjectId, sha256Hex(output.subarray(contentStart, contentEnd)));
      offset = contentEnd + 1;
    }
    if (offset !== output.length) throw new Error('CHECK_RUNNER_GIT: extra cat-file output');
    start += batch.length;
  }
  return digests;
}

/**
 * Read-only Git text for preflight probes through the closed check-policy
 * grammar; a refused or failing read is undefined, never a crash. This is the
 * only door the preflight runner has to Git, so ownership stays here.
 */
export function readPreflightGitText(
  repoRoot: string,
  args: readonly string[],
): string | undefined {
  try {
    const result = git(repoRoot, args);
    return typeof result === 'string' ? result : result.toString('utf8');
  } catch {
    return undefined;
  }
}

export function gitText(repoRoot: string, args: readonly string[]): string {
  return String(git(repoRoot, args));
}

export function assertCommit(repoRoot: string, value: string, label: string): void {
  if (!GIT_OBJECT.test(value)) throw new Error(`CHECK_RUNNER_${label}: exact commit required`);
  const resolved = gitText(repoRoot, ['rev-parse', '--verify', `${value}^{commit}`]).trim();
  if (resolved !== value) throw new Error(`CHECK_RUNNER_${label}: commit does not resolve exactly`);
}

export function normalizePath(value: string): string {
  if (
    value === '' ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error(`CHECK_RUNNER_PATH: non-canonical repository path ${value}`);
  }
  return value;
}

function cleanStatus(repoRoot: string): boolean {
  return gitText(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']) === '';
}

export function committedSnapshot(repoRoot: string, commit: string): readonly SnapshotEntry[] {
  const output = git(repoRoot, ['ls-tree', '-r', '-z', '--full-tree', commit], { encoding: null });
  const rawEntries: Array<
    Readonly<{ path: string; mode: string; type: string; objectId: string }>
  > = [];
  for (const record of Buffer.from(output).toString('utf8').split('\0')) {
    if (record === '') continue;
    const match = /^(\d+) ([a-z]+) ([0-9a-f]+)\t(.+)$/u.exec(record);
    if (match === null) throw new Error('CHECK_RUNNER_GIT: malformed ls-tree record');
    const [, mode, type, objectId, rawPath] = match;
    if (
      mode === undefined ||
      type === undefined ||
      objectId === undefined ||
      rawPath === undefined
    ) {
      throw new Error('CHECK_RUNNER_GIT: incomplete ls-tree record');
    }
    const path = normalizePath(rawPath);
    rawEntries.push({ path, mode, type, objectId });
  }
  const contentDigests = objectContentDigests(
    repoRoot,
    rawEntries.map((entry) => entry.objectId),
  );
  const entries: SnapshotEntry[] = rawEntries.map(({ path, mode, type, objectId }) => {
    const contentDigest = contentDigests.get(objectId);
    if (contentDigest === undefined) throw new Error('CHECK_RUNNER_GIT: object digest missing');
    return { path, mode, type, contentDigest };
  });
  return entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

/** Tracked paths of the index, read through the closed check-policy git grammar. */
export function trackedPaths(repoRoot: string): readonly string[] {
  const paths = new Set<string>();
  for (const record of Buffer.from(git(repoRoot, ['ls-files', '-s', '-z'], { encoding: null }))
    .toString('utf8')
    .split('\0')) {
    const path = /^\d+ [0-9a-f]+ \d+\t(.+)$/u.exec(record)?.[1];
    if (path !== undefined) paths.add(path);
  }
  return [...paths].sort();
}

export function worktreeSnapshot(repoRoot: string): readonly SnapshotEntry[] {
  const staged = Buffer.from(git(repoRoot, ['ls-files', '-s', '-z'], { encoding: null }))
    .toString('utf8')
    .split('\0');
  const modes = new Map<string, string>();
  for (const record of staged) {
    if (record === '') continue;
    const match = /^(\d+) [0-9a-f]+ \d+\t(.+)$/u.exec(record);
    if (match?.[1] !== undefined && match[2] !== undefined) modes.set(match[2], match[1]);
  }
  const listed = Buffer.from(
    git(repoRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      encoding: null,
    }),
  )
    .toString('utf8')
    .split('\0')
    .filter((path) => path !== '');
  const entries: SnapshotEntry[] = [];
  for (const rawPath of listed) {
    const path = normalizePath(rawPath);
    const absolute = join(repoRoot, path);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    const content = stat.isSymbolicLink()
      ? Buffer.from(readlinkSync(absolute), 'utf8')
      : readFileSync(absolute);
    const mode = stat.isSymbolicLink()
      ? '120000'
      : (modes.get(path) ?? (stat.mode & 0o111 ? '100755' : '100644'));
    entries.push({ path, mode, type: 'blob', contentDigest: sha256Hex(content) });
  }
  return entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

function parseChangedPaths(output: Buffer): readonly string[] {
  const fields = output.toString('utf8').split('\0');
  const paths = new Set<string>();
  let index = 0;
  while (index < fields.length && fields[index] !== '') {
    const status = fields[index++];
    if (status === undefined) break;
    if (/^[RC]\d+$/u.test(status)) {
      const before = fields[index++];
      const after = fields[index++];
      if (before === undefined || after === undefined)
        throw new Error('CHECK_RUNNER_GIT: rename truncated');
      paths.add(normalizePath(before));
      paths.add(normalizePath(after));
    } else {
      const path = fields[index++];
      if (path === undefined) throw new Error('CHECK_RUNNER_GIT: change truncated');
      paths.add(normalizePath(path));
    }
  }
  return [...paths].sort();
}

export function changedPaths(
  repoRoot: string,
  base: string,
  candidate: string,
  clean: boolean,
): readonly string[] {
  const args = clean
    ? ['diff', '--name-status', '-z', '-M', '--find-renames', base, candidate]
    : ['diff', '--name-status', '-z', '-M', '--find-renames', base, '--'];
  const paths = new Set(parseChangedPaths(Buffer.from(git(repoRoot, args, { encoding: null }))));
  if (!clean) {
    const untracked = Buffer.from(
      git(repoRoot, ['ls-files', '-z', '--others', '--exclude-standard'], { encoding: null }),
    )
      .toString('utf8')
      .split('\0')
      .filter((path) => path !== '');
    untracked.forEach((path) => paths.add(normalizePath(path)));
  }
  return [...paths].sort();
}

const HARNESS_MUTATED_PREFIXES = ['.devai/state/', 'record/', 'scratch/'] as const;

export const RELEASE_INPUT_PROJECTION = Object.freeze({
  schemaVersion: '1.0.0' as const,
  source: 'exact-candidate-tree' as const,
  excludedPrefixes: Object.freeze([...HARNESS_MUTATED_PREFIXES].sort()),
});

export function isHarnessMutatedPath(path: string): boolean {
  return HARNESS_MUTATED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Canonical changed-path population shared by intent producers and task planning. */
export function projectChangedPaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)].filter((path) => !isHarnessMutatedPath(path)).sort();
}

export function currentRepositoryState(repoRoot: string): Readonly<{
  commit: string;
  tree: string;
  clean: boolean;
}> {
  const commit = gitText(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  const tree = gitText(repoRoot, ['rev-parse', '--verify', `${commit}^{tree}`]).trim();
  return { commit, tree, clean: cleanStatus(repoRoot) };
}

export function exactCommitTree(repoRoot: string, commit: string): string {
  assertCommit(repoRoot, commit, 'BASE');
  return gitText(repoRoot, ['rev-parse', '--verify', `${commit}^{tree}`]).trim();
}

export function exactCommitFile(repoRoot: string, commit: string, path: string): string {
  assertCommit(repoRoot, commit, 'RELEASE_VERSION_SOURCE');
  try {
    return gitText(repoRoot, ['cat-file', 'blob', `${commit}:${path}`]);
  } catch {
    throw new Error('CHECK_RELEASE_VERSION_SOURCE_UNREADABLE');
  }
}

export function exactCandidateRepositoryState(
  repoRoot: string,
  candidate: Readonly<{ commit: string; tree: string }>,
): Readonly<{ commit: string; tree: string; clean: boolean }> {
  const tree = exactCommitTree(repoRoot, candidate.commit);
  if (tree !== candidate.tree) throw new Error('CHECK_RELEASE_INTENT_CANDIDATE_MISMATCH');
  const candidateEntries = committedSnapshot(repoRoot, candidate.commit).filter(
    (entry) => !isHarnessMutatedPath(entry.path),
  );
  const worktreeEntries = worktreeSnapshot(repoRoot).filter(
    (entry) => !isHarnessMutatedPath(entry.path),
  );
  return {
    commit: candidate.commit,
    tree,
    clean: sha256Hex(candidateEntries) === sha256Hex(worktreeEntries),
  };
}
