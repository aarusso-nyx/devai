/**
 * `devai round tracking …` — Owner-authorized, opt-in governance tracking.
 *
 * Authority separation is deliberate and enforced in two places. The generic
 * authority layer refuses a `remote-write` action without an Owner role,
 * `--write`, and `--publish`; these handlers additionally refuse anything the
 * activation itself does not cover. Repository capability binding stays with
 * the Architect (`init bind`); nothing here can create or widen a binding.
 *
 * Local recording never depends on the remote. Every command emits a
 * `governance-projection-status` payload in which readiness and projection
 * health are separate axes, so an unreachable GitHub is reported as an
 * unobserved remote and never as a governed verdict.
 */
import type { CAC } from 'cac';
import { randomUUID } from 'node:crypto';
import { EXIT_USAGE } from '@devai-nyx/utils';
import {
  buildProjectionBatch,
  canonicalSha256,
  classifyGhFailure,
  createRoundIssue,
  defaultGhTransport,
  findRoundIssue,
  governanceTrackingStatus,
  loadTrackingPolicyDefaults,
  normalizeTrackingRepository,
  ProjectorError,
  projectBatch,
  readBoundTrackingConfig,
  readDeliveryState,
  readGovernanceEvents,
  readRoundTrackingActivation,
  recordGovernanceEvent,
  renderTrackingWorkflow,
  sealGovernanceSegments,
  trackingWorkflowDigest,
  verifyTrackingBinding,
  writeDeliveryState,
  writeRoundTrackingActivation,
  type DeliveryState,
  type GhTransport,
  type GovernanceProjectionStatus,
  type ProjectionBatch,
  type RoundTrackingActivation,
} from '#runtime-core';
import { existsSync, readFileSync } from '@devai-nyx/authority';
import { join, resolve } from 'node:path';
import { defineCommand } from '../../define-command.js';
import { resolveCliVersion } from '../../version.js';

interface TrackingOptions {
  readonly repoRoot?: string;
  readonly round?: string;
  readonly human?: boolean;
  readonly write?: boolean;
  readonly publish?: boolean;
  readonly authoritySession?: string;
}

class TrackingCommandError extends Error {
  constructor(
    readonly code: string,
    readonly exitCode = 2,
  ) {
    super(code);
    this.name = 'TrackingCommandError';
  }
}

function root(options: TrackingOptions): string {
  return resolve(options.repoRoot ?? process.cwd());
}

function requiredRound(options: TrackingOptions): string {
  const value = options.round?.trim();
  if (value === undefined || value.length === 0) {
    throw new TrackingCommandError('TRACKING_ROUND_REQUIRED', EXIT_USAGE);
  }
  if (!/^R-[0-9]{4,}$/u.test(value)) {
    throw new TrackingCommandError('TRACKING_ROUND_INVALID', EXIT_USAGE);
  }
  return value;
}

function sessionId(options: TrackingOptions): string {
  const declared = options.authoritySession?.trim();
  if (declared !== undefined && declared.length > 0) return declared;
  return `AUTH-SESSION-${randomUUID().replaceAll('-', '')}`;
}

function emit(value: GovernanceProjectionStatus, human: boolean, text: string): void {
  process.stdout.write(human ? `${text}\n` : `${JSON.stringify(value)}\n`);
  process.exitCode = 0;
}

function failure(command: string, error: unknown): void {
  const code =
    error instanceof TrackingCommandError || error instanceof ProjectorError
      ? error.code
      : error instanceof Error
        ? error.message
        : 'TRACKING_OPERATION_FAILED';
  const exit = error instanceof TrackingCommandError ? error.exitCode : 2;
  process.stderr.write(`${JSON.stringify({ code, operation: command, exit })}\n`);
  process.exitCode = exit;
}

function withTrackingOptions(command: ReturnType<CAC['command']>): ReturnType<CAC['command']> {
  return command
    .option('--repo-root <path>', 'Repository root (default: cwd)')
    .option('--round <round_id>', 'Governed round, for example R-0042')
    .option('--human', 'Human-readable output');
}

