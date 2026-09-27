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
import { EXIT_USAGE } from '@devai-nyx/utils';
import {
  canonicalSha256,
  createRoundIssue,
  defaultGhTransport,
  findRoundIssue,
  loadTrackingPolicyDefaults,
  normalizeTrackingRepository,
  readRoundTrackingActivation,
  recordGovernanceEvent,
  renderTrackingWorkflow,
  sealGovernanceSegments,
  trackingWorkflowDigest,
  writeDeliveryState,
  writeRoundTrackingActivation,
  type GovernanceProjectionStatus,
  type RoundTrackingActivation,
} from '#runtime-core';

import { resolve } from 'node:path';
import { defineCommand } from '../../define-command.js';

import { resolveCliVersion } from '../../version.js';
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
} from './tracking-support.js';
import { roundTrackingDisable, roundTrackingSync } from './tracking-sync.js';
export { roundTrackingSync, roundTrackingDisable } from './tracking-sync.js';

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
          const chain = chainFor(repoRoot, config.binding.repository_id, round, 'owner', options);
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
              authority_session_id: chain.id,
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
                authority_session_id: chain.id,
                session_source: chain.source,
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
        session_source: activation.authorization.authority_session_id.startsWith('AUTH-SESSION-')
          ? 'session-state'
          : 'direct-cli',
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
