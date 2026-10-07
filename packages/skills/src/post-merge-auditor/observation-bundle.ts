import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import { mkdirSync, renameSync, writeFileSync } from '@devai-nyx/authority';
import { regenerateInventory } from '@devai-nyx/loop';
import { assessScorecard, resolveScorecardInputs, SENSOR_READINGS_DIR } from '@devai-nyx/loop';
import {
  compileObservationBacklog,
  validateObservationBacklog,
  type ObservationBacklogObservation,
} from '../operations/backlog.js';
import { canonicalSha256, git, gitText, isRecord, sha256, type JsonRecord } from './support.js';

function observationErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]+$/u.test(message) ? message : 'POST_MERGE_OBSERVATION_FAILED';
}

export const OBSERVATION_ARTIFACT_NAMES = [
  'inventory',
  'scorecard',
  'backlog',
  'assessment',
] as const;

function validateCompletedObservation(
  mergeSha: string,
  read: (name: string) => string,
): string | null {
  try {
    const status: unknown = JSON.parse(read('status'));
    if (!isRecord(status)) return null;
    const observationDigest = status['observation_digest_sha256'];
    const previousDigest = status['previous_observation_digest_sha256'];
    const artifactDigest = status['artifact_digest_sha256'];
    if (
      status['schemaVersion'] !== '1.0.0' ||
      status['merge_sha'] !== mergeSha ||
      status['status'] !== 'completed' ||
      status['readiness_promoting'] !== false ||
      typeof status['generated_at'] !== 'string' ||
      !Number.isFinite(Date.parse(status['generated_at'])) ||
      (previousDigest !== null &&
        (typeof previousDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(previousDigest))) ||
      typeof artifactDigest !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(artifactDigest) ||
      typeof observationDigest !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(observationDigest)
    ) {
      return null;
    }
    const { observation_digest_sha256: _observationDigest, ...unsignedStatus } = status;
    if (canonicalSha256(unsignedStatus) !== observationDigest) return null;
    const artifacts = Object.fromEntries(
      OBSERVATION_ARTIFACT_NAMES.map((name) => {
        const value: unknown = JSON.parse(read(name));
        if (!isRecord(value)) throw new Error('invalid artifact');
        return [name, value];
      }),
    ) as Record<(typeof OBSERVATION_ARTIFACT_NAMES)[number], JsonRecord>;
    if (
      !validators.inventory(artifacts.inventory) ||
      !validators.scorecard(artifacts.scorecard) ||
      !validators.assessment(artifacts.assessment) ||
      canonicalSha256(artifacts) !== artifactDigest
    ) {
      return null;
    }
    return observationDigest;
  } catch {
    return null;
  }
}

export function completedObservationDigest(stateRoot: string, mergeSha: string): string | null {
  const bundleRoot = join(stateRoot, mergeSha);
  const statusPath = join(bundleRoot, 'status.json');
  if (!existsSync(statusPath)) return null;
  return validateCompletedObservation(mergeSha, (name) =>
    readFileSync(join(bundleRoot, `${name}.json`), 'utf8'),
  );
}

export function completedAuditObservationDigest(
  worktreeRoot: string,
  mergeSha: string,
): string | null {
  const ref = `refs/devai/post-merge/${mergeSha}`;
  return validateCompletedObservation(mergeSha, (name) =>
    gitText(
      worktreeRoot,
      ['show', `${ref}:work/audit/post-merge/${mergeSha}/${name}.json`],
      'POST_MERGE_AUDIT_BUNDLE_MISSING',
    ),
  );
}

export function archiveIncompleteObservation(stateRoot: string, mergeSha: string): void {
  const bundleRoot = join(stateRoot, mergeSha);
  if (!existsSync(bundleRoot)) return;
  const statusPath = join(bundleRoot, 'status.json');
  const attemptDigest = existsSync(statusPath)
    ? sha256(readFileSync(statusPath))
    : sha256(readdirSync(bundleRoot).sort().join('\n'));
  const historyRoot = join(stateRoot, 'attempt-history', mergeSha);
  mkdirSync(historyRoot, { recursive: true });
  let sequence = 1;
  let archived = join(historyRoot, attemptDigest);
  while (existsSync(archived)) {
    sequence += 1;
    archived = join(historyRoot, `${attemptDigest}-${String(sequence)}`);
  }
  renameSync(bundleRoot, archived);
}

/**
 * The observations of the previous bundle's backlog.json, or null when there is no
 * previous bundle or it predates the observation backlog contract.
 */
function previousObservations(
  stateRoot: string,
  previousMergeSha: string | null,
): readonly ObservationBacklogObservation[] | null {
  if (previousMergeSha === null) return null;
  const previousPath = join(stateRoot, previousMergeSha, 'backlog.json');
  if (!existsSync(previousPath)) return null;
  const parsed: unknown = JSON.parse(readFileSync(previousPath, 'utf8'));
  return validateObservationBacklog(parsed).ok
    ? (parsed as { readonly observations: readonly ObservationBacklogObservation[] }).observations
    : null;
}

