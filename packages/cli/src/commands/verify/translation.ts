import { platform } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { CAC } from 'cac';
import {
  appendVerbEvidence,
  buildExpectedDiffManifest,
  dropValidationDatabase,
  evaluateTranslationFrames,
  provisionValidationDatabase,
  recoverValidationLeases,
  resolveRecipeRecordPath,
} from '#runtime-core';
import { existsSync, mkdirSync, rmSync, writeFileSync } from '@devai-nyx/authority';
import { validators } from '@devai-nyx/schemas';
import { senseTestWeakening } from '@devai-nyx/sensors';
import { EXIT_FAIL, EXIT_PASS } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';
import {
  requireGit,
  safeRepoPath,
  type StateChange,
  type Execution,
  canonicalRef,
  type TranslationValidationOptions,
  json,
  type TranslationWitness,
  type TaskRecord,
  jsonAtCommit,
  type TraceRecord,
  registeredTraceRef,
  resolveStrategyCoverage,
  git,
  isTestPath,
  sha256,
  readLeases,
  removeWorktree,
  writeJson,
  gitBlob,
  inferEffects,
} from './translation-support.js';
import {
  snapshotValidationState,
  testArgv,
  runIsolated,
  executionFrom,
  uniqueStateChanges,
  stateChanges,
  LINUX_IMAGE,
} from './translation-execution.js';
export type { TranslationValidationOptions } from './translation-support.js';

