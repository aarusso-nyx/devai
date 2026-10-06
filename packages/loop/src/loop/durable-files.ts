/**
 * Durable record writes for experimental dispatch state. A record that is acknowledged
 * must survive a power loss: every byte is written (a short `write` never leaves a
 * partial record behind), the file is fsynced, and so is each directory whose entry
 * changed, including directories this call created.
 */
import {
  closeSync,
  existsSync,
  fileOpenConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  PUBLISH_INDETERMINATE,
  publishFileNoReplaceSync,
  renameSync,
  writeSync,
} from '@devai-nyx/authority';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';

/** Write every byte of `text`, looping over short writes. */
export function writeAllSync(fd: number, text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('DURABLE_WRITE_STALLED');
    offset += written;
  }
}

export interface DirectoryFsyncOptions {
  /**
   * `skip` returns quietly where the platform or filesystem cannot open or fsync a
   * directory at all (Windows, some network filesystems); the default throws.
   */
  readonly unsupported?: 'throw' | 'skip';
}

const UNSUPPORTED_DIRECTORY_OPEN = new Set(['EISDIR', 'EPERM', 'EACCES']);
const UNSUPPORTED_DIRECTORY_FSYNC = new Set(['EINVAL', 'ENOTSUP', 'EPERM']);

function errorCode(error: unknown): string {
  return String((error as NodeJS.ErrnoException).code);
}

/**
 * Fsync one directory so a created, renamed or removed entry in it is durable. This is the
 * one directory fsync of the loop: experimental records use the strict default, and the
 * lock and controller records pass `unsupported: 'skip'`.
 */
export function fsyncDirectorySync(path: string, options: DirectoryFsyncOptions = {}): void {
  const skip = options.unsupported === 'skip';
  let fd: number;
  try {
    fd = openSync(path, fileOpenConstants.O_RDONLY | (fileOpenConstants.O_DIRECTORY ?? 0));
  } catch (error) {
    if (skip && UNSUPPORTED_DIRECTORY_OPEN.has(errorCode(error))) return;
    throw error;
  }
  try {
    fsyncSync(fd);
  } catch (error) {
    if (!(skip && UNSUPPORTED_DIRECTORY_FSYNC.has(errorCode(error)))) throw error;
  } finally {
    closeSync(fd);
  }
}

const STATE_ROOT = `${sep}.devai${sep}state`;

/**
 * The `.devai/state` directory that contains `path`, if any. Directory fsyncs stop there:
 * an action holding state authority may touch only paths at or below it.
 */
function stateRoot(path: string): string | undefined {
  const absolute = resolve(path);
  const index = absolute.indexOf(`${STATE_ROOT}${sep}`);
  if (index >= 0) return absolute.slice(0, index + STATE_ROOT.length);
  return absolute.endsWith(STATE_ROOT) ? absolute : undefined;
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

/**
 * Create `path` and any missing parents, then fsync the parent of every directory that
 * was created, outermost first, so the new chain of entries is durable. Under
 * `.devai/state` the fsyncs stop at that root, which always exists once DEVAI is adopted.
 */
export function mkdirDurableSync(path: string): void {
  const missing: string[] = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    missing.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (missing.length === 0) return;
  mkdirSync(path, { recursive: true });
  const root = stateRoot(path);
  for (const created of missing) {
    const parent = dirname(created);
    if (root === undefined || within(parent, root)) fsyncDirectorySync(parent);
  }
}

/** Write `text` completely to a fresh staged file beside `path`, fsynced; returns its path. */
function stage(path: string, text: string): string {
  const staged = `${path}.${String(process.pid)}-${randomUUID()}`;
  const fd = openSync(staged, 'wx');
  try {
    writeAllSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return staged;
}

/** Whether an error is the EEXIST refusal of a no-replace publication. */
export function isExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
}

/**
 * `DURABLE_PUBLICATION_INDETERMINATE`: the record is in place with the caller's complete
 * bytes, but the publication's cleanup failed, so its durability is not established. The
 * caller owns the record: a lock holder releases it, and a create-only writer must not
 * report success.
 */
export class PublicationIndeterminate extends Error {
  readonly code = 'DURABLE_PUBLICATION_INDETERMINATE';
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super('DURABLE_PUBLICATION_INDETERMINATE', { cause });
    this.path = path;
  }
}

function publish(path: string, text: string): void {
  try {
    publishFileNoReplaceSync(path, text);
  } catch (error) {
    if ((error as { code?: unknown } | undefined)?.code === PUBLISH_INDETERMINATE) {
      throw new PublicationIndeterminate(path, error);
    }
    throw error;
  }
}

/**
 * Create `path` with exactly `text`, refusing (`DURABLE_RECORD_EXISTS`) when it exists. The
 * governed no-replace publication (ADR-AUT-0005) links a staged, fsynced file into place and
 * fsyncs the directory, so a crash never leaves a partial record and two concurrent writers
 * of the same record never replace each other: exactly one succeeds.
 */
export function writeCreateOnlyDurableSync(path: string, text: string): void {
  mkdirDurableSync(dirname(path));
  try {
    publish(path, text);
  } catch (error) {
    if (isExistsError(error)) throw new Error('DURABLE_RECORD_EXISTS');
    throw error;
  }
}

/**
 * Publish `text` at `path` only when `path` is absent, durably, returning false when it
 * already exists. Used for exclusive records such as locks: a reader never sees an empty or
 * partial file, because the name appears only once the complete bytes are linked into place.
 * An indeterminate publication throws `PublicationIndeterminate`: the record is the caller's.
 */
export function publishCreateOnlyDurableSync(path: string, text: string): boolean {
  mkdirDurableSync(dirname(path));
  try {
    publish(path, text);
    return true;
  } catch (error) {
    if (isExistsError(error)) return false;
    throw error;
  }
}

/** Replace `path` atomically with exactly `text`: a staged, fsynced file renamed into place. */
export function replaceDurableSync(path: string, text: string): void {
  mkdirDurableSync(dirname(path));
  renameSync(stage(path, text), path);
  fsyncDirectorySync(dirname(path));
}
