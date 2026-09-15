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
    const status = execFileSync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    // NUL records preserve Git paths without quoting or line-break ambiguity.
    // Rename/copy records put the destination first and the source in the next record.
    const records = status.split('\0');
    const paths = new Set<string>();
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record === undefined || record.length <= 3) continue;
      paths.add(record.slice(3));
      const change = record.slice(0, 2);
      if (change.includes('R') || change.includes('C')) {
        const source = records[++index];
        if (source !== undefined && source.length > 0) paths.add(source);
      }
    }
    dirty_files = [...paths];
  } catch {
    dirty_files = [];
  }

  return { head_sha, dirty_files };
}
