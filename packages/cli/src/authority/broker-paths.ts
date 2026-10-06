import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { AuthorityHostEffectRequest } from '@devai-nyx/authority';
import type { JsonRecord } from './broker-values.js';

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

export function canonicalRelativePath(root: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('AUTHORITY_FS_TARGET_INVALID');
  }
  // Mirror node:fs path semantics before checking repository containment.
  // Relative host-effect arguments are resolved from the process cwd, not
  // from the governed repository root. Resolving them from `root` duplicated
  // a relative `--target` prefix (for example adopter/adopter/docs/...) and
  // produced a late UNCLASSIFIED_RESOURCE refusal after command dispatch.
  const absolute = resolve(value);
  const canonical = existingRealpath(absolute);
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
  if (['rmSync', 'rmdirSync', 'unlinkSync'].includes(symbol)) return 'delete';
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
  const canonicalPath = canonicalRelativePath(root, rawPath);
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