/** The bound repository capability, or a refusal explaining why it is unusable. */
function requireBinding(repoRoot: string) {
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

function statusFor(repoRoot: string, round: string): GovernanceProjectionStatus {
  return governanceTrackingStatus({
    repoRoot,
    round,
    bound: readBoundTrackingConfig(repoRoot) !== undefined,
  });
}

function requireActiveActivation(repoRoot: string, round: string): RoundTrackingActivation {
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
function assertActivationMatchesBinding(
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
function drainOutbox(options: {
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
    projected += batch.event_ids.length;
  }
  return { delivery, projected };
}

function recordProjectionFailure(options: {
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

export const roundTrackingEnable = defineCommand({
  name: 'round tracking enable',
  description:
    'Record the Owner authorization that activates opt-in governance tracking and bounded public projection for exactly one round.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    withTrackingOptions(
      cli.command('round-tracking-enable', 'Activate governance tracking for one round'),
    )
      .option('--publish', 'Authorize the bounded remote publication this activation performs')
      .option('--write', 'Apply the activation; omit for a dry run')
      .option('--authority-session <id>', 'Owner authority session identity')
      .action((options: TrackingOptions) => {
        try {
          const repoRoot = root(options);
          const round = requiredRound(options);
          // Consent is never derived from the presence of a binding.
          if (options.publish !== true) {
            throw new TrackingCommandError('TRACKING_PUBLISH_CONSENT_REQUIRED', EXIT_USAGE);
          }
          const config = requireBinding(repoRoot);
          const repository = normalizeTrackingRepository(config.binding.repository);
          if (options.write !== true) {
            emit(
              statusFor(repoRoot, round),
              options.human === true,
              `round tracking enable: dry run for ${round} on ${repository}; re-run with --write`,
            );
            return;
          }

          const now = new Date().toISOString();
          const session = sessionId(options);
          const activation: RoundTrackingActivation = {
            schemaVersion: '1.0.0',
            round_id: round,
            repository_id: config.binding.repository_id,
            state: 'active',
            adapter: {
              id: 'github-issues',
              adapter_version: config.defaults.adapter.adapter_version,
              package_version: resolveCliVersion(),
              config_digest_sha256: canonicalSha256(config.defaults),
              workflow_digest_sha256: config.digests.workflow_sha256,
            },
            target: { repository, issue_number: null },
            authorization: {
              authority_session_id: session,
              role: 'owner',
              publish_flag: true,
              authorized_at: now,
            },
            disclosure_profile: 'public-safe-v1',
            pending_policy: 'freeze',
            disabled: null,
          };
          writeRoundTrackingActivation({ repoRoot, round, activation });

          for (const [kind, summary] of [
            ['session_opened', `Owner authority session opened for round ${round}.`],
            [
              'authorization_recorded',
              `Owner authorized public-safe tracking projection for ${round} on ${repository}.`,
            ],
          ] as const) {
            recordGovernanceEvent({
              repoRoot,
              repositoryId: config.binding.repository_id,
              draft: {
                round_id: round,
                authority_session_id: session,
                role: 'owner',
                kind,
                coverage: { mediated: true, adapter_id: 'github-issues' },
                summary,
                payload: { round, repository, adapter: 'github-issues' },
              },
            });
          }
          sealGovernanceSegments({ repoRoot, round, reason: 'checkpoint' });

          // Local activation stands even if the remote is unreachable.
          try {
            const context = { transport: defaultGhTransport, repository };
            const issue =
              findRoundIssue(context, round) ??
              createRoundIssue(context, {
                round,
                adapterVersion: config.defaults.adapter.adapter_version,
              });
            const outcome = drainOutbox({
              repoRoot,
              round,
              repository,
              transport: defaultGhTransport,
              adapterVersion: config.defaults.adapter.adapter_version,
              issue,
              now,
            });
            writeDeliveryState({ repoRoot, round, state: outcome.delivery });
            writeRoundTrackingActivation({
              repoRoot,
              round,
              activation: { ...activation, target: { repository, issue_number: issue } },
            });
          } catch (error) {
            recordProjectionFailure({ repoRoot, round, error, now });
          }

          const status = statusFor(repoRoot, round);
          emit(
            status,
            options.human === true,
            `round tracking enable: ${round} active on ${repository}; projection ${status.projection}`,
          );
        } catch (error) {
          failure('tracking enable', error);
        }
      });
  },
});

export const roundTrackingStatus = defineCommand({
  name: 'round tracking status',
  description:
    "Report one round's canonical tracking counts and remote projection health as independent axes, without any network call.",
  authority: 'mesh_controller',
  register(cli: CAC): void {
    withTrackingOptions(
      cli.command('round-tracking-status', 'Read governance tracking status for one round'),
    ).action((options: TrackingOptions) => {
      try {
        const repoRoot = root(options);
        const round = requiredRound(options);
        const status = statusFor(repoRoot, round);
        emit(
          status,
          options.human === true,
          `round tracking status: ${round}; mode ${status.mode}, activation ${status.activation}, ` +
            `${String(status.canonical_events)} canonical / ${String(status.projected_events)} projected / ` +
            `${String(status.pending_events)} pending; projection ${status.projection}`,
        );
      } catch (error) {
        failure('tracking status', error);
      }
    });
  },
});

export const roundTrackingSync = defineCommand({
  name: 'round tracking sync',
  description:
    "Reconcile one round's sealed projection outbox against the remote issue idempotently; never recreate a missing issue implicitly.",
  authority: 'mesh_controller',
  register(cli: CAC): void {
    withTrackingOptions(
      cli.command('round-tracking-sync', 'Reconcile the sealed projection outbox'),
    )
      .option('--publish', 'Authorize the bounded remote publication this reconciliation performs')
      .option('--write', 'Apply the reconciliation; omit for a dry run')
      .option('--reconcile', 'Replay only batches an existing Owner activation already authorized')
      .option(
        '--replace-missing-issue',
        'Explicitly authorize creating a replacement issue when the bound issue is absent',
      )
      .action(
        (options: TrackingOptions & { reconcile?: boolean; replaceMissingIssue?: boolean }) => {
          try {
            const repoRoot = root(options);
            const round = requiredRound(options);
            const config = requireBinding(repoRoot);
            const repository = normalizeTrackingRepository(config.binding.repository);
            const activation = requireActiveActivation(repoRoot, round);
            // Reconcile-only replays what an existing activation already
            // authorized. Creating a replacement issue is a new remote decision
            // and is never available on this path.
            if (options.reconcile === true && options.replaceMissingIssue === true) {
              throw new TrackingCommandError(
                'TRACKING_RECONCILE_REPLACEMENT_FORBIDDEN',
                EXIT_USAGE,
              );
            }
            assertActivationMatchesBinding(
              activation,
              canonicalSha256(config.defaults),
              repository,
            );
            if (activation.state === 'disabled' && activation.pending_policy !== 'drain') {
              throw new TrackingCommandError('TRACKING_ROUND_DISABLED', 5);
            }

            if (options.write !== true) {
              const pending = buildProjectionBatch({ repoRoot, round, reason: 'reconciliation' });
              emit(
                statusFor(repoRoot, round),
                options.human === true,
                `round tracking sync: dry run for ${round}; ` +
                  `${String(pending?.event_ids.length ?? 0)} event(s) would project; re-run with --write`,
              );
              return;
            }

            const now = new Date().toISOString();
            const context = { transport: defaultGhTransport, repository };
            try {
              let issue = activation.target?.issue_number ?? findRoundIssue(context, round);
              if (issue === undefined || issue === null) {
                // A missing issue is a divergence to report, not a silent recreate.
                if (options.replaceMissingIssue !== true || options.reconcile === true) {
                  const delivery = readDeliveryState({ repoRoot, round });
                  writeDeliveryState({
                    repoRoot,
                    round,
                    state: {
                      ...delivery,
                      divergence: true,
                      divergence_detail:
                        'bound issue is absent; re-run with --replace-missing-issue to authorize a replacement',
                    },
                  });
                  throw new TrackingCommandError('TRACKING_ISSUE_MISSING', 5);
                }
                issue = createRoundIssue(context, {
                  round,
                  adapterVersion: config.defaults.adapter.adapter_version,
                });
                writeRoundTrackingActivation({
                  repoRoot,
                  round,
                  activation: {
                    ...activation,
                    target: { repository, issue_number: issue },
                  },
                });
              }
              const outcome = drainOutbox({
                repoRoot,
                round,
                repository,
                transport: defaultGhTransport,
                adapterVersion: config.defaults.adapter.adapter_version,
                issue,
                now,
              });
              writeDeliveryState({
                repoRoot,
                round,
                state: { ...outcome.delivery, divergence: false, divergence_detail: null },
              });
            } catch (error) {
              if (error instanceof TrackingCommandError) throw error;
              recordProjectionFailure({ repoRoot, round, error, now });
            }

            const status = statusFor(repoRoot, round);
            emit(
              status,
              options.human === true,
              `round tracking sync: ${round}; projection ${status.projection}, ` +
                `${String(status.pending_events)} pending`,
            );
          } catch (error) {
            failure('tracking sync', error);
          }
        },
      );
  },
});

export const roundTrackingDisable = defineCommand({
  name: 'round tracking disable',
  description:
    'Disable opt-in governance tracking for one round; freeze pending events by default and never delete an already published projection.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    withTrackingOptions(
      cli.command('round-tracking-disable', 'Disable governance tracking for one round'),
    )
      .option('--pending <policy>', 'Disposition of unprojected events: freeze (default) or drain')
      .option('--publish', 'Authorize the remote writes that --pending drain performs')
      .option('--write', 'Apply the change; omit for a dry run')
      .option('--authority-session <id>', 'Owner authority session identity')
      .action((options: TrackingOptions & { pending?: string }) => {
        try {
          const repoRoot = root(options);
          const round = requiredRound(options);
          const pending = options.pending ?? 'freeze';
          if (pending !== 'freeze' && pending !== 'drain') {
            throw new TrackingCommandError('TRACKING_PENDING_POLICY_INVALID', EXIT_USAGE);
          }
          // Draining performs remote writes, so it needs its own authorization
          // rather than inheriting the one recorded at activation.
          if (pending === 'drain' && options.publish !== true) {
            throw new TrackingCommandError('TRACKING_DRAIN_CONSENT_REQUIRED', EXIT_USAGE);
          }
          const activation = requireActiveActivation(repoRoot, round);

          if (options.write !== true) {
            emit(
              statusFor(repoRoot, round),
              options.human === true,
              `round tracking disable: dry run for ${round} with --pending ${pending}; re-run with --write`,
            );
            return;
          }

          const now = new Date().toISOString();
          const session = sessionId(options);
          const events = readGovernanceEvents({ repoRoot, round });
          const projected = readDeliveryState({ repoRoot, round }).projected_event_ids.length;

          recordGovernanceEvent({
            repoRoot,
            repositoryId: activation.repository_id,
            draft: {
              round_id: round,
              authority_session_id: session,
              role: 'owner',
              kind: 'tracking_disabled',
              coverage: { mediated: true, adapter_id: 'github-issues' },
              summary: `Owner disabled governance tracking for ${round} with pending policy ${pending}.`,
              payload: { round, pending },
            },
          });
          sealGovernanceSegments({ repoRoot, round, reason: 'tracking_disabled' });

          writeRoundTrackingActivation({
            repoRoot,
            round,
            activation: {
              ...activation,
              state: pending === 'drain' ? 'disabled' : 'frozen',
              pending_policy: pending,
              disabled: {
                disabled_at: now,
                authority_session_id: session,
                pending_events: Math.max(0, events.length - projected),
              },
            },
          });

          if (pending === 'drain') {
            const config = requireBinding(repoRoot);
            const repository = normalizeTrackingRepository(config.binding.repository);
            try {
              const context = { transport: defaultGhTransport, repository };
              const issue = activation.target?.issue_number ?? findRoundIssue(context, round);
              if (issue !== undefined && issue !== null) {
                const outcome = drainOutbox({
                  repoRoot,
                  round,
                  repository,
                  transport: defaultGhTransport,
                  adapterVersion: config.defaults.adapter.adapter_version,
                  issue,
                  now,
                });
                writeDeliveryState({ repoRoot, round, state: outcome.delivery });
              }
            } catch (error) {
              recordProjectionFailure({ repoRoot, round, error, now });
            }
          }

          const status = statusFor(repoRoot, round);
          emit(
            status,
            options.human === true,
            `round tracking disable: ${round} ${status.activation}; ` +
              `${String(status.pending_events)} pending event(s) ${pending === 'drain' ? 'drained' : 'frozen'}`,
          );
        } catch (error) {
          failure('tracking disable', error);
        }
      });
  },
});

/** Current round tracking handlers for central registration. */
export const roundTrackingCommands = [
  roundTrackingDisable,
  roundTrackingEnable,
  roundTrackingStatus,
  roundTrackingSync,
] as const;

/** Regenerate the adopter workflow deterministically from canonical policy. */
export function trackingWorkflowArtifact(): { path: string; content: string; digest: string } {
  const defaults = loadTrackingPolicyDefaults();
  const content = renderTrackingWorkflow(defaults);
  return {
    path: `.github/workflows/${defaults.workflow.file}`,
    content,
    digest: trackingWorkflowDigest(content),
  };
}

/**
 * Record and seal the round's final tracking event at closure.
 *
 * Closure never waits for GitHub and never fails because of it: this writes
 * local evidence only. A remaining outbox is projected afterwards, from sealed
 * evidence, by an explicit `round tracking sync` or the trusted-main workflow.
 * Returns undefined when the round was never activated, so an untracked round
 * closes exactly as it did before tracking existed.
 */
export function recordRoundCloseTracking(options: {
  readonly repoRoot: string;
  readonly round: string;
  readonly verdict: string;
}): GovernanceProjectionStatus | undefined {
  const repoRoot = resolve(options.repoRoot);
  const activation = readRoundTrackingActivation({ repoRoot, round: options.round });
  if (activation === undefined) return undefined;
  try {
    recordGovernanceEvent({
      repoRoot,
      repositoryId: activation.repository_id,
      draft: {
        round_id: options.round,
        authority_session_id: activation.authorization.authority_session_id,
        role: 'owner',
        kind: 'round_verdict',
        coverage: { mediated: true, adapter_id: 'github-issues' },
        summary: `Round ${options.round} closed with phase closure ${options.verdict}.`,
        payload: { round: options.round, closure: options.verdict },
      },
    });
    sealGovernanceSegments({ repoRoot, round: options.round, reason: 'round_close' });
  } catch {
    // Tracking is best-effort at the closure boundary. A tracking fault is
    // reported through status, never allowed to alter the closure result.
    return statusFor(repoRoot, options.round);
  }
  return statusFor(repoRoot, options.round);
}
