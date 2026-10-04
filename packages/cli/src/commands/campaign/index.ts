/**
 * `devai campaign …` — campaigns reach the runtime through one read-only projection and
 * one materializer (ADR-GOV-0025, S4a and S4b). The materializer writes only through the
 * round task queue and never starts, dispatches, or merges work.
 */
import type { CAC } from 'cac';
import { EXIT_USAGE } from '@devai-nyx/utils';
import { TaskServiceError, campaignStatus, materializeCampaignRound } from '#runtime-core';
import { defineCommand } from '../../define-command.js';
import { emit, failure, root, type RoundOptions } from '../round/workflow-support.js';

interface CampaignOptions extends RoundOptions {
  readonly campaign?: string;
}

function requiredCampaign(options: CampaignOptions): string {
  if (options.campaign === undefined) {
    throw new TaskServiceError('CAMPAIGN_ID_REQUIRED', EXIT_USAGE);
  }
  return options.campaign;
}

export const campaignStatusCmd = defineCommand({
  name: 'campaign status',
  description:
    'Project one campaign plan onto canonical round and task state and name every drift, without writing.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('campaign-status', 'Project a campaign onto runtime state')
      .option('--repo-root <path>', 'Repository root (default: cwd)')
      .option('--campaign <campaign_id>', 'Campaign identity, e.g. CMP-0007')
      .option('--human', 'Human-readable output')
      .action((options: CampaignOptions) => {
        try {
          const result = campaignStatus(root(options), requiredCampaign(options));
          emit(
            result,
            options.human === true,
            `campaign status: ${result.campaign_id}; ${String(result.drift.length)} drift(s)`,
            result.ok,
          );
        } catch (error) {
          failure('campaign status', error);
        }
      });
  },
});

export const campaignMaterialize = defineCommand({
  name: 'campaign materialize',
  description:
    'Materialize the tasks of one open campaign round through the round task queue exactly as campaign-execution.json maps them.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('campaign-materialize', 'Materialize an open campaign round')
      .option('--repo-root <path>', 'Repository root (default: cwd)')
      .option('--campaign <campaign_id>', 'Campaign identity, e.g. CMP-0007')
      .option('--round <round_id>', 'Open campaign round')
      .option('--human', 'Human-readable output')
      .action((options: CampaignOptions) => {
        try {
          if (options.round === undefined) {
            throw new TaskServiceError('TASK_ROUND_REQUIRED', EXIT_USAGE);
          }
          const result = materializeCampaignRound({
            repoRoot: root(options),
            campaignId: requiredCampaign(options),
            roundId: options.round,
          });
          emit(
            result,
            options.human === true,
            `campaign materialize: ${result.round_id}; ${String(result.materialized.length)} new, ${String(result.existing.length)} existing`,
          );
        } catch (error) {
          failure('campaign materialize', error);
        }
      });
  },
});

export const campaignCommands = [campaignMaterialize, campaignStatusCmd] as const;
