import { spawnSync as nodeSpawnSync } from '@devai-nyx/authority';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { minimatch } from 'minimatch';
import { Client } from 'pg';
import { validators } from '@devai-nyx/schemas';

export type TranslationStrategy =
  'regression' | 'feature-overlay' | 'behavioral-equivalence' | 'structural' | 'semantic-review';

const RECIPE_NAME_PATTERN = /^devai-(?:assess|plan|fix|docs|scaffold|verify|round)$/u;
const RECIPE_VARIANT_PATTERN = /^[a-z][a-z0-9-]*$/u;

export interface StateChange {
  readonly path: string;
  readonly operation: 'create' | 'append' | 'retire';
}

export interface TranslationWitnessClaim {
  readonly task_id: string;
  readonly stage:
    | 'journey-to-invariants'
    | 'invariants-to-tests'
    | 'invariants-tests-to-code'
    | 'documentation'
    | 'refactor';
  readonly base_sha: string;
  readonly candidate_sha: string;
  readonly test_overlay_sha?: string;
  readonly strategy: TranslationStrategy;
  readonly implements: readonly unknown[];
  readonly red_green?: readonly unknown[];
  readonly touched: readonly string[];
  readonly frame: {
    readonly spec_edits: 'none' | 'declared';
    readonly test_edits: 'none' | 'declared';
    readonly inventory_delta_confined_to: readonly string[];
    readonly effects_claimed: readonly string[];
  };
  readonly notes?: readonly string[];
}

export interface MutationIntent {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly trust: 'untrusted-intent';
  readonly task_id: string;
  readonly recipe_name: string;
  readonly recipe_variant: string;
  readonly stage: TranslationWitnessClaim['stage'];
  readonly base_sha: string;
  readonly test_overlay_sha?: string;
  readonly submitted_at: string;
  readonly authority_role: MutationAuthorityRole;
  readonly strategy: TranslationStrategy;
  readonly implements: readonly unknown[];
  readonly red_green?: readonly unknown[];
  readonly declared_touched: readonly string[];
  readonly spec_edits?: 'none' | 'declared';
  readonly test_edits?: 'none' | 'declared';
  readonly inventory_delta_confined_to?: readonly string[];
  readonly effects_permitted: readonly string[];
  readonly notes?: readonly string[];
}

export interface MutationCandidateRecord {
  readonly candidate_sha: string;
  readonly candidate_ref: string;
  readonly witness: Readonly<Record<string, unknown>>;
  readonly touched: readonly string[];
  readonly runtime_state_paths: readonly string[];
}

export interface MutationEvidenceRecord {
  readonly evidence_sha: string;
  readonly evidence_ref: string;
  readonly state_paths: readonly string[];
}

interface MutationTaskRecord {
  readonly id: string;
  readonly discipline: string;
  readonly intent_diff?: { readonly planned_files?: readonly string[] };
}

interface MutationInvariantRecord {
  readonly id: string;
  readonly status: string;
  readonly lifecycle?: string;
  readonly verification?: {
    readonly strategy?: { readonly primary?: string };
  };
}

