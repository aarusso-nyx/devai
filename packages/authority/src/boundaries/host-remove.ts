import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import {
  linkSync as nodeLinkSync,
  lstatSync,
  readdirSync,
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
 * `mismatch`: another entry is at the path, untouched (or, for a file swapped in during the
 * removal, put back). `not-empty`: the directory is the identity but holds an entry, untouched.
 */
export type RemoveEntryOutcome = 'removed' | 'absent' | 'mismatch' | 'not-empty';

/** Code of a removal that left an entry at its quarantine name (#317). */
export const REMOVE_RESTORE_INCOMPLETE = 'AUTHORITY_REMOVE_RESTORE_INCOMPLETE';

/** An entry the removal did not remove and could not put back: it is left at `quarantine`. */
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

/**
 * Test seams (fault injection): `afterPrecheck` runs after the entry at the path was found to be
 * the identity and before it is quarantined; `afterQuarantine` runs after the rename, before the
 * quarantined entry is checked.
 */
export interface RemoveEntryHooks {
  readonly afterPrecheck?: () => void;
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
 * Puts a quarantined entry that must not be removed back at `path`. Only a regular file (or
 * another non-directory, non-link entry) is put back, by a hard link: link(2) refuses EEXIST
 * rather than replace an entry that took the path meanwhile. A directory or symbolic link has
 * no such primitive in Node, so it is never moved back: it stays in quarantine. Either way an
 * entry that is not put back refuses with AUTHORITY_REMOVE_RESTORE_INCOMPLETE, naming the
 * quarantine path.
 */
function restore(path: string, quarantine: string, linkable: boolean): void {
  if (!linkable) throw new RemoveRestoreIncompleteError(path, quarantine);
  try {
    nodeLinkSync(quarantine, path);
  } catch (error) {
    throw new RemoveRestoreIncompleteError(path, quarantine, error);
  }
  nodeUnlinkSync(quarantine);
}

/**
 * Identity-bound removal (#317).
 *
 * 1. The entry at `path` is lstat-checked first: an entry that is not `identity` (or a directory
 *    that holds entries) is left untouched, `mismatch` (or `not-empty`).
 * 2. A matching entry is renamed to a fresh private name beside it. The rename is atomic and
 *    moves whatever is at the path at that instant, so the check and the removal act on one
 *    entry, never one swapped in at the public name afterwards.
 * 3. The quarantined entry is checked again and removed (unlink, or a non-recursive rmdir) only
 *    when it is `identity`. An entry swapped in between steps 1 and 2 is put back only when it
 *    is a regular file (a no-replace hard link); a directory or link stays in quarantine and the
 *    removal refuses with AUTHORITY_REMOVE_RESTORE_INCOMPLETE, as does a matching directory that
 *    gained an entry after step 1.
 *
 * Residual: a process that finds the random quarantine name and replaces that entry between the
 * rename and the check can still have its entry checked (it is removed only if it carries the
 * identity), and an entry put back is absent from `path` while the removal runs. The rename
 * resolves the parent by path: its containment is the caller's (the broker re-verifies it
 * around the effect).
 */
export function removeEntryIfIdentitySteps(
  path: string,
  identity: EntryIdentity,
  hooks: RemoveEntryHooks = {},
): RemoveEntryOutcome {
  const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (current === undefined) return 'absent';
  if (!sameIdentity(current, identity)) return 'mismatch';
  if (current.isDirectory() && readdirSync(path).length > 0) return 'not-empty';
  hooks.afterPrecheck?.();
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
  const linkable = !stat.isDirectory() && !stat.isSymbolicLink();
  if (!sameIdentity(stat, identity)) {
    restore(path, quarantine, linkable);
    return 'mismatch';
  }
  try {
    if (stat.isDirectory()) nodeRmdirSync(quarantine);
    else nodeUnlinkSync(quarantine);
    return 'removed';
  } catch (error) {
    // The entry is still at its private name: put it back (a file) or report it (a directory).
    if (linkable) {
      restore(path, quarantine, true);
      throw error;
    }
    throw new RemoveRestoreIncompleteError(path, quarantine, error);
  }
}
