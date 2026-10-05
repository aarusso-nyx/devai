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
  renameSync,
  writeSync,
} from '@devai-nyx/authority';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

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

/** Fsync one directory so a created, renamed or removed entry in it is durable. */
export function fsyncDirectorySync(path: string): void {
  const fd = openSync(path, fileOpenConstants.O_RDONLY | (fileOpenConstants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Create `path` and any missing parents, then fsync the parent of every directory that
 * was created, outermost first, so the new chain of entries is durable.
 */
export function mkdirDurableSync(path: string): void {
  const missing: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    missing.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (missing.length === 0) return;
  mkdirSync(path, { recursive: true });
  for (const created of missing) fsyncDirectorySync(dirname(created));
}

/** Create a new file with exactly `text`, refusing to replace one, and make it durable. */
export function writeCreateOnlyDurableSync(path: string, text: string): void {
  mkdirDurableSync(dirname(path));
  const fd = openSync(path, 'wx');
  try {
    writeAllSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectorySync(dirname(path));
}

/** Replace `path` atomically with exactly `text`: a staged, fsynced file renamed into place. */
export function replaceDurableSync(path: string, text: string): void {
  mkdirDurableSync(dirname(path));
  const staged = `${path}.${String(process.pid)}-${randomUUID()}`;
  const fd = openSync(staged, 'wx');
  try {
    writeAllSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(staged, path);
  fsyncDirectorySync(dirname(path));
}
