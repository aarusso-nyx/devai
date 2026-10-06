import { existsSync, fstatSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  closeReadOnlySync,
  openReadOnlyNoFollowSync,
  type AuthorityHostEffectRequest,
} from '@devai-nyx/authority';
import type { JsonRecord } from './broker-values.js';

/**
 * The physical parent directory of the canonical target the broker authorized: the
 * repository's realpath joined with the target's parent, or the real Git metadata directory
 * for a `.git/devai` or `.git/hooks` logical path.
 */
function authorizedCanonicalParent(root: string, canonicalPath: string): string {
  const physical =
    canonicalPath === '.git/devai' ||
    canonicalPath.startsWith('.git/devai/') ||
    canonicalPath === '.git/hooks' ||
    canonicalPath.startsWith('.git/hooks/')
      ? physicalCanonicalPath(root, canonicalPath)
      : join(realpathSync(root), canonicalPath);
  return dirname(physical);
}

/**
 * Wraps the apply step of an identity-bound removal (#317). Node has no directory-relative
 * rename, so the effect renames by path. At effect time the requested path's parent is opened
 * without following a final link and pinned; immediately before the effect, and after it on
 * success and on failure alike, that parent's realpath must be the parent of the canonical
 * target the broker authorized and its identity the pinned one. Otherwise the removal refuses
 * with AUTHORITY_REMOVE_PARENT_ESCAPED (with any failure of the effect as its cause): a missing
 * parent refuses too, since the authorized parent existed. The residual is an ancestor swapped
 * and swapped back inside the effect, between the two checks.
 */
export function removalWithPinnedParent(
  root: string,
  canonicalPath: string,
  requested: unknown,
  apply: () => unknown,
): () => unknown {
  if (typeof requested !== 'string') throw new Error('AUTHORITY_FS_TARGET_INVALID');
  const parent = dirname(resolve(requested));
  const authorizedParent = authorizedCanonicalParent(root, canonicalPath);
  return () => {
    let descriptor: number;
    try {
      descriptor = openReadOnlyNoFollowSync(parent, true);
    } catch (error) {
      throw new Error('AUTHORITY_REMOVE_PARENT_ESCAPED', { cause: error });
    }
    try {
      const pinned = fstatSync(descriptor, { bigint: true });
      const bound = (): boolean => {
        try {
          const current = statSync(parent, { bigint: true });
          return (
            realpathSync(parent) === authorizedParent &&
            current.dev === pinned.dev &&
            current.ino === pinned.ino &&
            current.birthtimeNs === pinned.birthtimeNs
          );
        } catch {
          return false;
        }
      };
      if (!bound()) throw new Error('AUTHORITY_REMOVE_PARENT_ESCAPED');
      // The post-effect check runs whether the effect returned or threw.
      let outcome:
        | { readonly ok: true; readonly value: unknown }
        | { readonly ok: false; readonly error: unknown };
      try {
        outcome = { ok: true, value: apply() };
      } catch (error) {
        outcome = { ok: false, error };
      }
      if (!bound()) {
        throw new Error(
          'AUTHORITY_REMOVE_PARENT_ESCAPED',
          outcome.ok ? {} : { cause: outcome.error },
        );
      }
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    } finally {
      closeReadOnlySync(descriptor);
    }
  };
}