export async function executeTranslationValidation(
  options: TranslationValidationOptions,
): Promise<Record<string, unknown>> {
  const startedAt = new Date().toISOString();
  const repoRoot = resolve(options.repoRoot ?? '.');
  if (options.databaseUrl === undefined || options.databaseUrl.length === 0) {
    throw new Error('DATABASE_URL_REQUIRED');
  }
  const witnessPath = resolve(repoRoot, options.witness);
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
  const taskPath = resolve(repoRoot, `.devai/state/tasks/${witness.task_id}.json`);
  const rawTask = json(taskPath);
  if (!validators.task(rawTask)) throw new Error('TRANSLATION_TASK_INVALID');
  const task = rawTask as TaskRecord;
  if (task.id !== witness.task_id || task.discipline !== witness.frame.authority_role) {
    throw new Error('TRANSLATION_TASK_AUTHORITY_MISMATCH');
  }
  const taskScope = task.intent_diff?.planned_files ?? [];
  if (taskScope.length === 0) throw new Error('TRANSLATION_TASK_SCOPE_MISSING');

  const rawTrace = jsonAtCommit(
    repoRoot,
    witness.candidate_sha,
    'law/trace.json',
    'TRANSLATION_TRACE_OBJECT_INVALID',
  );
  if (!validators.trace(rawTrace)) throw new Error('TRANSLATION_TRACE_INVALID');
  const trace = rawTrace as TraceRecord;
  const refs = witness.red_green?.map((entry) => entry.test_ref) ?? [];
  const testBacked = witness.strategy === 'regression' || witness.strategy === 'feature-overlay';
  if (testBacked && refs.length === 0) throw new Error('TRANSLATION_TEST_REFS_MISSING');
  if (!testBacked && refs.length > 0) throw new Error('TRANSLATION_TEST_REFS_UNEXPECTED');
  const implemented = new Set(witness.implements.map((entry) => entry.invariant_id));
  for (const ref of refs) {
    const registered = registeredTraceRef(trace, implemented, ref);
    if (!registered) throw new Error(`TRANSLATION_TEST_REF_UNREGISTERED: ${canonicalRef(ref)}`);
  }
  const strategyCoverage = resolveStrategyCoverage({
    repoRoot,
    candidateSha: witness.candidate_sha,
    witness,
    trace,
    refs,
  });
  const recipeRecordPath = resolveRecipeRecordPath({
    repo_root: repoRoot,
    recipe_name: witness.recipe_name,
    recipe_variant: witness.recipe_variant,
    witness_id: witness.id,
  });
  const recipeRecord = json(resolve(repoRoot, recipeRecordPath)) as {
    readonly evidence?: { readonly translation_witness?: unknown };
  };
  if (!isDeepStrictEqual(recipeRecord.evidence?.translation_witness, rawWitness)) {
    throw new Error('TRANSLATION_RECIPE_RECORD_WITNESS_MISMATCH');
  }
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
  let overlayPaths: readonly string[] = [];
  if (witness.strategy === 'feature-overlay') {
    const overlaySha = witness.test_overlay_sha as string;
    overlayPaths = requireGit(
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
  }
  const stateBefore = snapshotValidationState(repoRoot);

  const suffix = sha256({ witness: witness.id, started_at: startedAt, pid: process.pid }).slice(
    0,
    16,
  );
  const validationId = `VR-${suffix}`;
  const leaseId = `TVL-${suffix}`;
  const worktreeRelative = `.devai/worktrees/WT-TV-${suffix}`;
  const worktree = resolve(repoRoot, worktreeRelative);
  const database = `devai_task_TV_${suffix}`;
  const leasePath = resolve(repoRoot, `.devai/state/translation-validation/leases/${leaseId}.json`);
  const priorLeases = readLeases(repoRoot);
  const recovery = await recoverValidationLeases({
    leases: priorLeases.map((entry) => entry.value),
    host: {
      remove_worktree: async (path) => removeWorktree(repoRoot, path),
      drop_database: async (name) => {
        const dropped = await dropValidationDatabase({
          database_url: options.databaseUrl as string,
          database: name,
        });
        if (!dropped.ok) throw new Error(dropped.error ?? 'VALIDATION_DATABASE_DROP_FAILED');
      },
    },
  });
  if (recovery.status !== 'pass') {
    throw new Error(`VALIDATION_RECOVERY_FAILED: ${recovery.findings.join('; ')}`);
  }
  for (const entry of priorLeases) rmSync(entry.path, { force: true });

  writeJson(leasePath, {
    schemaVersion: '1.0.0',
    id: leaseId,
    task_id: witness.task_id,
    worktree_id: `WT-TV-${suffix}`,
    worktree_path: worktreeRelative,
    database,
    base_sha: witness.base_sha,
    created_at: startedAt,
  });
  const lifecycleEvents: StateChange[] = [
    { path: relative(repoRoot, leasePath), operation: 'create' },
    { path: recipeRecordPath, operation: 'append' },
  ];

  let databaseCreated = false;
  let worktreeCreated = false;
  let worktreeWasCreated = false;
  let databaseRemoved = false;
  let worktreeRemoved = false;
  let infrastructureFinding: string | undefined;
  let isolationAttempts = 0;
  let isolationProofs = 0;
  let weakeningClean = !testBacked;
  const baseExecutions: Execution[] = [];
  const candidateExecutions: Execution[] = [];
  try {
    const provisioned = await provisionValidationDatabase({
      database_url: options.databaseUrl,
      validation_id: validationId,
    });
    if (!provisioned.ok || provisioned.database !== database) {
      infrastructureFinding = provisioned.error ?? 'VALIDATION_DATABASE_PROVISION_FAILED';
    } else {
      databaseCreated = true;
      mkdirSync(dirname(worktree), { recursive: true });

      const phases = testBacked
        ? [
            {
              sha: witness.base_sha,
              output: baseExecutions,
              overlay:
                witness.strategy === 'feature-overlay'
                  ? (witness.test_overlay_sha as string)
                  : undefined,
            },
            {
              sha: witness.candidate_sha,
              output: candidateExecutions,
              overlay: undefined,
            },
          ]
        : [];
      for (const phase of phases) {
        const added = git(repoRoot, ['worktree', 'add', '--detach', worktree, phase.sha]);
        if (added.status !== 0) {
          throw new Error(`VALIDATION_WORKTREE_ADD_FAILED: ${added.stderr.trim()}`);
        }
        worktreeCreated = true;
        worktreeWasCreated = true;
        try {
          if (phase.overlay !== undefined) {
            for (const path of overlayPaths) {
              if (!safeRepoPath(path)) throw new Error('TEST_OVERLAY_PATH_INVALID');
              const target = resolve(worktree, path);
              mkdirSync(dirname(target), { recursive: true });
              writeFileSync(
                target,
                gitBlob(repoRoot, phase.overlay, path, 'TEST_OVERLAY_BLOB_READ_FAILED'),
              );
            }
          }
          for (const ref of refs) {
            const argv = testArgv(repoRoot, ref);
            isolationAttempts += 1;
            const result = await runIsolated(repoRoot, worktree, argv);
            if (result.isolation_applied === true) isolationProofs += 1;
            if (
              platform() === 'linux' &&
              result.isolation_applied !== true &&
              infrastructureFinding === undefined
            ) {
              infrastructureFinding = 'LINUX_ISOLATION_NOT_APPLIED';
            }
            phase.output.push(executionFrom(ref, result));
          }
          if (phase.sha === witness.candidate_sha) {
            const changedTestPaths = diffPaths.filter(isTestPath);
            weakeningClean =
              changedTestPaths.length === 0 ||
              senseTestWeakening({
                cwd: worktree,
                baseRef: witness.base_sha,
                files: changedTestPaths,
              }).status === 'pass';
          }
        } finally {
          removeWorktree(repoRoot, worktreeRelative);
          worktreeCreated = false;
        }
      }
    }
  } catch (error) {
    infrastructureFinding = error instanceof Error ? error.message : String(error);
  } finally {
    if (worktreeCreated || existsSync(worktree)) {
      try {
        removeWorktree(repoRoot, worktreeRelative);
        worktreeRemoved = true;
      } catch {
        worktreeRemoved = false;
      }
    } else {
      worktreeRemoved = true;
    }
    if (databaseCreated) {
      const dropped = await dropValidationDatabase({
        database_url: options.databaseUrl,
        database,
      });
      databaseRemoved = dropped.ok;
    }
  }
  const worktreeCleanup = worktreeRemoved && !existsSync(worktree);
  const databaseCleanup = databaseCreated ? databaseRemoved : true;

  const registeredRefs = refs.map(canonicalRef);
  const infrastructureExecutions = [...baseExecutions, ...candidateExecutions].filter(
    (execution) => execution.failure_mode === 'infrastructure',
  );
  const effectiveInfrastructureFinding =
    infrastructureFinding ??
    (infrastructureExecutions.length === 0
      ? undefined
      : `REGISTERED_EXECUTION_INFRASTRUCTURE_FAILURE:${infrastructureExecutions.map((execution) => execution.test_ref).join(',')}`);
  const networkDenialProven =
    platform() === 'linux' && isolationProofs > 0 && effectiveInfrastructureFinding === undefined;
  const expected = uniqueStateChanges([
    ...buildExpectedDiffManifest({
      validation_id: validationId,
      witness_id: witness.id,
      lease_id: leaseId,
      recipe_name: witness.recipe_name,
      recipe_variant: witness.recipe_variant,
      recipe_record_path: recipeRecordPath,
    }),
    ...recovery.recovered.map((recoveredLeaseId) => ({
      path: `.devai/state/translation-validation/leases/${recoveredLeaseId}.json`,
      operation: 'retire' as const,
    })),
  ]);
  if (worktreeCleanup && databaseCleanup) {
    rmSync(leasePath, { force: true });
    if (!existsSync(leasePath)) {
      lifecycleEvents.push({ path: relative(repoRoot, leasePath), operation: 'retire' });
    }
  }
  writeJson(
    resolve(repoRoot, `.devai/state/translation-validation/witnesses/${witness.id}.json`),
    rawWitness,
  );
  const witnessStatePath = `.devai/state/translation-validation/witnesses/${witness.id}.json`;
  if (existsSync(resolve(repoRoot, witnessStatePath))) {
    lifecycleEvents.push({ path: witnessStatePath, operation: 'create' });
  }
  const snapshotObserved = stateChanges(stateBefore, snapshotValidationState(repoRoot));
  const resultStatePath = `.devai/state/translation-validation/results/${validationId}.json`;
  const provisionalObserved = uniqueStateChanges([
    ...snapshotObserved,
    ...lifecycleEvents,
    { path: resultStatePath, operation: 'create' },
    { path: 'record/proofs/chain.json', operation: 'append' },
  ]);
  const preliminaryFrames = evaluateTranslationFrames({
    witness: {
      strategy: witness.strategy,
      touched: witness.touched,
      frame: witness.frame,
      red_green: refs.map((ref) => ({ test_ref: canonicalRef(ref) })),
    },
    registered_test_refs: registeredRefs,
    task_scope: taskScope,
    diff_paths: diffPaths,
    base_executions: baseExecutions,
    candidate_executions: candidateExecutions,
    weakening_clean: weakeningClean,
    inventory_delta_modules: diffPaths.length > 0 ? task.target_modules : [],
    inferred_effects: inferEffects(diffPaths, witness.frame.authority_role),
    expected_state_changes: expected,
    observed_state_changes: provisionalObserved,
    strategy_coverage: strategyCoverage,
  });
  const extraFrames = [
    effectiveInfrastructureFinding === undefined
      ? { name: 'infrastructure', status: 'PASS' as const, evidence_refs: [] }
      : {
          name: 'infrastructure',
          status: 'FAIL' as const,
          evidence_refs: [],
          finding: `Validation infrastructure failed: ${effectiveInfrastructureFinding}`,
        },
    networkDenialProven
      ? { name: 'network-egress', status: 'PASS' as const, evidence_refs: [] }
      : {
          name: 'network-egress',
          status: 'REVIEW' as const,
          evidence_refs: [],
          finding:
            platform() !== 'linux'
              ? 'Native isolation is best-effort; network denial is not proven.'
              : isolationAttempts === 0
                ? 'Registered execution did not reach the Linux isolation boundary.'
                : 'Linux isolation proof is unavailable because validation infrastructure failed.',
        },
    worktreeCleanup && databaseCleanup
      ? { name: 'cleanup', status: 'PASS' as const, evidence_refs: [] }
      : {
          name: 'cleanup',
          status: 'FAIL' as const,
          evidence_refs: [],
          finding: 'Exact worktree or database cleanup could not be verified.',
        },
  ];
  const preliminaryFrameSet = [...preliminaryFrames.frames, ...extraFrames];
  const preliminaryVerdict = preliminaryFrameSet.some((frame) => frame.status === 'FAIL')
    ? 'FAIL'
    : preliminaryFrameSet.some((frame) => frame.status === 'REVIEW')
      ? 'REVIEW'
      : 'PASS';
  const evidence = appendVerbEvidence({
    repoRoot,
    action: 'verify.translation',
    status: preliminaryVerdict === 'FAIL' ? 'failed' : 'completed',
    artifacts: [
      {
        path: `.devai/state/translation-validation/results/${validationId}.json`,
        sha256: null,
        kind: 'validation-result',
      },
    ],
    notes: [
      `witness=${witness.id}`,
      `verdict=${preliminaryVerdict}`,
      'report_only=true',
      'readiness_eligible=false',
    ],
  });
  if (!evidence.ok || evidence.id === undefined) {
    throw new Error(evidence.error ?? 'VALIDATION_EVIDENCE_APPEND_FAILED');
  }
  const evidenceRef = evidence.id;
  const observed = uniqueStateChanges([
    ...stateChanges(stateBefore, snapshotValidationState(repoRoot)),
    ...lifecycleEvents,
    { path: resultStatePath, operation: 'create' },
  ]);
  const frameEvaluation = evaluateTranslationFrames({
    witness: {
      strategy: witness.strategy,
      touched: witness.touched,
      frame: witness.frame,
      red_green: refs.map((ref) => ({ test_ref: canonicalRef(ref) })),
    },
    registered_test_refs: registeredRefs,
    task_scope: taskScope,
    diff_paths: diffPaths,
    base_executions: baseExecutions,
    candidate_executions: candidateExecutions,
    weakening_clean: weakeningClean,
    inventory_delta_modules: diffPaths.length > 0 ? task.target_modules : [],
    inferred_effects: inferEffects(diffPaths, witness.frame.authority_role),
    expected_state_changes: expected,
    observed_state_changes: observed,
    strategy_coverage: strategyCoverage,
  });
  const frames = [...frameEvaluation.frames, ...extraFrames];
  const verdict = frames.some((frame) => frame.status === 'FAIL')
    ? 'FAIL'
    : frames.some((frame) => frame.status === 'REVIEW')
      ? 'REVIEW'
      : 'PASS';
  const expectedKeys = new Set(expected.map((change) => `${change.operation}:${change.path}`));
  const unexpected = observed.filter(
    (change) => !expectedKeys.has(`${change.operation}:${change.path}`),
  );
  const withEvidence = frames.map((frame) => ({ ...frame, evidence_refs: [evidenceRef] }));
  const manifestDigest = sha256(expected);
  const completedAt = new Date().toISOString();
  const result: Record<string, unknown> = {
    schemaVersion: '1.0.0',
    id: validationId,
    witness_id: witness.id,
    task_id: witness.task_id,
    recipe_name: witness.recipe_name,
    recipe_variant: witness.recipe_variant,
    base_sha: witness.base_sha,
    candidate_sha: witness.candidate_sha,
    ...(witness.test_overlay_sha === undefined
      ? {}
      : { test_overlay_sha: witness.test_overlay_sha }),
    strategy: witness.strategy,
    environment_digest_sha256: sha256({
      platform: platform(),
      node: process.version,
      image: platform() === 'linux' ? LINUX_IMAGE : null,
      refs: registeredRefs,
    }),
    started_at: startedAt,
    completed_at: completedAt,
    isolation: {
      mode: platform() === 'linux' ? 'linux-container-no-network' : 'macos-best-effort',
      network_egress: networkDenialProven ? 'denied' : 'not-proven',
      database: 'per-task-database',
      readiness_eligible: networkDenialProven,
    },
    executions: [
      ...baseExecutions.map((execution) => ({
        phase: witness.strategy === 'feature-overlay' ? 'test-overlay' : 'base',
        ...execution,
        evidence_ref: evidenceRef,
      })),
      ...candidateExecutions.map((execution) => ({
        phase: 'candidate',
        ...execution,
        evidence_ref: evidenceRef,
      })),
    ],
    frames: withEvidence,
    expected_diff: {
      manifest_digest_sha256: manifestDigest,
      expected,
      observed,
      unexpected,
    },
    cleanup: {
      lease_id: leaseId,
      worktree: worktreeCleanup ? (worktreeWasCreated ? 'removed' : 'not-created') : 'orphan-fail',
      database: databaseCleanup ? (databaseCreated ? 'removed' : 'not-created') : 'orphan-fail',
      recovery_scan: recovery.recovered.length > 0 ? 'recovered' : 'clean',
      ...(recovery.recovered.length > 0 ? { recovered_lease_ids: recovery.recovered } : {}),
    },
    verdict,
    report_only: true,
    readiness_eligible: false,
    evidence_chain_refs: [evidenceRef],
  };
  if (!validators.validationResult(result)) {
    throw new Error(
      `VALIDATION_RESULT_INVALID: ${JSON.stringify(validators.validationResult.errors ?? [])}`,
    );
  }
  writeJson(resolve(repoRoot, resultStatePath), result);
  return result;
}

export const verifyTranslation = defineCommand({
  name: 'verify translation',
  description: 'Independently validate an untrusted translation witness (report-only)',
  authority: 'sensor',
  lifecycle: 'experimental',
  lifecycle_reason: 'Report-only validation that cannot promote readiness.',
  promotion_criteria: [],
  register(cli: CAC): void {
    cli
      .command('verify-translation', 'Independently validate an untrusted translation witness')
      .option('--witness <path>', 'Translation witness JSON')
      .option('--repo-root <path>', 'Repository root (default: current directory)')
      .option('--database-url <url>', 'Postgres administrative URL for per-validation isolation')
      .option('--human', 'Emit a human-readable summary instead of JSON')
      .action(async (options: TranslationValidationOptions) => {
        try {
          const result = await executeTranslationValidation(options);
          if (options.human === true) {
            process.stdout.write(
              `verify translation: ${String(result['verdict'])} (report-only; readiness ineligible)\n`,
            );
          } else {
            process.stdout.write(`${JSON.stringify(result)}\n`);
          }
          process.exitCode = result['verdict'] === 'FAIL' ? EXIT_FAIL : EXIT_PASS;
        } catch (error) {
          process.stderr.write(
            `devai verify translation: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          process.exitCode = EXIT_FAIL;
        }
      });
  },
});
