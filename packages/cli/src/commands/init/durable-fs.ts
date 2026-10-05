import { closeSync, fsyncSync, openSync } from '@devai-nyx/authority';
import { constants } from 'node:fs';

function hasCode(error: unknown, codes: readonly string[]): boolean {
  return error instanceof Error && 'code' in error && codes.includes(String(error.code));
}

/**
 * Flush one file or directory to stable storage (#264): the bind journal orders its writes
 * through this so the journal is durable before the first target write and every target and
 * the receipt are durable before the journal is removed. A path that does not exist is a
 * no-op; a platform that refuses fsync on a directory descriptor keeps the file flushes.
 */
export function fsyncPath(path: string): void {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
  } catch (error) {
    if (hasCode(error, ['ENOENT'])) return;
    throw error;
  }
  try {
    fsyncSync(descriptor);
  } catch (error) {
    if (!hasCode(error, ['EINVAL', 'EISDIR', 'EPERM', 'EBADF', 'ENOTSUP'])) throw error;
  } finally {
    closeSync(descriptor);
  }
}