export function existingRealpath(path: string): string {
  let cursor = path;
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return path;
    suffix.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

interface GitMetadataLayout {
  readonly admin_root: string;
  readonly common_root: string;
}

export function gitMetadataLayout(root: string): GitMetadataLayout | undefined {
  const marker = resolve(root, '.git');
  if (!existsSync(marker)) return undefined;
  const markerStat = statSync(marker);
  let adminRoot: string;
  if (markerStat.isDirectory()) {
    adminRoot = realpathSync(marker);
  } else if (markerStat.isFile()) {
    const match = /^gitdir:\s*(.+)\s*$/u.exec(readFileSync(marker, 'utf8').trim());
    if (!match?.[1]) return undefined;
    adminRoot = realpathSync(resolve(root, match[1]));
  } else {
    return undefined;
  }
  const commonMarker = resolve(adminRoot, 'commondir');
  const commonRoot = existsSync(commonMarker)
    ? realpathSync(resolve(adminRoot, readFileSync(commonMarker, 'utf8').trim()))
    : adminRoot;
  return { admin_root: adminRoot, common_root: commonRoot };
}

export function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export function gitMetadataLogicalPath(root: string, canonical: string): string | undefined {
  const layout = gitMetadataLayout(root);
  if (!layout) return undefined;
  const namespaces = [
    { physical: resolve(layout.admin_root, 'devai'), logical: '.git/devai' },
    { physical: resolve(layout.common_root, 'hooks'), logical: '.git/hooks' },
  ] as const;
  for (const namespace of namespaces) {
    if (!within(namespace.physical, canonical)) continue;
    const suffix = relative(namespace.physical, canonical).split(sep).join('/');
    return suffix.length === 0 ? namespace.logical : `${namespace.logical}/${suffix}`;
  }
  return undefined;
}

export function physicalCanonicalPath(root: string, canonicalRelativePath: string): string {
  const layout = gitMetadataLayout(root);
  if (layout) {
    const namespaces = [
      { logical: '.git/devai', physical: resolve(layout.admin_root, 'devai') },
      { logical: '.git/hooks', physical: resolve(layout.common_root, 'hooks') },
    ] as const;
    for (const namespace of namespaces) {
      if (
        canonicalRelativePath === namespace.logical ||
        canonicalRelativePath.startsWith(`${namespace.logical}/`)
      ) {
        const suffix = canonicalRelativePath.slice(namespace.logical.length).replace(/^\//u, '');
        const candidate = resolve(namespace.physical, suffix);
        if (!within(namespace.physical, candidate)) {
          throw new Error('AUTHORITY_FS_SYMLINK_ESCAPE');
        }
        return candidate;
      }
    }
  }
  return resolve(root, canonicalRelativePath);
}

export function canonicalRelativePath(root: string, value: unknown, followFinal = true): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('AUTHORITY_FS_TARGET_INVALID');
  }
  // Mirror node:fs path semantics before checking repository containment.
  // Relative host-effect arguments are resolved from the process cwd, not
  // from the governed repository root. Resolving them from `root` duplicated
  // a relative `--target` prefix (for example adopter/adopter/docs/...) and
  // produced a late UNCLASSIFIED_RESOURCE refusal after command dispatch.
  const absolute = resolve(value);
  // An effect on the entry itself (an identity-bound removal, #317) acts on a final symbolic
  // link, not on what it points to: only the parent is resolved.
  const canonical = followFinal
    ? existingRealpath(absolute)
    : join(existingRealpath(dirname(absolute)), basename(absolute));
  const canonicalRoot = realpathSync(root);
  if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) {
    const metadataPath = gitMetadataLogicalPath(root, canonical);
    if (metadataPath) return metadataPath;
    throw new Error('AUTHORITY_FS_SYMLINK_ESCAPE');
  }
  const result = relative(canonicalRoot, canonical).split(sep).join('/');
  if (result.length === 0 || result.startsWith('../') || isAbsolute(result)) {
    throw new Error('AUTHORITY_FS_TARGET_INVALID');
  }
  return result;
}

function pathOperation(symbol: string, targetPath: string): 'create' | 'update' | 'delete' {
  if (['rmSync', 'rmdirSync', 'unlinkSync', 'removeEntryIfIdentitySync'].includes(symbol))
    return 'delete';
  // A no-replace publication only ever creates its target (ADR-AUT-0005).
  if (['mkdirSync', 'mkdtempSync', 'symlinkSync', 'publishFileNoReplaceSync'].includes(symbol))
    return 'create';
  return existsSync(targetPath) ? 'update' : 'create';
}

function pathArgument(request: AuthorityHostEffectRequest): unknown {
  if (['copyFileSync', 'cpSync', 'symlinkSync'].includes(request.symbol)) {
    return request.arguments[1];
  }
  return request.arguments[0];
}

export function fsTarget(
  request: AuthorityHostEffectRequest,
  root: string,
  repositoryId: string,
  descriptorTargets: ReadonlyMap<number, JsonRecord> = new Map(),
): JsonRecord {
  if (['writeSync', 'fsyncSync', 'closeSync'].includes(request.symbol)) {
    const descriptor = request.arguments[0];
    const bound = typeof descriptor === 'number' ? descriptorTargets.get(descriptor) : undefined;
    if (!bound) throw new Error('AUTHORITY_FS_DESCRIPTOR_UNKNOWN');
    return { ...bound, operation: 'update' };
  }
  if (request.symbol === 'renameSync') {
    const source = canonicalRelativePath(root, request.arguments[0]);
    const destination = canonicalRelativePath(root, request.arguments[1]);
    return {
      kind: 'fs',
      id: `fs:${source}->${destination}`,
      repository_id: repositoryId,
      canonical_relative_path: destination,
      operation: 'rename',
      rename_from_canonical_relative_path: source,
    };
  }
  const rawPath = pathArgument(request);
  if (typeof rawPath !== 'string') throw new Error('AUTHORITY_FS_TARGET_INVALID');
  const canonicalPath = canonicalRelativePath(
    root,
    rawPath,
    request.symbol !== 'removeEntryIfIdentitySync',
  );
  return {
    kind: 'fs',
    id: `fs:${canonicalPath}`,
    repository_id: repositoryId,
    canonical_relative_path: canonicalPath,
    operation: pathOperation(request.symbol, resolve(root, rawPath)),
  };
}

export function snapshot(root: string, relativePath: string): unknown {
  const path = physicalCanonicalPath(root, relativePath);
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  return {
    kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file',
    mode: stat.mode,
    size: stat.size,
    mtime_ms: stat.mtimeMs,
  };
}
