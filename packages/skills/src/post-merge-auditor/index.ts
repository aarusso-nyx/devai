import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { mkdirSync, renameSync, rmSync } from '@devai-nyx/authority';
import { canonicalSha256, git, gitAdministrationRoot, gitText, sha256 } from './support.js';
import {
  FULL_SHA,
  verifyPostMergeHostReceipt,
  type PostMergeAuditorOptions,
} from './host-receipt.js';
import {
  OBSERVATION_ARTIFACT_NAMES,
  archiveIncompleteObservation,
  commitAuditBundle,
  completedAuditObservationDigest,
  completedObservationDigest,
  writeBundle,
} from './observation-bundle.js';

export { createPostMergeHostScope, verifyPostMergeHostReceipt } from './host-receipt.js';
export type { PostMergeAuditorOptions, VerifiedPostMergeHostReceipt } from './host-receipt.js';

export interface PostMergeAuditorResult {
  readonly status: 'completed' | 'replayed' | 'busy';
  readonly merge_sha: string;
  readonly processed: readonly string[];
  readonly worktree: string;
  readonly cadence: {
    readonly installed_checkout: 'persistent';
    readonly remote_host: 'unknown';
  };
}

export interface AuditObservationResult {
  readonly status: 'completed' | 'replayed';
  readonly at: string;
  readonly readiness_promoting: false;
  readonly observation_root: string;
  readonly artifacts: readonly Readonly<{ path: string; sha256: string }>[];
}

/**
 * Run the post-merge observation engine against the repository's exact current
 * HEAD without requiring a host receipt. This is the explicit Auditor facade;
 * it never promotes readiness and refuses an abbreviated or non-current SHA.
 */
export async function runAuditObservation(opts: {
  readonly repoRoot: string;
  readonly at: string;
}): Promise<AuditObservationResult> {
  const repoRoot = realpathSync(resolve(opts.repoRoot));
  if (!FULL_SHA.test(opts.at)) throw new Error('AUDIT_OBSERVE_FULL_SHA_REQUIRED');
  const head = gitText(repoRoot, ['rev-parse', 'HEAD'], 'AUDIT_OBSERVE_HEAD_UNAVAILABLE');
  if (head !== opts.at) throw new Error('AUDIT_OBSERVE_EXACT_HEAD_REQUIRED');
  const timestamp = gitText(
    repoRoot,
    ['show', '-s', '--format=%cI', opts.at],
    'AUDIT_OBSERVE_TIMESTAMP_UNAVAILABLE',
  );
  const stateRoot = join(repoRoot, '.devai/state/audit-observations');
  const targetRoot = join(stateRoot, opts.at);
  const stagingRoot = join(stateRoot, `${opts.at}.tmp-${process.pid.toString()}`);
  rmSync(stagingRoot, { recursive: true, force: true });
  await writeBundle(
    repoRoot,
    stateRoot,
    opts.at,
    timestamp,
    null,
    null,
    false,
    `${opts.at}.tmp-${process.pid.toString()}`,
  );
  const generatedRoot = stagingRoot;
  const generatedDigest = canonicalSha256(
    Object.fromEntries(
      [...OBSERVATION_ARTIFACT_NAMES, 'status'].map((name) => [
        name,
        JSON.parse(readFileSync(join(generatedRoot, `${name}.json`), 'utf8')) as unknown,
      ]),
    ),
  );
  let status: 'completed' | 'replayed' = 'completed';
  if (existsSync(targetRoot)) {
    const existingDigest = canonicalSha256(
      Object.fromEntries(
        [...OBSERVATION_ARTIFACT_NAMES, 'status'].map((name) => [
          name,
          JSON.parse(readFileSync(join(targetRoot, `${name}.json`), 'utf8')) as unknown,
        ]),
      ),
    );
    rmSync(generatedRoot, { recursive: true, force: true });
    if (existingDigest !== generatedDigest) throw new Error('AUDIT_OBSERVE_REPLAY_DRIFT');
    status = 'replayed';
  } else {
    mkdirSync(dirname(targetRoot), { recursive: true });
    renameSync(generatedRoot, targetRoot);
  }
  const artifacts = [...OBSERVATION_ARTIFACT_NAMES, 'status'].map((name) => {
    const path = join(targetRoot, `${name}.json`);
    return {
      path: relative(repoRoot, path).split(sep).join('/'),
      sha256: sha256(readFileSync(path)),
    };
  });
  return {
    status,
    at: opts.at,
    readiness_promoting: false,
    observation_root: relative(repoRoot, targetRoot).split(sep).join('/'),
    artifacts,
  };
}

