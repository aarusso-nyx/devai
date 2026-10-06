import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import {
  constants as nodeFileConstants,
  closeSync as nodeCloseSync,
  fstatSync as nodeFstatSync,
  fsyncSync as nodeFsyncSync,
  linkSync as nodeLinkSync,
  openSync as nodeOpenSync,
  unlinkSync as nodeUnlinkSync,
  writeSync as nodeWriteSync,
} from 'node:fs';

/** Suffix of the staged name a publication links into place (ADR-AUT-0005). */
export const PUBLISH_STAGED_SUFFIX = '.publish-staged';

/**
 * Code of a publication whose target is linked into place but whose cleanup (the staged
 * unlink or the directory fsync) failed: the target holds the caller's complete bytes,
 * but the call cannot promise they are durable. The caller owns what it published.
 */
export const PUBLISH_INDETERMINATE = 'AUTHORITY_PUBLISH_CLEANUP_INCOMPLETE';

/**
 * Identity of the file a publication created, taken by fstat of the staged descriptor it
 * wrote before the link. The target is a hard link to that file, so a caller can tell the
 * entry it published from any other entry later found at the same path (#313).
 */
export interface PublishedFileIdentity {
  readonly dev: number;
  readonly ino: number;
}

/** Error for an indeterminate publication; `cause` is the failed cleanup step's error. */
export class PublishIndeterminateError extends Error {
  readonly code = PUBLISH_INDETERMINATE;
  readonly path: string;
  /** Whether the staged name is still present after the recovery attempt. */
  readonly staged_remaining: boolean;
  /** Identity of the file linked into place, which the caller owns. */
  readonly identity: PublishedFileIdentity;

  constructor(
    path: string,
    stagedRemaining: boolean,
    cause: unknown,
    identity: PublishedFileIdentity,
  ) {
    super(PUBLISH_INDETERMINATE, { cause });
    this.path = path;
    this.staged_remaining = stagedRemaining;
    this.identity = identity;
  }
}

/**
 * Test seams (fault injection). They replace the raw step after the link, or stop the
 * publication as a process crash would, with no cleanup at all.
 */
export interface PublishNoReplaceHooks {
  readonly crashAfterLink?: boolean;
  readonly unlinkStaged?: (staged: string) => void;
  readonly fsyncDirectory?: (directory: string) => void;
}

function fsyncDirectory(path: string): void {
  const fd = nodeOpenSync(path, nodeFileConstants.O_RDONLY | (nodeFileConstants.O_DIRECTORY ?? 0));
  try {
    nodeFsyncSync(fd);
  } finally {
    nodeCloseSync(fd);
  }
}

function removeIfPresent(path: string): boolean {
  try {
    nodeUnlinkSync(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * Atomic no-replace publication (ADR-AUT-0005). The complete bytes go to a fresh staged
 * file beside `path`, which is fsynced, hard-linked to `path` (link(2) fails with EEXIST
 * when `path` exists, so nothing is ever replaced), and then unlinked; the directory is
 * fsynced last, so a returned call is durable. A reader sees either no file or the whole
 * file, never a partial one.
 *
 * It returns the identity of the published file from the staged descriptor's fstat.
 *
 * A failure before the link removes the staged file and rethrows: nothing was published.
 * A failure after the link is an indeterminate publication: the staged name is removed if
 * it can be, and `PublishIndeterminateError` reports that the target holds the caller's
 * bytes without a durability promise. A crash after the link leaves the complete target
 * and a stray hidden staged link, which no reader treats as a record.
 */
export function publishNoReplaceSteps(
  path: string,
  data: string | Uint8Array,
  hooks: PublishNoReplaceHooks = {},
): PublishedFileIdentity {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  const directory = dirname(path);
  const staged = join(
    directory,
    `.${basename(path)}.${String(process.pid)}-${randomUUID()}${PUBLISH_STAGED_SUFFIX}`,
  );
  const fd = nodeOpenSync(staged, 'wx');
  let identity: PublishedFileIdentity;
  try {
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = nodeWriteSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error('AUTHORITY_PUBLISH_WRITE_STALLED');
        offset += written;
      }
      nodeFsyncSync(fd);
      const stat = nodeFstatSync(fd);
      identity = { dev: stat.dev, ino: stat.ino };
    } finally {
      nodeCloseSync(fd);
    }
    nodeLinkSync(staged, path);
  } catch (error) {
    nodeUnlinkSync(staged);
    throw error;
  }
  if (hooks.crashAfterLink === true) throw new Error('AUTHORITY_PUBLISH_SIMULATED_CRASH');
  try {
    (hooks.unlinkStaged ?? nodeUnlinkSync)(staged);
    (hooks.fsyncDirectory ?? fsyncDirectory)(directory);
  } catch (error) {
    throw new PublishIndeterminateError(path, removeIfPresent(staged), error, identity);
  }
  return identity;
}
