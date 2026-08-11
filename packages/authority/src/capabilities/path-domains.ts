import { isAbsolute, relative, resolve, sep } from 'node:path';

export type AuthorityFsCapability =
  | 'fs:f5-config'
  | 'fs:f5-state'
  | 'fs:f4-inventory'
  | 'fs:proofs'
  | 'fs:worktree-admin'
  | 'fs:workspace';

function segments(repoRoot: string, target: string): readonly string[] | undefined {
  const root = resolve(repoRoot);
  const absolute = isAbsolute(target) ? resolve(target) : resolve(root, target);
  const fromRoot = relative(root, absolute);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    return undefined;
  }
  return fromRoot.split(sep).filter((part) => part.length > 0);
}

export function classifyAuthorityPath(repoRoot: string, target: string): AuthorityFsCapability {
  const path = segments(repoRoot, target);
  if (!path) return 'fs:workspace';
  if (path[0] === '.devai') {
    if (path[1] === 'state') return 'fs:f5-state';
    if (path[1] === 'pin' || path[1] === 'config' || path[1] === 'constitution.md') {
      return 'fs:f5-config';
    }
  }
  if (path[0] === 'record' && path[1] === 'derived' && path[2] === 'inventory') {
    return 'fs:f4-inventory';
  }
  if (path[0] === 'record' && path[1] === 'proofs') return 'fs:proofs';
  if (path[0] === 'scratch' && path[1] === 'worktrees') return 'fs:worktree-admin';
  return 'fs:workspace';
}

export function assertAuthorityPathCapability(
  allowed: readonly string[],
  repoRoot: string,
  target: string,
): void {
  const actual = classifyAuthorityPath(repoRoot, target);
  if (!allowed.includes(actual)) {
    throw new Error(`AUTHORITY_PATH_DOMAIN_VIOLATION:${actual}`);
  }
}
