import { spawnSync as nodeSpawnSync } from '@devai-nyx/authority';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function gitMutation(
  repoRoot: string,
  args: readonly string[],
  options: {
    readonly env?: Readonly<Record<string, string>>;
    readonly input?: string;
    readonly trimOutput?: boolean;
    readonly error: string;
  },
): string {
  const result = nodeSpawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, ...options.env },
    ...(options.input !== undefined && { input: options.input }),
  });
  if (result.status !== 0) {
    throw new Error(`${options.error}: ${(result.stderr ?? '').trim()}`);
  }
  const stdout = result.stdout ?? '';
  return options.trimOutput === false ? stdout : stdout.trim();
}

export function mutationPaths(repoRoot: string): readonly string[] {
  const tracked = gitMutation(repoRoot, ['diff', '--name-only', '-z', 'HEAD', '--'], {
    trimOutput: false,
    error: 'MUTATION_DIFF_FAILED',
  })
    .split('\0')
    .filter(Boolean);
  const untracked = gitMutation(
    repoRoot,
    ['ls-files', '--others', '--exclude-standard', '-z', '--'],
    {
      trimOutput: false,
      error: 'MUTATION_UNTRACKED_SCAN_FAILED',
    },
  )
    .split('\0')
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}

export function mutationRefs(repoRoot: string): string {
  return gitMutation(repoRoot, ['for-each-ref', '--format=%(refname)%00%(objectname)'], {
    error: 'MUTATION_REF_SNAPSHOT_FAILED',
  });
}

export function recipeRunDirectory(recipeName: string, recipeVariant: string): string {
  return `record/proofs/work/recipe-runs/${recipeName}/${recipeVariant}`;
}

export function runtimeAttributedProofPath(
  recipeName: string,
  recipeVariant: string,
  path: string,
): boolean {
  return (
    path === 'record/proofs/work/llm-usage.jsonl' ||
    path.startsWith(`${recipeRunDirectory(recipeName, recipeVariant)}/`)
  );
}

export function createCommitFromWorktree(input: {
  readonly repo_root: string;
  readonly parent_sha: string;
  readonly paths: readonly string[];
  readonly message: string;
  readonly timestamp: string;
  readonly temporary_index: string;
  readonly force_paths?: readonly string[];
}): string {
  const indexPath = resolve(input.repo_root, input.temporary_index);
  if (existsSync(indexPath)) throw new Error('MUTATION_TEMP_INDEX_EXISTS');
  const env = {
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: 'DEVAI R28 Recorder',
    GIT_AUTHOR_EMAIL: 'r28-recorder@devai.invalid',
    GIT_AUTHOR_DATE: input.timestamp,
    GIT_COMMITTER_NAME: 'DEVAI R28 Recorder',
    GIT_COMMITTER_EMAIL: 'r28-recorder@devai.invalid',
    GIT_COMMITTER_DATE: input.timestamp,
  };
  let commitSha: string | undefined;
  let primaryError: unknown;
  try {
    gitMutation(input.repo_root, ['read-tree', input.parent_sha], {
      env,
      error: 'MUTATION_READ_TREE_FAILED',
    });
    if (input.paths.length > 0) {
      gitMutation(input.repo_root, ['add', '-A', '--', ...input.paths], {
        env,
        error: 'MUTATION_INDEX_FAILED',
      });
    }
    if ((input.force_paths?.length ?? 0) > 0) {
      gitMutation(input.repo_root, ['add', '-f', '-A', '--', ...(input.force_paths ?? [])], {
        env,
        error: 'MUTATION_FORCED_STATE_INDEX_FAILED',
      });
    }
    const tree = gitMutation(input.repo_root, ['write-tree'], {
      env,
      error: 'MUTATION_WRITE_TREE_FAILED',
    });
    commitSha = gitMutation(input.repo_root, ['commit-tree', tree, '-p', input.parent_sha], {
      env,
      input: `${input.message}\n`,
      error: 'MUTATION_COMMIT_TREE_FAILED',
    });
  } catch (error) {
    primaryError = error;
  }
  let cleanupError: unknown;
  try {
    gitMutation(input.repo_root, ['clean', '-f', '-x', '--', input.temporary_index], {
      error: 'MUTATION_TEMP_INDEX_CLEANUP_FAILED',
    });
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError !== undefined && cleanupError !== undefined) {
    const primaryMessage =
      primaryError instanceof Error ? primaryError.message : String(primaryError);
    const cleanupMessage =
      cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    throw new AggregateError([primaryError, cleanupError], `${primaryMessage}; ${cleanupMessage}`);
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
  if (commitSha === undefined) throw new Error('MUTATION_COMMIT_MISSING');
  return commitSha;
}
