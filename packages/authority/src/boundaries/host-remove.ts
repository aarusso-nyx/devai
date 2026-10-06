import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import {
  linkSync as nodeLinkSync,
  lstatSync,
  renameSync as nodeRenameSync,
  rmdirSync as nodeRmdirSync,
  unlinkSync as nodeUnlinkSync,
} from 'node:fs';
import type { PublishedFileIdentity } from './host-publish.js';

/** Suffix of the private name an identity-bound removal quarantines an entry under (#317). */
export const REMOVE_QUARANTINE_SUFFIX = '.remove-quarantine';

/**
 * Identity of a file or directory a caller created: device, inode and the inode's birth time
 * in nanoseconds, all bigint stat values. It is the identity the no-replace publication
 * returns, or the fstat of a descriptor the caller holds on a directory it made.
 */
export type EntryIdentity = PublishedFileIdentity;

/**
 * Text form of an identity. The removal effect carries it, not the bigint object, across the
 * authority seam, so a request's arguments stay plain strings.
 */
export function entryIdentityKey(identity: EntryIdentity): string {
  return `${String(identity.dev)}:${String(identity.ino)}:${String(identity.birthtimeNs)}`;
}

/** Parses `entryIdentityKey` text; undefined for any other value. */
export function parseEntryIdentityKey(value: unknown): EntryIdentity | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+):(\d+):(\d+)$/u.exec(value);
  if (match === null) return undefined;
  return {
    dev: BigInt(match[1] ?? ''),
    ino: BigInt(match[2] ?? ''),
    birthtimeNs: BigInt(match[3] ?? ''),
  };
}

/**
 * `removed`: the entry was the identity and is gone. `absent`: nothing was at the path.
 * `mismatch`: another entry was at the path and is back in place. `not-empty`: the directory
 * was the identity but holds an entry, and is back in place.
 */
export type RemoveEntryOutcome = 'removed' | 'absent' | 'mismatch' | 'not-empty';

/** Code of a removal that quarantined another entry and could not put it back (#317). */
export const REMOVE_RESTORE_INCOMPLETE = 'AUTHORITY_REMOVE_RESTORE_INCOMPLETE';

/** The quarantined entry is not the identity and its path is taken: it is left at `quarantine`. */
export class RemoveRestoreIncompleteError extends Error {
  readonly code = REMOVE_RESTORE_INCOMPLETE;
  readonly path: string;
  readonly quarantine: string;

  constructor(path: string, quarantine: string, cause?: unknown) {
    super(`${REMOVE_RESTORE_INCOMPLETE}: ${path} is at ${quarantine}`, { cause });
    this.path = path;
    this.quarantine = quarantine;
  }
}

/** Test seam (fault injection): runs after the entry is quarantined, before it is checked. */
export interface RemoveEntryHooks {
  readonly afterQuarantine?: (quarantine: string) => void;
}

function sameIdentity(
  stat: { readonly dev: bigint; readonly ino: bigint; readonly birthtimeNs: bigint },
  identity: EntryIdentity,
): boolean {
  return (
    stat.dev === identity.dev &&
    stat.ino === identity.ino &&
    stat.birthtimeNs === identity.birthtimeNs
  );
}

/**
 * Puts a quarantined entry that must not be removed back at `path`. A regular file is
 * hard-linked back, so link(2) refuses (EEXIST) rather than replace an entry that took the path
 * meanwhile. A directory or symbolic link cannot be hard-linked; it is renamed back only while
 * the path is absent, which leaves a window between that check and the rename.
 */
function restore(path: string, quarantine: string, regular: boolean): void {
  if (regular) {
    try {
      nodeLinkSync(quarantine, path);
    } catch (error) {
      throw new RemoveRestoreIncompleteError(path, quarantine, error);
    }
    nodeUnlinkSync(quarantine);
    return;
  }
  if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) {
    throw new RemoveRestoreIncompleteError(path, quarantine);
  }
  nodeRenameSync(quarantine, path);
}

/**
 * Identity-bound removal (#317). The entry at `path` is first renamed to a fresh private name
 * beside it, which is atomic and moves whatever is at the path at that instant, so no entry can
 * be swapped in between the check and the removal under the public name. The quarantined entry
 * is then lstat-checked against `identity` and removed (unlink, or a non-recursive rmdir) only
 * when it matches; any other entry, or a directory that is not empty, is put back.
 *
 * The residual window is on the private name: a process that finds the random quarantine name
 * and replaces it between the rename and the check could still have its entry checked; and an
 * entry put back is absent from `path` for the duration of the call.
 */
export function removeEntryIfIdentitySteps(
  path: string,
  identity: EntryIdentity,
  hooks: RemoveEntryHooks = {},
): RemoveEntryOutcome {
  const quarantine = join(
    dirname(path),
    `.${basename(path)}.${String(process.pid)}-${randomUUID()}${REMOVE_QUARANTINE_SUFFIX}`,
  );
  try {
    nodeRenameSync(path, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
  hooks.afterQuarantine?.(quarantine);
  const stat = lstatSync(quarantine, { bigint: true });
  if (!sameIdentity(stat, identity)) {
    restore(path, quarantine, stat.isFile());
    return 'mismatch';
  }
  try {
    if (stat.isDirectory()) nodeRmdirSync(quarantine);
    else nodeUnlinkSync(quarantine);
    return 'removed';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // The entry is still at its private name: put it back before reporting.
    restore(path, quarantine, stat.isFile());
    if (stat.isDirectory() && (code === 'ENOTEMPTY' || code === 'EEXIST')) return 'not-empty';
    throw error;
  }
}
