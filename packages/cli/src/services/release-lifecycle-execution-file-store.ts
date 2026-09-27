import {
  closeSync,
  closeReadOnlySync,
  existsSync,
  fileOpenConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  openReadOnlyNoFollowSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from '@devai-nyx/authority';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  ReleaseLifecycleRequest,
  ReleaseLifecycleStateV2,
  StoreRecord,
  StoreHead,
} from './release-lifecycle-execution-types.js';
import { same } from './release-lifecycle-execution-support.js';
import {
  verifyStoreHeadIdentity,
  verifyReleaseStateIdentity,
  verifyStoreRecordIdentity,
  headForCompletion,
} from './release-lifecycle-execution-records.js';

function sameFileIdentity(
  left: ReturnType<typeof lstatSync>,
  right: ReturnType<typeof fstatSync>,
): boolean {
  return (
    left !== undefined &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    // Directory link counts change when unrelated child directories are created.
    // Keep unlinked directories unsafe and retain exact hard-link checks for files.
    (left.isDirectory() && right.isDirectory()
      ? left.nlink > 0 && right.nlink > 0
      : left.nlink === right.nlink)
  );
}

function noFollowFlags(base: number, directory = false): number {
  return (
    base |
    (fileOpenConstants.O_NOFOLLOW ?? 0) |
    (directory ? (fileOpenConstants.O_DIRECTORY ?? 0) : 0)
  );
}

function safeExistingDirectory(path: string, requirePrivate = false): void {
  const stat = lstatSync(path);
  const currentUid = typeof process.geteuid === 'function' ? process.geteuid() : undefined;
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (requirePrivate &&
      ((stat.mode & 0o077) !== 0 || (currentUid !== undefined && stat.uid !== currentUid)))
  ) {
    throw new Error('release-state-store-unsafe');
  }
  const descriptor = openReadOnlyNoFollowSync(path, true);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isDirectory() || !sameFileIdentity(stat, opened)) {
      throw new Error('release-state-store-unsafe');
    }
  } finally {
    closeReadOnlySync(descriptor);
  }
}

