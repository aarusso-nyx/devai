import type { CAC } from 'cac';
import { EXIT_USAGE } from '@devai-nyx/utils';
import {
  buildProjectionBatch,
  canonicalSha256,
  createRoundIssue,
  defaultGhTransport,
  findRoundIssue,
  normalizeTrackingRepository,
  readDeliveryState,
  readGovernanceEvents,
  recordGovernanceEvent,
  sealGovernanceSegments,
  writeDeliveryState,
  writeRoundTrackingActivation,
} from '#runtime-core';
import { defineCommand } from '../../define-command.js';
import {
  withTrackingOptions,
  type TrackingOptions,
  root,
  requiredRound,
  TrackingCommandError,
  requireBinding,
  emit,
  statusFor,
  chainFor,
  drainOutbox,
  recordProjectionFailure,
  failure,
  requireActiveActivation,
  assertActivationMatchesBinding,
} from './tracking-support.js';

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

            // Reconcile derives its authority from the Owner's recorded
            // activation, which the authority layer has already verified; an
            // interactive sync still requires explicit --write.
            if (options.reconcile !== true && options.write !== true) {
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
          const chain = chainFor(repoRoot, activation.repository_id, round, 'owner', options);
          const events = readGovernanceEvents({ repoRoot, round });
          const projected = readDeliveryState({ repoRoot, round }).projected_event_ids.length;

          recordGovernanceEvent({
            repoRoot,
            repositoryId: activation.repository_id,
            draft: {
              round_id: round,
              authority_session_id: chain.id,
              session_source: chain.source,
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
                authority_session_id: chain.id,
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
