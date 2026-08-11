import { spawnSync } from '@devai-nyx/authority';

export interface EvidenceTreeIdentity {
  readonly algorithm: 'sha1' | 'sha256';
  readonly value: string;
}

export interface LocalEvidenceSubject {
  readonly repository: string;
  readonly commitSha: string;
  readonly tree: EvidenceTreeIdentity;
}

function git(repoRoot: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function repositoryFromRemote(remote: string): string {
  const withoutSuffix = remote.replace(/\.git$/u, '');
  const scp = /^[^@]+@[^:]+:(.+)$/u.exec(withoutSuffix)?.[1];
  if (scp !== undefined) return scp;
  try {
    const url = new URL(withoutSuffix);
    const path = url.pathname.replace(/^\/+|\/+$/gu, '');
    if (path.length > 0) return path;
  } catch {
    // Fall through to an exact path-shaped remote (for local test repositories).
  }
  const path = withoutSuffix.replace(/^\/+|\/+$/gu, '');
  if (path.length === 0) throw new Error('cannot derive repository identity from origin');
  return path;
}

export function deriveExactSubject(repoRoot: string, ref = 'HEAD'): LocalEvidenceSubject {
  const dirtyTracked = git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=no']);
  if (dirtyTracked.length > 0) {
    throw new Error('local evidence requires a clean tracked index and worktree');
  }
  const repository = repositoryFromRemote(git(repoRoot, ['config', '--get', 'remote.origin.url']));
  const commitSha = git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
  const treeValue = git(repoRoot, ['rev-parse', '--verify', `${ref}^{tree}`]);
  const algorithm = treeValue.length === 64 ? 'sha256' : 'sha1';
  return { repository, commitSha, tree: { algorithm, value: treeValue } };
}

export function deriveTrailerParentSubject(
  repoRoot: string,
  manifestPath: string,
): LocalEvidenceSubject {
  const parents = git(repoRoot, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(/\s+/u);
  if (parents.length !== 2) {
    throw new Error('local evidence trailer commit must have exactly one parent');
  }
  const changed = git(repoRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])
    .split('\n')
    .filter(Boolean);
  if (changed.length !== 1 || changed[0] !== manifestPath) {
    throw new Error('local evidence trailer commit must change only the declared manifest');
  }
  return deriveExactSubject(repoRoot, 'HEAD^');
}