function ensurePrivateDirectory(path: string, requireExistingPrivate = true): void {
  const absolute = resolve(path);
  if (existsSync(absolute)) {
    safeExistingDirectory(absolute, requireExistingPrivate);
    return;
  }
  const parent = dirname(absolute);
  if (parent === absolute) throw new Error('release-state-store-unsafe');
  ensurePrivateDirectory(parent, false);
  try {
    mkdirSync(absolute, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  safeExistingDirectory(absolute, true);
}

function fsyncDirectory(path: string): void {
  const before = lstatSync(path);
  const descriptor = openSync(path, noFollowFlags(fileOpenConstants.O_RDONLY, true));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isDirectory() || !sameFileIdentity(before, opened)) {
      throw new Error('release-state-store-unsafe');
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function exclusiveWrite(path: string, value: unknown): void {
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o077) !== 0) {
      throw new Error('release-state-store-unsafe');
    }
    writeSync(descriptor, `${canonicalJson(value)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
}

function readRegularJson(path: string): unknown {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error('release-state-store-unsafe');
  const descriptor = openReadOnlyNoFollowSync(path);
  try {
    const openedBefore = fstatSync(descriptor);
    if (
      !openedBefore.isFile() ||
      openedBefore.nlink !== 1 ||
      !sameFileIdentity(before, openedBefore)
    ) {
      throw new Error('release-state-store-unsafe');
    }
    const body = readFileSync(descriptor, 'utf8');
    const openedAfter = fstatSync(descriptor);
    if (
      !sameFileIdentity(before, openedAfter) ||
      openedBefore.size !== openedAfter.size ||
      openedBefore.mtimeMs !== openedAfter.mtimeMs ||
      openedBefore.ctimeMs !== openedAfter.ctimeMs
    ) {
      throw new Error('release-state-store-unsafe');
    }
    return JSON.parse(body) as unknown;
  } finally {
    closeReadOnlySync(descriptor);
  }
}

export class ReleaseLifecycleFileStore {
  readonly campaignDirectory: string;
  private executionLocked = false;
  private directoryIdentities:
    | readonly {
        readonly path: string;
        readonly dev: number;
        readonly ino: number;
        readonly private: boolean;
      }[]
    | undefined;

  constructor(root: string, request: ReleaseLifecycleRequest) {
    const absoluteRoot = resolve(root);
    const repositoryKey = canonicalSha256(request.repository_locator.id);
    this.campaignDirectory = join(absoluteRoot, repositoryKey, request.candidate_locator.commit);
    const escaped = relative(absoluteRoot, this.campaignDirectory);
    if (escaped.startsWith(`..${sep}`) || isAbsolute(escaped))
      throw new Error('release-state-store-unsafe');
  }

  initialize(): void {
    if (this.directoryIdentities !== undefined) {
      for (const identity of this.directoryIdentities) {
        safeExistingDirectory(identity.path, identity.private);
        const stat = lstatSync(identity.path);
        if (stat.dev !== identity.dev || stat.ino !== identity.ino)
          throw new Error('release-state-store-unsafe');
      }
      return;
    }
    ensurePrivateDirectory(this.campaignDirectory);
    for (const directory of ['records', 'attempts', 'completions', 'failures', 'unknown']) {
      ensurePrivateDirectory(join(this.campaignDirectory, directory));
    }
    const privatePaths = [
      this.campaignDirectory,
      ...['records', 'attempts', 'completions', 'failures', 'unknown'].map((name) =>
        join(this.campaignDirectory, name),
      ),
    ];
    const paths = [...privatePaths];
    let ancestor = dirname(this.campaignDirectory);
    for (;;) {
      paths.push(ancestor);
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    this.directoryIdentities = paths.map((path) => {
      safeExistingDirectory(path, privatePaths.includes(path));
      const stat = lstatSync(path);
      return { path, dev: stat.dev, ino: stat.ino, private: privatePaths.includes(path) };
    });
  }

  async withExecutionLock<T>(operation: () => T | Promise<T>): Promise<T> {
    this.initialize();
    const path = join(this.campaignDirectory, '.EXECUTION.lock');
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, 'wx', 0o600);
      writeSync(descriptor, 'release-lifecycle-v2\n');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      fsyncDirectory(this.campaignDirectory);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      throw new Error(
        (error as NodeJS.ErrnoException).code === 'EEXIST'
          ? 'release-state-store-concurrent-writer'
          : 'release-state-store-unsafe',
      );
    }
    this.executionLocked = true;
    try {
      return await operation();
    } finally {
      this.executionLocked = false;
      this.initialize();
      unlinkSync(path);
      fsyncDirectory(this.campaignDirectory);
    }
  }

  readHead(): StoreHead | null {
    const path = join(this.campaignDirectory, 'HEAD.json');
    if (!existsSync(path)) return null;
    return verifyStoreHeadIdentity(readRegularJson(path));
  }

  readStateRecords(): ReleaseLifecycleStateV2[] {
    const directory = join(this.campaignDirectory, 'records');
    if (!existsSync(directory)) return [];
    safeExistingDirectory(directory);
    return readdirSync(directory)
      .map((name) => {
        if (!/^[0-9]{8}-[a-f0-9]{64}\.json$/u.test(name)) {
          throw new Error('release-state-store-unsafe');
        }
        return name;
      })
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map((name) => {
        const state = verifyReleaseStateIdentity(readRegularJson(join(directory, name)), true);
        if (!name.endsWith(`-${state.record_digest_sha256}.json`)) {
          throw new Error('release-state-store-unsafe');
        }
        return state;
      });
  }

  readStoreRecords(): StoreRecord[] {
    const all: StoreRecord[] = [];
    if (existsSync(this.campaignDirectory)) {
      safeExistingDirectory(this.campaignDirectory);
      const allowed = new Set([
        'HEAD.json',
        'records',
        'attempts',
        'completions',
        'failures',
        'unknown',
        ...(this.executionLocked ? ['.EXECUTION.lock'] : []),
      ]);
      if (readdirSync(this.campaignDirectory).some((entry) => !allowed.has(entry))) {
        throw new Error('release-state-store-unsafe');
      }
    }
    for (const directoryName of ['attempts', 'completions', 'failures', 'unknown']) {
      const directory = join(this.campaignDirectory, directoryName);
      if (!existsSync(directory)) continue;
      safeExistingDirectory(directory);
      for (const name of readdirSync(directory)) {
        if (!/^[0-9]{8}-[a-f0-9]{64}\.json$/u.test(name)) {
          throw new Error('release-state-store-unsafe');
        }
        const record = verifyStoreRecordIdentity(readRegularJson(join(directory, name)));
        if (!name.endsWith(`-${record.record_digest_sha256}.json`)) {
          throw new Error('release-state-store-unsafe');
        }
        all.push(record);
      }
    }
    return all.sort(
      (left, right) =>
        left.sequence - right.sequence || left.record_id.localeCompare(right.record_id, 'en'),
    );
  }

  appendStoreRecord(record: StoreRecord): void {
    if (!this.executionLocked) throw new Error('release-state-store-lock-required');
    verifyStoreRecordIdentity(record);
    this.initialize();
    const directoryName =
      record.record_kind === 'attempt'
        ? 'attempts'
        : record.record_kind === 'completion'
          ? 'completions'
          : record.record_kind === 'failure'
            ? 'failures'
            : 'unknown';
    exclusiveWrite(
      join(
        this.campaignDirectory,
        directoryName,
        `${String(record.sequence).padStart(8, '0')}-${record.record_digest_sha256}.json`,
      ),
      record,
    );
  }

  appendStateAndAdvanceHead(
    state: ReleaseLifecycleStateV2,
    completion: StoreRecord,
    expected: StoreHead | null,
  ): void {
    if (!this.executionLocked) throw new Error('release-state-store-lock-required');
    verifyReleaseStateIdentity(state, true);
    this.initialize();
    const statePath = join(
      this.campaignDirectory,
      'records',
      `${String(state.storage.generation).padStart(8, '0')}-${state.record_digest_sha256}.json`,
    );
    exclusiveWrite(statePath, state);
    const observed = this.readHead();
    if (!same(observed, expected)) throw new Error('release-state-cas-stale-head');
    const next = headForCompletion(state, completion);
    const headPath = join(this.campaignDirectory, 'HEAD.json');
    const temporary = join(this.campaignDirectory, `.HEAD-${state.state_id}.tmp`);
    try {
      exclusiveWrite(temporary, next);
      if (!same(this.readHead(), expected)) throw new Error('release-state-cas-stale-head');
      renameSync(temporary, headPath);
      fsyncDirectory(this.campaignDirectory);
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
  }
}
