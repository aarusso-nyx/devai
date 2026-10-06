import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import {
  constants as nodeFileConstants,
  closeSync as nodeCloseSync,
  fsyncSync as nodeFsyncSync,
  linkSync as nodeLinkSync,
  openSync as nodeOpenSync,
  unlinkSync as nodeUnlinkSync,
  writeSync as nodeWriteSync,
} from 'node:fs';

/** Suffix of the staged name a publication links into place (ADR-AUT-0005). */
export const PUBLISH_STAGED_SUFFIX = '.publish-staged';

/** Test seam: runs between the link into place and the removal of the staged name. */
export interface PublishNoReplaceHooks {
  readonly afterLink?: (staged: string) => void;
}

function fsyncDirectory(path: string): void {
  const fd = nodeOpenSync(path, nodeFileConstants.O_RDONLY | (nodeFileConstants.O_DIRECTORY ?? 0));
  try {
    nodeFsyncSync(fd);
  } finally {
    nodeCloseSync(fd);
  }
}

/**
 * Atomic no-replace publication (ADR-AUT-0005). The complete bytes go to a fresh staged
 * file beside `path`, which is fsynced, hard-linked to `path` (link(2) fails with EEXIST
 * when `path` exists, so nothing is ever replaced), and then unlinked; the directory is
 * fsynced last, so a returned call is durable. A reader sees either no file or the whole
 * file, never a partial one. A crash after the link leaves the complete file at `path`
 * and a stray staged name, which no reader treats as a record.
 */
export function publishNoReplaceSteps(
  path: string,
  data: string | Uint8Array,
  hooks: PublishNoReplaceHooks = {},
): void {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  const directory = dirname(path);
  const staged = join(
    directory,
    `.${basename(path)}.${String(process.pid)}-${randomUUID()}${PUBLISH_STAGED_SUFFIX}`,
  );
  const fd = nodeOpenSync(staged, 'wx');
  try {
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = nodeWriteSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error('AUTHORITY_PUBLISH_WRITE_STALLED');
        offset += written;
      }
      nodeFsyncSync(fd);
    } finally {
      nodeCloseSync(fd);
    }
    nodeLinkSync(staged, path);
  } catch (error) {
    nodeUnlinkSync(staged);
    throw error;
  }
  hooks.afterLink?.(staged);
  nodeUnlinkSync(staged);
  fsyncDirectory(directory);
}