function gitMutation(
  repoRoot: string,
  args: readonly string[],
  options: {
    readonly env?: Readonly<Record<string, string>>;
    readonly input?: string;
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
  return (result.stdout ?? '').trim();
}

function mutationPaths(repoRoot: string): readonly string[] {
  const tracked = gitMutation(repoRoot, ['diff', '--name-only', 'HEAD', '--'], {
    error: 'MUTATION_DIFF_FAILED',
  })
    .split('\n')
    .filter(Boolean);
  const untracked = gitMutation(repoRoot, ['ls-files', '--others', '--exclude-standard', '--'], {
    error: 'MUTATION_UNTRACKED_SCAN_FAILED',
  })
    .split('\n')
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}

function mutationRefs(repoRoot: string): string {
  return gitMutation(repoRoot, ['for-each-ref', '--format=%(refname)%00%(objectname)'], {
    error: 'MUTATION_REF_SNAPSHOT_FAILED',
  });
}

function recipeRunDirectory(recipeName: string, recipeVariant: string): string {
  return `record/proofs/work/recipe-runs/${recipeName}/${recipeVariant}`;
}

function runtimeAttributedProofPath(
  recipeName: string,
  recipeVariant: string,
  path: string,
): boolean {
  return (
    path === 'record/proofs/work/llm-usage.jsonl' ||
    path.startsWith(`${recipeRunDirectory(recipeName, recipeVariant)}/`)
  );
}

function validateMutationIntent(repoRoot: string, intent: MutationIntent): void {
  if (!validators.mutationIntent(intent)) {
    throw new Error(
      `MUTATION_INTENT_INVALID: ${JSON.stringify(validators.mutationIntent.errors ?? [])}`,
    );
  }
  const taskPath = resolve(repoRoot, `.devai/state/tasks/${intent.task_id}.json`);
  if (!existsSync(taskPath)) throw new Error('MUTATION_TASK_MISSING');
  const task = JSON.parse(readFileSync(taskPath, 'utf8')) as unknown;
  if (!validators.task(task)) throw new Error('MUTATION_TASK_INVALID');
  const typedTask = task as MutationTaskRecord;
  if (typedTask.id !== intent.task_id || typedTask.discipline !== intent.authority_role) {
    throw new Error('MUTATION_TASK_AUTHORITY_MISMATCH');
  }
  const scope = typedTask.intent_diff?.planned_files ?? [];
  if (
    scope.length === 0 ||
    intent.declared_touched.some(
      (path) => !scope.some((pattern) => minimatch(path, pattern, { dot: true })),
    )
  ) {
    throw new Error('MUTATION_TASK_SCOPE_MISMATCH');
  }
  for (const entry of intent.implements as ReadonlyArray<{
    readonly invariant_id?: unknown;
    readonly criteria?: ReadonlyArray<{ readonly demonstrated_by?: readonly unknown[] }>;
  }>) {
    if (typeof entry.invariant_id !== 'string') throw new Error('MUTATION_INVARIANT_INVALID');
    const invariantPath = resolve(repoRoot, `law/invariants/${entry.invariant_id}.json`);
    if (!existsSync(invariantPath)) throw new Error('MUTATION_INVARIANT_MISSING');
    const invariant = JSON.parse(readFileSync(invariantPath, 'utf8')) as unknown;
    if (!validators.invariant(invariant)) throw new Error('MUTATION_INVARIANT_INVALID');
    const typedInvariant = invariant as MutationInvariantRecord;
    if (
      typedInvariant.id !== entry.invariant_id ||
      typedInvariant.status !== 'active' ||
      (typedInvariant.lifecycle ?? 'supported') !== 'supported' ||
      typedInvariant.verification?.strategy?.primary !== intent.strategy
    ) {
      throw new Error('MUTATION_STRATEGY_MISMATCH');
    }
    const demonstrations = (entry.criteria ?? []).flatMap(
      (criterion) => criterion.demonstrated_by ?? [],
    ) as ReadonlyArray<{ readonly kind?: unknown }>;
    const expectedKind =
      intent.strategy === 'regression' || intent.strategy === 'feature-overlay'
        ? 'test'
        : intent.strategy === 'structural'
          ? 'structural'
          : intent.strategy;
    if (
      demonstrations.length === 0 ||
      demonstrations.some((demonstration) => demonstration.kind !== expectedKind)
    ) {
      throw new Error('MUTATION_DEMONSTRATION_MISMATCH');
    }
  }
  for (const path of intent.declared_touched) {
    const classification = classifyTranslationPath(intent.authority_role, path);
    if (!classification.allowed) throw new Error(`MUTATION_AUTHORITY_MISMATCH: ${path}`);
    if (!intent.effects_permitted.includes(classification.effect)) {
      throw new Error(`MUTATION_EFFECT_MISMATCH: ${path}`);
    }
  }
}

function createCommitFromWorktree(input: {
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

export async function recordMutationCandidate(input: {
  readonly repo_root: string;
  readonly intent: Readonly<Record<string, unknown>>;
  readonly emitted_at: string;
  readonly run: () => Promise<unknown>;
}): Promise<MutationCandidateRecord> {
  const repoRoot = resolve(input.repo_root);
  const intent = input.intent as unknown as MutationIntent;
  validateMutationIntent(repoRoot, intent);
  const head = gitMutation(repoRoot, ['rev-parse', 'HEAD'], { error: 'MUTATION_HEAD_INVALID' });
  if (head !== intent.base_sha) throw new Error('MUTATION_BASE_MISMATCH');
  gitMutation(repoRoot, ['cat-file', '-e', `${intent.base_sha}^{commit}`], {
    error: 'MUTATION_BASE_OBJECT_INVALID',
  });
  if (mutationPaths(repoRoot).length > 0) throw new Error('MUTATION_WORKTREE_NOT_CLEAN');
  const symbolicHead = gitMutation(repoRoot, ['symbolic-ref', '-q', 'HEAD'], {
    error: 'MUTATION_DEDICATED_WORKTREE_REQUIRED',
  });
  const refsBefore = mutationRefs(repoRoot);
  const candidateRef = `refs/devai/r28/candidates/${intent.id}`;
  const existing = nodeSpawnSync('git', ['show-ref', '--verify', '--quiet', candidateRef], {
    cwd: repoRoot,
    shell: false,
  });
  if (existing.status === 0) throw new Error('MUTATION_CANDIDATE_REF_EXISTS');

  const runResult = await input.run();

  if (
    gitMutation(repoRoot, ['rev-parse', 'HEAD'], { error: 'MUTATION_HEAD_INVALID' }) !== head ||
    gitMutation(repoRoot, ['symbolic-ref', '-q', 'HEAD'], {
      error: 'MUTATION_DEDICATED_WORKTREE_REQUIRED',
    }) !== symbolicHead ||
    mutationRefs(repoRoot) !== refsBefore
  ) {
    throw new Error('MUTATION_UNEXPECTED_GIT_STATE');
  }
  const changed = mutationPaths(repoRoot);
  const runtimeState = changed.filter((path) =>
    runtimeAttributedProofPath(intent.recipe_name, intent.recipe_variant, path),
  );
  const taskPaths = changed.filter((path) => !runtimeState.includes(path));
  if (taskPaths.length === 0) {
    throw new Error(`MUTATION_NO_OP: ${JSON.stringify(runResult)}`);
  }
  const declared = [...intent.declared_touched].sort();
  if (
    taskPaths.length !== declared.length ||
    taskPaths.some((path, index) => path !== declared[index])
  ) {
    throw new Error('MUTATION_UNDECLARED_PATH');
  }
  for (const path of taskPaths) {
    const classification = classifyTranslationPath(intent.authority_role, path);
    if (!classification.allowed) throw new Error(`MUTATION_AUTHORITY_MISMATCH: ${path}`);
    if (!intent.effects_permitted.includes(classification.effect)) {
      throw new Error(`MUTATION_EFFECT_MISMATCH: ${path}`);
    }
  }
  const candidateSha = createCommitFromWorktree({
    repo_root: repoRoot,
    parent_sha: intent.base_sha,
    paths: taskPaths,
    message: `R28 candidate ${intent.id}`,
    timestamp: input.emitted_at,
    temporary_index: `.devai/state/r28-index-${intent.id}`,
  });
  const actualDiff = gitMutation(
    repoRoot,
    ['diff-tree', '--no-commit-id', '--name-only', '-r', candidateSha],
    { error: 'MUTATION_CANDIDATE_DIFF_FAILED' },
  )
    .split('\n')
    .filter(Boolean)
    .sort();
  if (JSON.stringify(actualDiff) !== JSON.stringify(taskPaths)) {
    throw new Error('MUTATION_CANDIDATE_BYTE_MISMATCH');
  }
  gitMutation(repoRoot, ['update-ref', candidateRef, candidateSha, '0'.repeat(40)], {
    error: 'MUTATION_CANDIDATE_REF_FAILED',
  });
  const witness = createTranslationWitness({
    recipe_name: intent.recipe_name,
    recipe_variant: intent.recipe_variant,
    authority_role: intent.authority_role,
    emitted_at: input.emitted_at,
    claim: {
      task_id: intent.task_id,
      stage: intent.stage,
      base_sha: intent.base_sha,
      candidate_sha: candidateSha,
      ...(intent.test_overlay_sha !== undefined && { test_overlay_sha: intent.test_overlay_sha }),
      strategy: intent.strategy,
      implements: intent.implements,
      ...(intent.red_green !== undefined && { red_green: intent.red_green }),
      touched: taskPaths,
      frame: {
        spec_edits: intent.spec_edits ?? 'none',
        test_edits: intent.test_edits ?? 'none',
        inventory_delta_confined_to: intent.inventory_delta_confined_to ?? [],
        effects_claimed: intent.effects_permitted,
      },
      ...(intent.notes !== undefined && { notes: intent.notes }),
    },
  });
  if (!validators.translationWitness(witness)) {
    throw new Error(
      `MUTATION_WITNESS_INVALID: ${JSON.stringify(validators.translationWitness.errors ?? [])}`,
    );
  }
  return {
    candidate_sha: candidateSha,
    candidate_ref: candidateRef,
    witness,
    touched: taskPaths,
    runtime_state_paths: runtimeState,
  };
}

export function recordMutationEvidenceCommit(input: {
  readonly repo_root: string;
  readonly intent_id: string;
  readonly candidate_sha: string;
  readonly timestamp: string;
  readonly recipe_name: string;
  readonly recipe_variant: string;
  readonly witness: Readonly<Record<string, unknown>>;
  readonly state_paths: readonly string[];
}): MutationEvidenceRecord {
  const repoRoot = resolve(input.repo_root);
  const intentId = requireId(input.intent_id, /^MI-[a-f0-9]{16}$/u, 'mutation_intent_id');
  const recipeName = requireId(input.recipe_name, RECIPE_NAME_PATTERN, 'recipe name');
  const recipeVariant = requireId(input.recipe_variant, RECIPE_VARIANT_PATTERN, 'recipe variant');
  if (!validators.translationWitness(input.witness)) {
    throw new Error('MUTATION_EVIDENCE_WITNESS_INVALID');
  }
  const witnessId = requireId(
    String(input.witness['id']),
    /^TW-[a-f0-9]{16}$/u,
    'translation_witness_id',
  );
  const taskId = requireId(
    String(input.witness['task_id']),
    /^TASK-[0-9]{4,}$/u,
    'translation_task_id',
  );
  const changed = mutationPaths(repoRoot);
  const statePaths = [...new Set(input.state_paths)].sort();
  if (statePaths.length !== input.state_paths.length) {
    throw new Error('MUTATION_EVIDENCE_STATE_DUPLICATE');
  }
  const witnessPath = `record/proofs/compliance/translation-validation/witnesses/${witnessId}.json`;
  const taskPath = `.devai/state/tasks/${taskId}.json`;
  const recipePrefix = `${recipeRunDirectory(recipeName, recipeVariant)}/`;
  const agentRunPattern = /^record\/proofs\/work\/agent-runs\/AR-[A-Za-z0-9-]+\.json$/u;
  for (const path of statePaths) {
    if (
      (!path.startsWith('.devai/state/') && !path.startsWith('record/proofs/')) ||
      path.split('/').includes('..') ||
      (!runtimeAttributedProofPath(recipeName, recipeVariant, path) &&
        path !== witnessPath &&
        path !== taskPath &&
        !agentRunPattern.test(path))
    ) {
      throw new Error(`MUTATION_EVIDENCE_STATE_PATH_INVALID: ${path}`);
    }
    if (!existsSync(resolve(repoRoot, path))) {
      throw new Error(`MUTATION_EVIDENCE_STATE_MISSING: ${path}`);
    }
    const stateEntry = lstatSync(resolve(repoRoot, path));
    if (!stateEntry.isFile() || stateEntry.isSymbolicLink()) {
      throw new Error(`MUTATION_EVIDENCE_STATE_PATH_INVALID: ${path}`);
    }
  }
  if (!statePaths.includes(witnessPath)) throw new Error('MUTATION_EVIDENCE_WITNESS_MISSING');
  if (!statePaths.includes(taskPath)) throw new Error('MUTATION_EVIDENCE_TASK_MISSING');
  const taskRecord = JSON.parse(readFileSync(resolve(repoRoot, taskPath), 'utf8')) as unknown;
  if (!validators.task(taskRecord)) throw new Error('MUTATION_EVIDENCE_TASK_INVALID');
  if ((taskRecord as { readonly id?: unknown }).id !== taskId) {
    throw new Error('MUTATION_EVIDENCE_TASK_MISMATCH');
  }
  const standaloneWitness = JSON.parse(
    readFileSync(resolve(repoRoot, witnessPath), 'utf8'),
  ) as unknown;
  if (JSON.stringify(standaloneWitness) !== JSON.stringify(input.witness)) {
    throw new Error('MUTATION_EVIDENCE_WITNESS_MISMATCH');
  }
  const recipeStatePaths = statePaths.filter((path) => path.startsWith(recipePrefix));
  const recipeRecords = recipeStatePaths
    .filter((path) => path.startsWith(recipePrefix) && path.endsWith('.json'))
    .map((path) => ({
      path,
      record: JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8')) as unknown,
    }))
    .filter(({ record }) => {
      if (typeof record !== 'object' || record === null || Array.isArray(record)) return false;
      const typed = record as { readonly evidence?: { readonly translation_witness?: unknown } };
      const embedded = typed.evidence?.translation_witness;
      return (
        typeof embedded === 'object' &&
        embedded !== null &&
        !Array.isArray(embedded) &&
        (embedded as Readonly<Record<string, unknown>>)['id'] === witnessId
      );
    });
  if (recipeRecords.length !== 1) throw new Error('MUTATION_EVIDENCE_RECIPE_RECORD_NOT_UNIQUE');
  if (recipeStatePaths.length !== 1) throw new Error('MUTATION_EVIDENCE_RECIPE_STATE_NOT_EXACT');
  const recipeRecord = recipeRecords[0]?.record as {
    readonly status?: unknown;
    readonly evidence?: { readonly translation_witness?: unknown };
  };
  if (recipeRecord.status !== 'pass' && recipeRecord.status !== 'review') {
    throw new Error('MUTATION_EVIDENCE_RECIPE_RECORD_NOT_ELIGIBLE');
  }
  if (
    JSON.stringify(recipeRecord.evidence?.translation_witness) !== JSON.stringify(input.witness)
  ) {
    throw new Error('MUTATION_EVIDENCE_WITNESS_MISMATCH');
  }
  const agentRunPaths = statePaths.filter((path) => agentRunPattern.test(path));
  if (agentRunPaths.length !== 1) {
    throw new Error('MUTATION_EVIDENCE_AGENT_RUN_NOT_UNIQUE');
  }
  const agentRunPath = agentRunPaths[0] as string;
  const agentRun = JSON.parse(readFileSync(resolve(repoRoot, agentRunPath), 'utf8')) as unknown;
  if (!validators.agentRun(agentRun)) throw new Error('MUTATION_EVIDENCE_AGENT_RUN_INVALID');
  const typedAgentRun = agentRun as {
    readonly run_id: string;
    readonly caller: { readonly kind: string; readonly name: string };
    readonly files_written: readonly string[];
  };
  const normalizedWritten = typedAgentRun.files_written.map((path) =>
    (isAbsolute(path) ? relative(repoRoot, path) : path).replaceAll('\\', '/'),
  );
  if (
    basename(agentRunPath, '.json') !== typedAgentRun.run_id ||
    typedAgentRun.caller.kind !== 'recipe' ||
    typedAgentRun.caller.name !== recipeName ||
    !normalizedWritten.includes(recipeRecords[0]?.path as string) ||
    !normalizedWritten.includes(witnessPath)
  ) {
    throw new Error('MUTATION_EVIDENCE_AGENT_RUN_MISMATCH');
  }
  const nonState = changed.filter((path) => !statePaths.includes(path));
  const candidatePaths = gitMutation(
    repoRoot,
    ['diff-tree', '--no-commit-id', '--name-only', '-r', input.candidate_sha],
    { error: 'MUTATION_CANDIDATE_DIFF_FAILED' },
  )
    .split('\n')
    .filter(Boolean)
    .sort();
  if (JSON.stringify(nonState) !== JSON.stringify(candidatePaths)) {
    throw new Error('MUTATION_EVIDENCE_UNEXPECTED_PATH');
  }
  if (statePaths.length === 0) throw new Error('MUTATION_EVIDENCE_MISSING');
  const evidenceSha = createCommitFromWorktree({
    repo_root: repoRoot,
    parent_sha: input.candidate_sha,
    paths: [],
    force_paths: statePaths,
    message: `R28 evidence ${intentId}`,
    timestamp: input.timestamp,
    temporary_index: `.devai/state/r28-index-${intentId}`,
  });
  const evidenceRef = `refs/devai/r28/evidence/${intentId}`;
  gitMutation(repoRoot, ['update-ref', evidenceRef, evidenceSha, '0'.repeat(40)], {
    error: 'MUTATION_EVIDENCE_REF_FAILED',
  });
  const evidenceDiff = gitMutation(
    repoRoot,
    ['diff', '--name-only', input.candidate_sha, evidenceSha, '--'],
    { error: 'MUTATION_EVIDENCE_DIFF_FAILED' },
  )
    .split('\n')
    .filter(Boolean);
  if (
    evidenceDiff.some(
      (path) => !path.startsWith('.devai/state/') && !path.startsWith('record/proofs/'),
    )
  ) {
    throw new Error('MUTATION_EVIDENCE_TASK_BYTES_CHANGED');
  }
  return { evidence_sha: evidenceSha, evidence_ref: evidenceRef, state_paths: statePaths };
}

export function createTranslationWitness(input: {
  readonly recipe_name: string;
  readonly recipe_variant: string;
  readonly authority_role: MutationAuthorityRole;
  readonly emitted_at: string;
  readonly claim: TranslationWitnessClaim;
}): Readonly<Record<string, unknown>> {
  const id = createHash('sha256')
    .update(
      JSON.stringify({
        recipe_name: input.recipe_name,
        recipe_variant: input.recipe_variant,
        emitted_at: input.emitted_at,
        task_id: input.claim.task_id,
        base_sha: input.claim.base_sha,
        candidate_sha: input.claim.candidate_sha,
      }),
    )
    .digest('hex')
    .slice(0, 16);
  return {
    schemaVersion: '1.0.0',
    id: `TW-${id}`,
    trust: 'untrusted-claim',
    task_id: input.claim.task_id,
    recipe_name: input.recipe_name,
    recipe_variant: input.recipe_variant,
    stage: input.claim.stage,
    base_sha: input.claim.base_sha,
    candidate_sha: input.claim.candidate_sha,
    ...(input.claim.test_overlay_sha !== undefined && {
      test_overlay_sha: input.claim.test_overlay_sha,
    }),
    emitted_at: input.emitted_at,
    strategy: input.claim.strategy,
    implements: input.claim.implements,
    ...(input.claim.red_green !== undefined && { red_green: input.claim.red_green }),
    touched: input.claim.touched,
    frame: {
      authority_role: input.authority_role,
      spec_edits: input.claim.frame.spec_edits,
      test_edits: input.claim.frame.test_edits,
      inventory_delta_confined_to: input.claim.frame.inventory_delta_confined_to,
      effects_claimed: input.claim.frame.effects_claimed,
    },
    ...(input.claim.notes !== undefined && { notes: input.claim.notes }),
  };
}

interface TestExecution {
  readonly test_ref: string;
  readonly outcome: 'pass' | 'fail' | 'crash';
  readonly failure_mode:
    'none' | 'assertion' | 'missing-file' | 'load-error' | 'timeout' | 'signal' | 'infrastructure';
}

interface EvaluationInput {
  readonly witness: {
    readonly strategy: TranslationStrategy;
    readonly touched: readonly string[];
    readonly frame: {
      readonly authority_role: 'owner' | 'architect' | 'inspector' | 'engineer';
      readonly inventory_delta_confined_to: readonly string[];
      readonly effects_claimed: readonly string[];
    };
    readonly red_green?: readonly { readonly test_ref: string }[];
    readonly notes?: readonly string[];
  };
  readonly registered_test_refs: readonly string[];
  readonly task_scope: readonly string[];
  readonly diff_paths: readonly string[];
  readonly base_executions: readonly TestExecution[];
  readonly candidate_executions: readonly TestExecution[];
  readonly weakening_clean: boolean;
  readonly inventory_delta_modules: readonly string[];
  readonly inferred_effects: readonly string[];
  readonly expected_state_changes: readonly StateChange[];
  readonly observed_state_changes: readonly StateChange[];
  readonly strategy_coverage: {
    readonly status: 'pass' | 'fail';
    readonly finding?: string;
  };
}

export interface ValidationFrame {
  readonly name: string;
  readonly status: 'PASS' | 'REVIEW' | 'FAIL';
  readonly evidence_refs: readonly string[];
  readonly finding?: string;
}

export interface FrameEvaluation {
  readonly verdict: 'PASS' | 'REVIEW' | 'FAIL';
  readonly frames: readonly ValidationFrame[];
  readonly executed_test_refs: readonly string[];
}

function frame(name: string, pass: boolean, finding: string): ValidationFrame {
  return pass
    ? { name, status: 'PASS', evidence_refs: [] }
    : { name, status: 'FAIL', evidence_refs: [], finding };
}

function stateKey(change: StateChange): string {
  return `${change.operation}:${change.path}`;
}

const ROOT_ARCHITECT_PATHS = new Set(['README.md', 'AGENTS.md', 'CLAUDE.md']);
const DECISION_REGISTER_PATH = 'law/register/DECISIONS.md';

export type TranslationAuthorityRole = 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';
export type MutationAuthorityRole = Exclude<TranslationAuthorityRole, 'auditor'>;

export type TranslationFilesystemEffect =
  | 'fs:owner-spec'
  | 'fs:architect-spec'
  | 'fs:tests'
  | 'fs:plant'
  | 'fs:auditor-observation'
  | 'fs:proofs'
  | 'fs:inventory'
  | 'fs:f5-config'
  | 'fs:f5-state'
  | 'fs:worktree-admin';

export interface TranslationPathClassification {
  readonly allowed: boolean;
  readonly effect: TranslationFilesystemEffect;
}

function isTestAuthorityPath(path: string): boolean {
  return (
    /(^|\/)(?:test|tests|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path) ||
    /(^|\/)(?:vitest(?:\.[^/]*)?|jest|playwright|cypress)\.config\.[cm]?[jt]s$/u.test(path)
  );
}

export function classifyTranslationPath(
  role: TranslationAuthorityRole,
  path: string,
): TranslationPathClassification {
  const testPath = isTestAuthorityPath(path);
  const auditorObservation = path === 'work/audit' || path.startsWith('work/audit/');
  const architectRoundPath = path === 'work/rounds' || path.startsWith('work/rounds/');
  const ownerPath = path === 'product' || path.startsWith('product/');
  const jointGlossaryPath = path === 'law/glossary' || path.startsWith('law/glossary/');
  const lawPath = path === 'law' || path.startsWith('law/');
  const architectPath =
    ROOT_ARCHITECT_PATHS.has(path) ||
    path === DECISION_REGISTER_PATH ||
    lawPath ||
    architectRoundPath ||
    path.startsWith('.changeset/') ||
    path === 'docs' ||
    path.startsWith('docs/');
  if (path === 'law/constitution.md') return { allowed: false, effect: 'fs:f5-config' };
  if (path === '.devai' || path.startsWith('.devai/')) {
    const effect: TranslationFilesystemEffect = path.startsWith('.devai/state/')
      ? 'fs:f5-state'
      : path.startsWith('.devai/inventory/')
        ? 'fs:inventory'
        : path.startsWith('.devai/worktrees/')
          ? 'fs:worktree-admin'
          : 'fs:f5-config';
    return { allowed: false, effect };
  }
  if (path === 'record' || path.startsWith('record/')) {
    return { allowed: false, effect: 'fs:proofs' };
  }
  if (path === 'scratch' || path.startsWith('scratch/')) {
    return { allowed: false, effect: 'fs:worktree-admin' };
  }
  if ((path === 'work' || path.startsWith('work/')) && !auditorObservation && !architectRoundPath) {
    return { allowed: false, effect: 'fs:architect-spec' };
  }
  if (auditorObservation) {
    return { allowed: role === 'auditor', effect: 'fs:auditor-observation' };
  }
  if (testPath) return { allowed: role === 'inspector', effect: 'fs:tests' };
  if (ownerPath) return { allowed: role === 'owner', effect: 'fs:owner-spec' };
  if (jointGlossaryPath) {
    return {
      allowed: role === 'owner' || role === 'architect',
      effect: role === 'owner' ? 'fs:owner-spec' : 'fs:architect-spec',
    };
  }
  if (architectPath) return { allowed: role === 'architect', effect: 'fs:architect-spec' };
  return { allowed: role === 'engineer', effect: 'fs:plant' };
}

function roleAllowsPath(
  role: EvaluationInput['witness']['frame']['authority_role'],
  path: string,
): boolean {
  return classifyTranslationPath(role, path).allowed;
}

export function evaluateTranslationFrames(input: EvaluationInput): FrameEvaluation {
  const claimedRefs = (input.witness.red_green ?? []).map((entry) => entry.test_ref);
  const registered = new Set(input.registered_test_refs);
  const testBacked = ['regression', 'feature-overlay'].includes(input.witness.strategy);
  const refsOk = testBacked
    ? claimedRefs.length > 0 && claimedRefs.every((ref) => registered.has(ref))
    : claimedRefs.length === 0;
  const touched = new Set(input.witness.touched);
  const diff = new Set(input.diff_paths);
  const structureOk =
    refsOk && touched.size === diff.size && [...touched].every((path) => diff.has(path));
  const executedRefs = structureOk ? claimedRefs : [];
  const baseByRef = new Map(
    input.base_executions.map((execution) => [execution.test_ref, execution]),
  );
  const candidateByRef = new Map(
    input.candidate_executions.map((execution) => [execution.test_ref, execution]),
  );
  const expected = new Set(input.expected_state_changes.map(stateKey));
  const observed = new Set(input.observed_state_changes.map(stateKey));
  const redProof: ValidationFrame = testBacked
    ? frame(
        'red-proof',
        structureOk &&
          executedRefs.every((ref) => {
            const execution = baseByRef.get(ref);
            return execution?.outcome === 'fail' && execution.failure_mode === 'assertion';
          }),
        'Base or feature-overlay execution does not provide an assertion-red proof.',
      )
    : { name: 'red-proof', status: 'PASS', evidence_refs: [] };
  const candidateProof: ValidationFrame = testBacked
    ? frame(
        'candidate-proof',
        structureOk &&
          executedRefs.every((ref) => {
            const execution = candidateByRef.get(ref);
            return execution?.outcome === 'pass' && execution.failure_mode === 'none';
          }),
        'Candidate execution is not green.',
      )
    : {
        name: 'candidate-proof',
        status: 'REVIEW',
        evidence_refs: [],
        finding: `No trusted deterministic ${input.witness.strategy} adapter is registered.`,
      };
  const strategyCoverage: ValidationFrame =
    input.strategy_coverage.status === 'pass'
      ? { name: 'strategy-coverage', status: 'PASS', evidence_refs: [] }
      : {
          name: 'strategy-coverage',
          status: 'FAIL',
          evidence_refs: [],
          finding: input.strategy_coverage.finding ?? 'Strategy coverage could not be verified.',
        };
  const frames: ValidationFrame[] = [
    frame('witness-structure', structureOk, 'Witness cites an unregistered or empty test set.'),
    frame('no-op', input.diff_paths.length > 0, 'Candidate has no changed paths.'),
    redProof,
    candidateProof,
    frame(
      'scope',
      input.diff_paths.every((path) => input.task_scope.some((glob) => minimatch(path, glob))),
      'Candidate diff escapes the declared task scope.',
    ),
    frame(
      'authority',
      input.diff_paths.every((path) => roleAllowsPath(input.witness.frame.authority_role, path)),
      'Candidate diff crosses the declared role authority.',
    ),
    frame('test-weakening', input.weakening_clean, 'Candidate weakens test evidence.'),
    frame(
      'inventory',
      input.inventory_delta_modules.every((module) =>
        input.witness.frame.inventory_delta_confined_to.includes(module),
      ),
      'Inventory delta escapes the witness frame.',
    ),
    frame(
      'effects',
      input.inferred_effects.every((effect) =>
        input.witness.frame.effects_claimed.includes(effect),
      ),
      'Inferred effects exceed the witness claim.',
    ),
    strategyCoverage,
    frame(
      'expected-diff',
      expected.size === observed.size && [...expected].every((change) => observed.has(change)),
      'Observed state changes differ from the trusted manifest.',
    ),
  ];
  return {
    verdict: frames.some((item) => item.status === 'FAIL')
      ? 'FAIL'
      : frames.some((item) => item.status === 'REVIEW')
        ? 'REVIEW'
        : 'PASS',
    frames,
    executed_test_refs: executedRefs,
  };
}

export interface InvariantLike {
  readonly id?: string;
  readonly lifecycle?: string;
  readonly status?: string;
  readonly severity?: string;
  readonly verification?: {
    readonly strategy?: {
      readonly primary?: TranslationStrategy;
      readonly deterministic_check_available?: boolean;
      readonly rationale?: string;
      readonly semantic_review_justification?: string;
    };
  };
}

export function validateInvariantStrategies(invariants: readonly InvariantLike[]): {
  readonly status: 'pass' | 'review' | 'fail';
  readonly population: number;
  readonly findings: readonly string[];
} {
  const population = invariants.filter(
    (invariant) =>
      (invariant.lifecycle === undefined || invariant.lifecycle === 'supported') &&
      invariant.status === 'active' &&
      ['constitutional', 'hard-fail', 'gate'].includes(invariant.severity ?? ''),
  );
  const findings: string[] = [];
  if (population.length === 0) findings.push('STRATEGY_POPULATION_ZERO');
  for (const invariant of population) {
    const strategy = invariant.verification?.strategy;
    if (strategy?.primary === undefined) {
      findings.push(`${invariant.id ?? '<unknown>'}: STRATEGY_MISSING`);
    } else if (
      strategy.primary === 'semantic-review' &&
      strategy.deterministic_check_available === true
    ) {
      findings.push(`${invariant.id ?? '<unknown>'}: DETERMINISTIC_PROPERTY_DECLARED_SEMANTIC`);
    }
  }
  const hasFail = findings.some((finding) =>
    /(?:POPULATION_ZERO|STRATEGY_MISSING)$/u.test(finding),
  );
  return {
    status: hasFail ? 'fail' : findings.length > 0 ? 'review' : 'pass',
    population: population.length,
    findings,
  };
}

function requireId(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) throw new Error(`${label.toUpperCase()}_INVALID`);
  return value;
}

export function buildExpectedDiffManifest(input: {
  readonly validation_id: string;
  readonly witness_id: string;
  readonly lease_id: string;
  readonly recipe_name: string;
  readonly recipe_variant: string;
  readonly recipe_record_path: string;
}): readonly StateChange[] {
  const validationId = requireId(input.validation_id, /^VR-[a-f0-9]{16}$/u, 'validation id');
  const witnessId = requireId(input.witness_id, /^TW-[a-f0-9]{16}$/u, 'witness id');
  const leaseId = requireId(input.lease_id, /^TVL-[a-f0-9]{16}$/u, 'lease id');
  const recipeName = requireId(input.recipe_name, RECIPE_NAME_PATTERN, 'recipe name');
  const recipeVariant = requireId(input.recipe_variant, RECIPE_VARIANT_PATTERN, 'recipe variant');
  const prefix = `${recipeRunDirectory(recipeName, recipeVariant)}/`;
  if (!input.recipe_record_path.startsWith(prefix)) {
    throw new Error('RECIPE_RECORD_PATH_INVALID');
  }
  const filename = input.recipe_record_path.slice(prefix.length);
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/u.test(filename) ||
    filename.includes('..') ||
    filename.includes('/') ||
    filename.includes('\\')
  ) {
    throw new Error('RECIPE_RECORD_PATH_INVALID');
  }
  return [
    {
      path: `.devai/state/translation-validation/leases/${leaseId}.json`,
      operation: 'create',
    },
    {
      path: `.devai/state/translation-validation/leases/${leaseId}.json`,
      operation: 'retire',
    },
    {
      path: `record/proofs/compliance/translation-validation/witnesses/${witnessId}.json`,
      operation: 'create',
    },
    {
      path: `record/proofs/compliance/translation-validation/results/${validationId}.json`,
      operation: 'create',
    },
    { path: `${prefix}${filename}`, operation: 'append' },
    { path: 'record/proofs/chain.json', operation: 'append' },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function embeddedTranslationWitness(
  value: unknown,
  recipeName: string,
  recipeVariant: string,
): unknown {
  if (
    !isRecord(value) ||
    value['recipe_name'] !== recipeName ||
    value['recipe_variant'] !== recipeVariant
  ) {
    return undefined;
  }
  if (value['status'] !== 'pass' && value['status'] !== 'review') return undefined;
  const evidence = value['evidence'];
  return isRecord(evidence) ? evidence['translation_witness'] : undefined;
}

export function resolveRecipeRecordPath(input: {
  readonly repo_root: string;
  readonly recipe_name: string;
  readonly recipe_variant: string;
  readonly witness_id: string;
}): string {
  const recipeName = requireId(input.recipe_name, RECIPE_NAME_PATTERN, 'recipe name');
  const recipeVariant = requireId(input.recipe_variant, RECIPE_VARIANT_PATTERN, 'recipe variant');
  const witnessId = requireId(input.witness_id, /^TW-[a-f0-9]{16}$/u, 'witness id');
  const relativeDirectory = recipeRunDirectory(recipeName, recipeVariant);
  const directory = resolve(input.repo_root, relativeDirectory);
  let names: string[];
  try {
    names = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    throw new Error('RECIPE_RECORD_NOT_FOUND');
  }
  const matches: string[] = [];
  for (const name of names) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/u.test(name) ||
      name.includes('..') ||
      name.includes('/') ||
      name.includes('\\')
    ) {
      continue;
    }
    try {
      const record = JSON.parse(readFileSync(resolve(directory, name), 'utf8')) as unknown;
      const witness = embeddedTranslationWitness(record, recipeName, recipeVariant);
      if (
        isRecord(witness) &&
        witness['id'] === witnessId &&
        witness['recipe_name'] === recipeName &&
        witness['recipe_variant'] === recipeVariant &&
        validators.translationWitness(witness)
      ) {
        matches.push(`${relativeDirectory}/${name}`);
      }
    } catch {
      // Invalid or unreadable records are not eligible matches.
    }
  }
  if (matches.length === 0) throw new Error('RECIPE_RECORD_NOT_FOUND');
  if (matches.length !== 1) throw new Error('RECIPE_RECORD_NOT_UNIQUE');
  return matches[0] as string;
}

interface ValidationLease {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly task_id: string;
  readonly worktree_id: string;
  readonly worktree_path: string;
  readonly database: string;
  readonly base_sha: string;
  readonly created_at: string;
}

function isValidationLease(value: unknown): value is ValidationLease {
  if (typeof value !== 'object' || value === null) return false;
  const lease = value as Partial<ValidationLease>;
  const suffix = typeof lease.id === 'string' ? lease.id.slice(4) : '';
  return (
    lease.schemaVersion === '1.0.0' &&
    /^TVL-[a-f0-9]{16}$/u.test(lease.id ?? '') &&
    /^TASK-[0-9]{4,}$/u.test(lease.task_id ?? '') &&
    lease.worktree_id === `WT-TV-${suffix}` &&
    lease.worktree_path === `.devai/worktrees/WT-TV-${suffix}` &&
    lease.database === `devai_task_TV_${suffix}` &&
    /^[a-f0-9]{40}$/u.test(lease.base_sha ?? '') &&
    typeof lease.created_at === 'string' &&
    !Number.isNaN(Date.parse(lease.created_at))
  );
}

export async function recoverValidationLeases(input: {
  readonly leases: readonly unknown[];
  readonly host: {
    readonly remove_worktree: (path: string) => Promise<void>;
    readonly drop_database: (database: string) => Promise<void>;
  };
}): Promise<{
  readonly status: 'pass' | 'fail';
  readonly recovered: readonly string[];
  readonly findings: readonly string[];
}> {
  const recovered: string[] = [];
  const findings: string[] = [];
  for (const value of input.leases) {
    if (!isValidationLease(value)) {
      findings.push('LEASE_INVALID');
      continue;
    }
    try {
      await input.host.remove_worktree(value.worktree_path);
      await input.host.drop_database(value.database);
      recovered.push(value.id);
    } catch (error) {
      findings.push(
        `${value.id}: RECOVERY_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { status: findings.length === 0 ? 'pass' : 'fail', recovered, findings };
}

const LINUX_ISOLATION_STARTED = 'DEVAI_TRANSLATION_ISOLATION_STARTED';

export async function runLinuxIsolated(input: {
  readonly repo_root: string;
  readonly dependencies_root?: string;
  readonly image: string;
  readonly argv: readonly string[];
  readonly timeout_ms: number;
  readonly prepare_dependency_mount_point?: (path: string) => void;
  readonly remove_dependency_mount_point?: (path: string) => void;
  readonly spawn?: (
    command: string,
    args: readonly string[],
    options: Readonly<{ encoding: 'utf8'; timeout: number }>,
  ) => Readonly<{
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string | Buffer | null;
    stderr: string | Buffer | null;
    error?: Error;
  }>;
}): Promise<{
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly isolation_applied: boolean;
}> {
  const run = input.spawn ?? nodeSpawnSync;
  const dependencyRoot =
    input.dependencies_root === undefined
      ? undefined
      : resolve(input.dependencies_root, 'node_modules');
  const dependencyMountPoint = resolve(input.repo_root, 'node_modules');
  const usesSharedDependencies = dependencyRoot !== undefined && existsSync(dependencyRoot);
  const createdDependencyMountPoint = usesSharedDependencies && !existsSync(dependencyMountPoint);
  if (createdDependencyMountPoint) {
    if (
      input.prepare_dependency_mount_point === undefined ||
      input.remove_dependency_mount_point === undefined
    ) {
      throw new Error('LINUX_DEPENDENCY_MOUNT_ADAPTER_MISSING');
    }
    input.prepare_dependency_mount_point(dependencyMountPoint);
  }
  let result: ReturnType<typeof run> | undefined;
  let runError: unknown;
  let cleanupError: unknown;
  try {
    result = run(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--mount',
        `type=bind,src=${input.repo_root},dst=/workspace,readonly`,
        ...(usesSharedDependencies
          ? ['--mount', `type=bind,src=${dependencyRoot},dst=/workspace/node_modules,readonly`]
          : []),
        '--workdir',
        '/workspace',
        input.image,
        'sh',
        '-c',
        `printf '%s\\n' ${LINUX_ISOLATION_STARTED}; exec "$@"`,
        'devai-translation-isolation',
        ...input.argv,
      ],
      { encoding: 'utf8', timeout: input.timeout_ms },
    );
  } catch (error) {
    runError = error;
  } finally {
    if (createdDependencyMountPoint) {
      let removed = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((done) => setTimeout(done, 100));
        try {
          input.remove_dependency_mount_point?.(dependencyMountPoint);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (!['EACCES', 'EBUSY', 'ENOTEMPTY'].includes(code ?? '')) {
            cleanupError = error;
            break;
          }
          continue;
        }
        await new Promise((done) => setTimeout(done, 100));
        if (!existsSync(dependencyMountPoint)) {
          removed = true;
          break;
        }
      }
      if (!removed && cleanupError === undefined) {
        cleanupError = new Error('LINUX_DEPENDENCY_MOUNT_CLEANUP_FAILED');
      }
    }
  }
  if (runError !== undefined) throw runError;
  if (cleanupError !== undefined) throw cleanupError;
  if (result === undefined) throw new Error('LINUX_RUNNER_RESULT_MISSING');
  const stdout =
    typeof result.stdout === 'string' ? result.stdout : (result.stdout?.toString('utf8') ?? '');
  const marker = `${LINUX_ISOLATION_STARTED}\n`;
  const isolationApplied = stdout.startsWith(marker);
  return {
    exit_code: result.status ?? (result.signal === null ? 1 : 128),
    stdout: isolationApplied ? stdout.slice(marker.length) : stdout,
    stderr:
      typeof result.stderr === 'string'
        ? result.stderr
        : (result.stderr?.toString('utf8') ?? result.error?.message ?? ''),
    isolation_applied: isolationApplied,
  };
}

function validationDatabaseName(validationId: string): string {
  requireId(validationId, /^VR-[a-f0-9]{16}$/u, 'validation id');
  return `devai_task_TV_${validationId.slice(3)}`;
}

export async function provisionValidationDatabase(input: {
  readonly database_url: string;
  readonly validation_id: string;
}): Promise<{ readonly ok: boolean; readonly database?: string; readonly error?: string }> {
  const database = validationDatabaseName(input.validation_id);
  const client = new Client({ connectionString: input.database_url });
  try {
    await client.connect();
    await client.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
    return { ok: true, database };
  } catch (error) {
    return { ok: false, database, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function dropValidationDatabase(input: {
  readonly database_url: string;
  readonly database: string;
}): Promise<{ readonly ok: boolean; readonly error?: string }> {
  if (!/^devai_task_TV_[a-f0-9]{16}$/u.test(input.database)) {
    return { ok: false, error: 'VALIDATION_DATABASE_INVALID' };
  }
  const client = new Client({ connectionString: input.database_url });
  try {
    await client.connect();
    await client.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [input.database],
    );
    await client.query(`DROP DATABASE IF EXISTS "${input.database}"`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.end().catch(() => undefined);
  }
}
