import { readProcessSync } from '@devai-nyx/authority';

export function git(repoRoot: string, args: readonly string[], trim = true): string | null {
  const result = readProcessSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? (trim ? result.stdout.trim() : result.stdout) : null;
}

export function gitFile(repoRoot: string, commit: string, path: string): string | null {
  return git(repoRoot, ['show', `${commit}:${path}`], false);
}

interface HistoricalPath {
  readonly commit: string;
  readonly path: string;
}

export function recordHistory(repoRoot: string, path: string): HistoricalPath[] | null {
  const output = git(repoRoot, [
    'log',
    '--follow',
    '--find-renames=1%',
    '--format=%H',
    '--name-status',
    '--',
    path,
  ]);
  if (output === null) return null;
  const entries: HistoricalPath[] = [];
  let commit: string | undefined;
  for (const line of output.split('\n').map((value) => value.trim())) {
    if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(line)) {
      commit = line;
    } else if (line.length > 0 && commit !== undefined) {
      const fields = line.split('\t');
      const status = fields[0] ?? '';
      const copied = status.startsWith('C');
      const historicalPath = status.startsWith('R') || copied ? fields[2] : fields[1];
      if (historicalPath === undefined) continue;
      entries.push({ commit, path: historicalPath });
      commit = undefined;
      // `--follow` traverses both renames and sufficiently similar copies. A rename is
      // the same record and must retain its seal; a copy starts a distinct record whose
      // source history must not be inherited.
      if (copied) break;
    }
  }
  return entries.reverse();
}
