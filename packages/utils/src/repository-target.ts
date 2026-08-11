import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type RepositoryTargetKind = 'test' | 'file';

export interface RepositoryTargetValidation {
  readonly ok: boolean;
  readonly absolutePath: string;
  readonly repositoryPath: string;
  readonly reason?: string;
}

/**
 * Shared lexical and file-kind boundary for repository-relative evidence targets.
 * Tracking is deliberately checked by callers because it requires a Git process,
 * while this primitive stays deterministic and host-effect free.
 */
export function validateRepositoryTarget(
  repoRoot: string,
  candidatePath: string,
  kind: RepositoryTargetKind,
): RepositoryTargetValidation {
  const root = resolve(repoRoot);
  const absolutePath = resolve(root, candidatePath);
  const repositoryPath = relative(root, absolutePath).split(sep).join('/');
  const contained =
    candidatePath.length > 0 &&
    !isAbsolute(candidatePath) &&
    !candidatePath.includes('\\') &&
    repositoryPath.length > 0 &&
    repositoryPath !== '..' &&
    !repositoryPath.startsWith('../');
  if (!contained) {
    return {
      ok: false,
      absolutePath,
      repositoryPath,
      reason: 'path is not repository-relative and contained',
    };
  }

  let file = false;
  try {
    file = statSync(absolutePath).isFile();
  } catch {
    file = false;
  }
  if (!file) {
    return {
      ok: false,
      absolutePath,
      repositoryPath,
      reason: 'path does not resolve to a regular file',
    };
  }
  if (kind === 'test' && !/\.(?:test|spec)\.(?:ts|mjs)$/u.test(repositoryPath)) {
    return {
      ok: false,
      absolutePath,
      repositoryPath,
      reason: 'path is not an executable test filename',
    };
  }
  return { ok: true, absolutePath, repositoryPath };
}
