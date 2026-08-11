import { execFileSync } from '@devai-nyx/authority';

export interface GitContext {
  head_sha: string | null;
  dirty_files: string[];
}

/**
 * Gather git context (head SHA + dirty files) for a directory.
 *
 * Returns `{ head_sha: null, dirty_files: [] }` if `cwd` is not a git
 * repository or if `git` is unavailable. Never throws.
 */
export function gatherGitContext(cwd: string = process.cwd()): GitContext {
  let head_sha: string | null = null;
  let dirty_files: string[] = [];

  try {
    head_sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return { head_sha: null, dirty_files: [] };
  }

  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Each line: "XY path" — slice(3) drops the two-char status code + space.
    dirty_files = status
      .split('\n')
      .map((line) => (line.length > 3 ? line.slice(3) : ''))
      .filter((path) => path.length > 0);
  } catch {
    dirty_files = [];
  }

  return { head_sha, dirty_files };
}
