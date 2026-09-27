import { spawnSync as nodeSpawnSync } from '@devai-nyx/authority';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { minimatch } from 'minimatch';
import { validators } from '@devai-nyx/schemas';
import { canonicalSha256 } from '@devai-nyx/utils';
import { classifyTranslationPath, type MutationAuthorityRole } from './path-authority.js';
import type { TranslationStrategy } from './frames.js';
import { requireId } from './isolation.js';
import {
  createCommitFromWorktree,
  gitMutation,
  mutationPaths,
  mutationRefs,
  recipeRunDirectory,
  runtimeAttributedProofPath,
} from './mutation-git.js';
import { createTranslationWitness, type TranslationWitnessClaim } from './witness.js';
export { createTranslationWitness } from './witness.js';
export type { TranslationWitnessClaim } from './witness.js';

export { recipeRunDirectory } from './mutation-git.js';

export const RECIPE_NAME_PATTERN = /^devai-(?:assess|plan|fix|docs|scaffold|verify|round)$/u;
export const RECIPE_VARIANT_PATTERN = /^[a-z][a-z0-9-]*$/u;

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
    ['diff-tree', '--no-commit-id', '--name-only', '-z', '-r', candidateSha],
    { trimOutput: false, error: 'MUTATION_CANDIDATE_DIFF_FAILED' },
  )
    .split('\0')
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
  if (input.witness['candidate_sha'] !== input.candidate_sha) {
    throw new Error('MUTATION_EVIDENCE_CANDIDATE_MISMATCH');
  }
  if (
    input.witness['recipe_name'] !== recipeName ||
    input.witness['recipe_variant'] !== recipeVariant
  ) {
    throw new Error('MUTATION_EVIDENCE_RECIPE_MISMATCH');
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
  if (canonicalSha256(standaloneWitness) !== canonicalSha256(input.witness)) {
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
    canonicalSha256(recipeRecord.evidence?.translation_witness) !== canonicalSha256(input.witness)
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
  const { manifest_hash: manifestHash, ...agentManifest } = agentRun as Record<string, unknown>;
  if (canonicalSha256(agentManifest) !== manifestHash) {
    throw new Error('MUTATION_EVIDENCE_AGENT_RUN_INVALID');
  }
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
    ['diff-tree', '--no-commit-id', '--name-only', '-z', '-r', input.candidate_sha],
    { trimOutput: false, error: 'MUTATION_CANDIDATE_DIFF_FAILED' },
  )
    .split('\0')
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
    ['diff', '--name-only', '-z', input.candidate_sha, evidenceSha, '--'],
    { trimOutput: false, error: 'MUTATION_EVIDENCE_DIFF_FAILED' },
  )
    .split('\0')
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