export async function runPostMergeAuditor(
  opts: PostMergeAuditorOptions,
): Promise<PostMergeAuditorResult> {
  const repoRoot = realpathSync(resolve(opts.repoRoot));
  const verified = verifyPostMergeHostReceipt({ ...opts, repoRoot });
  const worktreeRoot = join(repoRoot, '.devai/worktrees/auditor-post-merge');
  const runtimeRoot = join(gitAdministrationRoot(repoRoot), 'devai');
  const stateRoot = join(runtimeRoot, 'post-merge-observations');
  const lockPath = join(runtimeRoot, 'post-merge.lock');
  return (async () => {
    try {
      mkdirSync(lockPath);
    } catch (error) {
      if (existsSync(lockPath)) {
        return {
          status: 'busy',
          merge_sha: verified.mergeSha,
          processed: [],
          worktree: worktreeRoot,
          cadence: { installed_checkout: 'persistent', remote_host: 'unknown' },
        };
      }
      throw error;
    }
    try {
      const merges = gitText(
        repoRoot,
        [
          'rev-list',
          '--first-parent',
          '--merges',
          '--reverse',
          `${verified.baselineSha}..${verified.mergeSha}`,
        ],
        'POST_MERGE_HISTORY_UNAVAILABLE',
      )
        .split(/\r?\n/u)
        .filter((sha) => FULL_SHA.test(sha));
      if (!existsSync(worktreeRoot)) {
        mkdirSync(dirname(worktreeRoot), { recursive: true });
        const added = git(repoRoot, [
          'worktree',
          'add',
          '--detach',
          worktreeRoot,
          verified.mergeSha,
        ]);
        if (added.status !== 0) throw new Error('POST_MERGE_WORKTREE_CREATE_FAILED');
      }
      assertCleanObservationWorktree(worktreeRoot);
      const processed: string[] = [];
      let previousMergeSha: string | null = null;
      let previousDigest: string | null = null;
      for (const mergeSha of merges) {
        const completedDigest = completedObservationDigest(stateRoot, mergeSha);
        const committedDigest = completedAuditObservationDigest(worktreeRoot, mergeSha);
        if (completedDigest !== null && committedDigest === completedDigest) {
          previousMergeSha = mergeSha;
          previousDigest = completedDigest;
          continue;
        }
        const checkout = git(worktreeRoot, ['checkout', '--detach', mergeSha]);
        if (checkout.status !== 0) throw new Error('POST_MERGE_WORKTREE_ADVANCE_FAILED');
        archiveIncompleteObservation(stateRoot, mergeSha);
        previousDigest = await writeBundle(
          worktreeRoot,
          stateRoot,
          mergeSha,
          opts.now ?? new Date().toISOString(),
          previousMergeSha,
          previousDigest,
          opts.injectFailure === true,
        );
        commitAuditBundle(worktreeRoot, stateRoot, mergeSha);
        previousMergeSha = mergeSha;
        processed.push(mergeSha);
      }
      assertCleanObservationWorktree(worktreeRoot);
      return {
        status: processed.length === 0 ? 'replayed' : 'completed',
        merge_sha: verified.mergeSha,
        processed,
        worktree: worktreeRoot,
        cadence: { installed_checkout: 'persistent', remote_host: 'unknown' },
      };
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }
  })();
}

export function assertCleanObservationWorktree(worktreeRoot: string): void {
  const clean = git(worktreeRoot, ['status', '--porcelain']);
  if (clean.status !== 0 || clean.stdout.trim().length > 0) {
    throw new Error('POST_MERGE_WORKTREE_DIRTY');
  }
}
