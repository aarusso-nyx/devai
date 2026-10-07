import type { CAC } from 'cac';
import { EXIT_USAGE } from '@devai-nyx/utils';
import {
  buildProjectionBatch,
  classifyGhFailure,
  governanceTrackingStatus,
  ProjectorError,
  projectBatch,
  readBoundTrackingConfig,
  readDeliveryState,
  readRoundTrackingActivation,
  verifyTrackingBinding,
  writeDeliveryState,
  type DeliveryState,
  type GhTransport,
  type GovernanceProjectionStatus,
  type ProjectionBatch,
  type RoundTrackingActivation,
} from '#runtime-core';
import { existsSync, readFileSync } from '@devai-nyx/authority';
import { join, resolve } from 'node:path';
import {
  resolveTrackingChain,
  TrackingSessionError,
  type TrackingChain,
} from './tracking-session.js';
import { resolveCliVersion } from '../../version.js';
import { commandRefusal } from '../../cli-error.js';

export interface TrackingOptions {
  readonly repoRoot?: string;
  readonly round?: string;
  readonly human?: boolean;
  readonly write?: boolean;
  readonly publish?: boolean;
  readonly authoritySession?: string;
}

export class TrackingCommandError extends Error {
  constructor(
    readonly code: string,
    readonly exitCode = 2,
  ) {
    super(code);
    this.name = 'TrackingCommandError';
  }
}

export function root(options: TrackingOptions): string {
  return resolve(options.repoRoot ?? process.cwd());
}

export function requiredRound(options: TrackingOptions): string {
  const value = options.round?.trim();
  if (value === undefined || value.length === 0) {
    throw new TrackingCommandError('TRACKING_ROUND_REQUIRED', EXIT_USAGE);
  }
  if (!/^R-[0-9]{4,}$/u.test(value)) {
    throw new TrackingCommandError('TRACKING_ROUND_INVALID', EXIT_USAGE);
  }
  return value;
}

export function chainFor(
  repoRoot: string,
  repositoryId: string,
  round: string,
  role: string,
  options: TrackingOptions,
): TrackingChain {
  try {
    return resolveTrackingChain({
      repoRoot,
      repositoryId,
      round,
      role,
      declaredSession: options.authoritySession,
    });
  } catch (error) {
    // A declared session that does not validate is a refusal. Falling back to a
    // derived chain would silently attribute the event to a weaker identity
    // than the caller claimed.
    if (error instanceof TrackingSessionError) throw new TrackingCommandError(error.code, 5);
    throw error;
  }
}

export function emit(value: GovernanceProjectionStatus, human: boolean, text: string): void {
  process.stdout.write(human ? `${text}\n` : `${JSON.stringify(value)}\n`);
  process.exitCode = 0;
}

/**
 * #338: a tracking failure is a schema-valid refusal envelope carrying its code. A tracking or
 * projector error keeps its exit (2 by default); an Error raised with a code (or `CODE:detail`) as
 * its message keeps it with the usage exit; anything else is TRACKING_OPERATION_FAILED,
 * infrastructure (6).
 */
export function failure(command: string, error: unknown): void {
  const known = error instanceof TrackingCommandError || error instanceof ProjectorError;
  const raw = known ? error.code : error instanceof Error ? error.message : '';
  const exit = error instanceof TrackingCommandError ? error.exitCode : 2;
  const envelope = commandRefusal(
    raw,
    exit,
    { operation: command },
    `Resolve the condition the code names, then rerun devai round ${command}.`,
    'TRACKING_OPERATION_FAILED',
  );
  process.stderr.write(`${JSON.stringify(envelope)}\n`);
  process.exitCode = envelope.exit;
}

export function withTrackingOptions(
  command: ReturnType<CAC['command']>,
): ReturnType<CAC['command']> {
  return command
    .option('--repo-root <path>', 'Repository root (default: cwd)')
    .option('--round <round_id>', 'Governed round, for example R-0042')
    .option('--human', 'Human-readable output');
}

/** The bound repository capability, or a refusal explaining why it is unusable. */
export function requireBinding(repoRoot: string) {
  const config = readBoundTrackingConfig(repoRoot);
  if (config === undefined) throw new TrackingCommandError('TRACKING_BINDING_ABSENT', 5);
  const workflowPath = join(repoRoot, '.github/workflows/devai-issue-tracking.yml');
  const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, 'utf8') : undefined;
  const findings = verifyTrackingBinding({ repoRoot, config, workflow });
  const firstFinding = findings.at(0);
  if (firstFinding !== undefined) {
    throw new TrackingCommandError(`TRACKING_BINDING_STALE:${firstFinding.code}`, 5);
  }
  return config;
}