export async function writeBundle(
  worktreeRoot: string,
  stateRoot: string,
  mergeSha: string,
  timestamp: string,
  previousMergeSha: string | null,
  previousDigest: string | null,
  injectFailure: boolean,
  bundleKey = mergeSha,
  storeRoot = worktreeRoot,
  // #335: a caller that resolved the previous bundle elsewhere (the chain) passes its
  // observations; undefined reads the previous bundle from this state directory.
  previous?: readonly ObservationBacklogObservation[] | null,
): Promise<string> {
  const bundleRoot = join(stateRoot, bundleKey);
  mkdirSync(bundleRoot, { recursive: true });
  try {
    if (injectFailure) throw new Error('POST_MERGE_OBSERVATION_INJECTED_FAILURE');
    const inventory = await regenerateInventory({
      repoRoot: worktreeRoot,
      timestamp,
      integrationHead: mergeSha,
    });
    // ADR-SCR-0002: one readings store. The observation reads the same
    // readings and N/A ledger as `audit scorecard` through the loop resolver.
    // ADR-SCR-0008: the store is ignored by git, so the readings resolve from the
    // bound checkout's store, never from the detached observation worktree.
    const { scorecard, readings } = resolveScorecardInputs({
      repoRoot: worktreeRoot,
      inputs: { readings_dir: join(storeRoot, SENSOR_READINGS_DIR) },
      timestamp,
      integrationHead: mergeSha,
    });
    const assessment = assessScorecard(scorecard, timestamp, 1, readings);
    const backlog = compileObservationBacklog({
      scorecard,
      mergeSha,
      previousMergeSha,
      generatedAt: timestamp,
      previous:
        previous === undefined ? previousObservations(stateRoot, previousMergeSha) : previous,
    });
    if (!validateObservationBacklog(backlog).ok) throw new Error('POST_MERGE_BACKLOG_INVALID');
    if (!validators.inventory(inventory)) throw new Error('POST_MERGE_INVENTORY_INVALID');
    if (!validators.scorecard(scorecard)) throw new Error('POST_MERGE_SCORECARD_INVALID');
    if (!validators.assessment(assessment)) throw new Error('POST_MERGE_ASSESSMENT_INVALID');
    const artifacts = { inventory, scorecard, backlog, assessment };
    for (const [name, value] of Object.entries(artifacts)) {
      writeFileSync(
        join(bundleRoot, `${name}.json`),
        `${JSON.stringify(value, null, 2)}\n`,
        'utf8',
      );
    }
    const artifactDigest = canonicalSha256(artifacts);
    const completed = {
      schemaVersion: '1.0.0',
      merge_sha: mergeSha,
      status: 'completed',
      generated_at: timestamp,
      readiness_promoting: false,
      previous_observation_digest_sha256: previousDigest,
      artifact_digest_sha256: artifactDigest,
    };
    const observationDigest = canonicalSha256(completed);
    writeFileSync(
      join(bundleRoot, 'status.json'),
      `${JSON.stringify({ ...completed, observation_digest_sha256: observationDigest }, null, 2)}\n`,
      'utf8',
    );
    return observationDigest;
  } catch (error) {
    const failed = {
      schemaVersion: '1.0.0',
      merge_sha: mergeSha,
      status: 'error',
      generated_at: timestamp,
      readiness_promoting: false,
      previous_observation_digest_sha256: previousDigest,
      code: observationErrorCode(error),
    };
    const observationDigest = canonicalSha256(failed);
    writeFileSync(
      join(bundleRoot, 'status.json'),
      `${JSON.stringify({ ...failed, observation_digest_sha256: observationDigest }, null, 2)}\n`,
      'utf8',
    );
    throw error;
  }
}

export function commitAuditBundle(worktreeRoot: string, stateRoot: string, mergeSha: string): void {
  const auditRoot = join(worktreeRoot, 'work/audit/post-merge');
  const auditBundle = join(auditRoot, mergeSha);
  const runtimeBundle = join(stateRoot, mergeSha);
  mkdirSync(auditBundle, { recursive: true });
  for (const name of [...OBSERVATION_ARTIFACT_NAMES, 'status'] as const) {
    writeFileSync(
      join(auditBundle, `${name}.json`),
      readFileSync(join(runtimeBundle, `${name}.json`)),
    );
  }
  const auditPath = relative(worktreeRoot, auditBundle).split(sep).join('/');
  if (git(worktreeRoot, ['add', '--', auditPath]).status !== 0) {
    throw new Error('POST_MERGE_AUDIT_STAGE_FAILED');
  }
  if (git(worktreeRoot, ['commit', '-m', `audit(post-merge): observe ${mergeSha}`]).status !== 0) {
    throw new Error('POST_MERGE_AUDIT_COMMIT_FAILED');
  }
  if (git(worktreeRoot, ['update-ref', `refs/devai/post-merge/${mergeSha}`, 'HEAD']).status !== 0) {
    throw new Error('POST_MERGE_AUDIT_REF_FAILED');
  }
}
