import { isAbsolute, relative, resolve } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import {
  git,
  isTestPath,
  json,
  requireGit,
  type TaskRecord,
  type TestRef,
  type TraceRecord,
  type TranslationWitness,
} from './translation-support.js';

/** Read the untrusted witness from inside the repository and validate its shape. */
export function readTranslationWitness(
  repoRoot: string,
  witnessOption: string,
): { readonly rawWitness: unknown; readonly witness: TranslationWitness } {
  const witnessPath = resolve(repoRoot, witnessOption);
  const witnessRelative = relative(repoRoot, witnessPath);
  if (witnessRelative.startsWith('..') || isAbsolute(witnessRelative)) {
    throw new Error('WITNESS_PATH_OUTSIDE_REPOSITORY');
  }
  const rawWitness = json(witnessPath);
  if (!validators.translationWitness(rawWitness)) {
    throw new Error(
      `TRANSLATION_WITNESS_INVALID: ${JSON.stringify(validators.translationWitness.errors ?? [])}`,
    );
  }
  const witness = rawWitness as TranslationWitness;
  return { rawWitness, witness };
}

/** Read the witness task and require the same task id and authority role. */
export function readTranslationTask(repoRoot: string, witness: TranslationWitness): TaskRecord {
  const taskPath = resolve(repoRoot, `.devai/state/tasks/${witness.task_id}.json`);
  const rawTask = json(taskPath);
  if (!validators.task(rawTask)) throw new Error('TRANSLATION_TASK_INVALID');
  const task = rawTask as TaskRecord;
  if (task.id !== witness.task_id || task.discipline !== witness.frame.authority_role) {
    throw new Error('TRANSLATION_TASK_AUTHORITY_MISMATCH');
  }
  return task;
}

/** Require the base, candidate and any test overlay objects and their ancestry. */
export function assertTranslationAncestry(repoRoot: string, witness: TranslationWitness): void {
  requireGit(repoRoot, ['cat-file', '-e', `${witness.base_sha}^{commit}`], 'BASE_OBJECT_INVALID');
  requireGit(
    repoRoot,
    ['cat-file', '-e', `${witness.candidate_sha}^{commit}`],
    'CANDIDATE_OBJECT_INVALID',
  );
  if (witness.strategy === 'feature-overlay') {
    if (witness.test_overlay_sha === undefined) throw new Error('TEST_OVERLAY_OBJECT_MISSING');
    requireGit(
      repoRoot,
      ['cat-file', '-e', `${witness.test_overlay_sha}^{commit}`],
      'TEST_OVERLAY_OBJECT_INVALID',
    );
    const parents = requireGit(
      repoRoot,
      ['rev-list', '--parents', '-n', '1', witness.test_overlay_sha],
      'TEST_OVERLAY_PARENT_INVALID',
    )
      .split(' ')
      .filter((parent) => parent.length > 0)
      .slice(1);
    if (parents.length !== 1 || parents[0] !== witness.base_sha) {
      throw new Error('TEST_OVERLAY_PARENT_MISMATCH');
    }
    const ancestry = git(repoRoot, [
      'merge-base',
      '--is-ancestor',
      witness.test_overlay_sha,
      witness.candidate_sha,
    ]);
    if (ancestry.status !== 0) throw new Error('CANDIDATE_NOT_DESCENDANT_OF_TEST_OVERLAY');
  } else {
    const ancestry = git(repoRoot, [
      'merge-base',
      '--is-ancestor',
      witness.base_sha,
      witness.candidate_sha,
    ]);
    if (ancestry.status !== 0) throw new Error('CANDIDATE_NOT_DESCENDANT_OF_BASE');
  }
}

/** Paths the candidate changes against its base, or against the test overlay. */
export function translationDiffPaths(
  repoRoot: string,
  witness: TranslationWitness,
): readonly string[] {
  const diffBase =
    witness.strategy === 'feature-overlay'
      ? (witness.test_overlay_sha as string)
      : witness.base_sha;
  const diffPaths = requireGit(
    repoRoot,
    ['diff', '--name-only', diffBase, witness.candidate_sha, '--'],
    'VALIDATION_DIFF_FAILED',
  )
    .split('\n')
    .filter((path) => path.length > 0);
  return diffPaths;
}

/**
 * The feature-overlay test paths, each a registered test of an implemented
 * invariant that is added or modified as a regular file; empty for any other strategy.
 */
export function translationOverlayPaths(input: {
  readonly repoRoot: string;
  readonly witness: TranslationWitness;
  readonly refs: readonly TestRef[];
  readonly trace: TraceRecord;
  readonly implemented: ReadonlySet<string>;
}): readonly string[] {
  const { repoRoot, witness, refs, trace, implemented } = input;
  if (witness.strategy !== 'feature-overlay') return [];
  const overlaySha = witness.test_overlay_sha as string;
  const overlayPaths = requireGit(
    repoRoot,
    ['diff', '--name-only', witness.base_sha, overlaySha, '--'],
    'TEST_OVERLAY_DIFF_FAILED',
  )
    .split('\n')
    .filter((path) => path.length > 0);
  const citedPaths = new Set(refs.map((ref) => ref.path));
  const registeredPaths = new Set(
    trace.invariants
      .filter((invariant) => implemented.has(invariant.id))
      .flatMap((invariant) => invariant.tests.map((test) => test.path)),
  );
  if (
    overlayPaths.length === 0 ||
    overlayPaths.some((path) => !isTestPath(path) || !registeredPaths.has(path)) ||
    [...citedPaths].some((path) => !overlayPaths.includes(path))
  ) {
    throw new Error('TEST_OVERLAY_SCOPE_INVALID');
  }
  const deleted = requireGit(
    repoRoot,
    ['diff', '--name-only', '--diff-filter=D', witness.base_sha, overlaySha, '--'],
    'TEST_OVERLAY_DELETE_CHECK_FAILED',
  );
  if (deleted.length > 0) throw new Error('TEST_OVERLAY_DELETES_TEST');
  const rawDiff = requireGit(
    repoRoot,
    ['diff', '--raw', '--no-abbrev', witness.base_sha, overlaySha, '--'],
    'TEST_OVERLAY_MODE_CHECK_FAILED',
  );
  for (const line of rawDiff.split('\n').filter((entry) => entry.length > 0)) {
    const modes = /^:\d{6} (\d{6}) [a-f0-9]{40} [a-f0-9]{40} [A-Z]\t/u.exec(line);
    if (modes === null || !['100644', '100755'].includes(modes[1] ?? '')) {
      throw new Error('TEST_OVERLAY_FILE_MODE_INVALID');
    }
  }
  return overlayPaths;
}