export function statusFor(repoRoot: string, round: string): GovernanceProjectionStatus {
  return governanceTrackingStatus({
    repoRoot,
    round,
    bound: readBoundTrackingConfig(repoRoot) !== undefined,
  });
}

export function requireActiveActivation(repoRoot: string, round: string): RoundTrackingActivation {
  const activation = readRoundTrackingActivation({ repoRoot, round });
  if (activation === undefined) throw new TrackingCommandError('TRACKING_ROUND_NOT_ACTIVATED', 5);
  if (activation.authorization.publish_flag !== true) {
    throw new TrackingCommandError('TRACKING_PUBLICATION_UNAUTHORIZED', 5);
  }
  return activation;
}

/**
 * Refuse any activation whose binding has moved underneath it. Re-binding is an
 * Architect act; it must never be inferred from an older Owner authorization.
 */
export function assertActivationMatchesBinding(
  activation: RoundTrackingActivation,
  configDigest: string,
  repository: string,
): void {
  if (activation.adapter.config_digest_sha256 !== configDigest) {
    throw new TrackingCommandError('TRACKING_ACTIVATION_BINDING_STALE', 5);
  }
  if (activation.target?.repository !== undefined && activation.target.repository !== repository) {
    throw new TrackingCommandError('TRACKING_ACTIVATION_REPOSITORY_MISMATCH', 5);
  }
}

interface SyncOutcome {
  readonly delivery: DeliveryState;
  readonly projected: number;
}

/**
 * Drain the sealed outbox. Every batch is posted idempotently by marker, so a
 * repeated sync against the same outbox converges instead of duplicating.
 */
export function drainOutbox(options: {
  readonly repoRoot: string;
  readonly round: string;
  readonly repository: string;
  readonly transport: GhTransport;
  readonly adapterVersion: string;
  readonly issue: number;
  readonly now: string;
}): SyncOutcome {
  let delivery = readDeliveryState({ repoRoot: options.repoRoot, round: options.round });
  delivery = { ...delivery, issue: options.issue };
  let projected = 0;

  for (;;) {
    const batch: ProjectionBatch | undefined = buildProjectionBatch({
      repoRoot: options.repoRoot,
      round: options.round,
      reason: 'reconciliation',
      adapterVersion: options.adapterVersion,
      packageVersion: resolveCliVersion(),
    });
    if (batch === undefined) break;
    const result = projectBatch(
      { transport: options.transport, repository: options.repository },
      { issue: options.issue, batch, projectedAt: options.now },
    );
    delivery = {
      ...delivery,
      projected_event_ids: [...delivery.projected_event_ids, ...batch.event_ids],
      receipts: [
        ...delivery.receipts,
        {
          batch_id: batch.batch_id,
          state: result.already_present ? 'reconciled' : 'delivered',
          comment_id: result.comment_id,
          projected_at: options.now,
          attempts: 1,
          batch_digest_sha256: batch.batch_digest_sha256,
        },
      ],
      last_error: null,
    };
    // Persist each confirmed batch before selecting the next one. The batch
    // selector reads delivery state from disk, so deferring this write until
    // the whole drain completed would select the same batch forever. It also
    // makes a later retry reconcile only the external effects that were not
    // already confirmed.
    writeDeliveryState({
      repoRoot: options.repoRoot,
      round: options.round,
      state: delivery,
    });
    projected += batch.event_ids.length;
  }
  return { delivery, projected };
}

export function recordProjectionFailure(options: {
  readonly repoRoot: string;
  readonly round: string;
  readonly error: unknown;
  readonly now: string;
}): void {
  const classification =
    options.error instanceof ProjectorError
      ? options.error.classification
      : classifyGhFailure({ status: 1, stdout: '', stderr: String(options.error) });
  const delivery = readDeliveryState({ repoRoot: options.repoRoot, round: options.round });
  writeDeliveryState({
    repoRoot: options.repoRoot,
    round: options.round,
    state: {
      ...delivery,
      last_error: {
        classification,
        observed_at: options.now,
        attempts: (delivery.last_error?.attempts ?? 0) + 1,
        public_safe_detail:
          options.error instanceof ProjectorError ? options.error.detail.slice(0, 512) : null,
      },
    },
  });
}
