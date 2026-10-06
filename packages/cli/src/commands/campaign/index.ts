/**
 * `devai campaign …` — campaigns reach the runtime through one read-only projection and
 * one materializer (ADR-GOV-0025, S4a and S4b). The materializer writes only through the
 * round task queue and never starts, dispatches, or merges work. A campaign task that
 * declares an agent executor contract materializes as an agent task bound to its composed
 * prompt, ready for `round dispatch --experimental` (ADR-MDL-0009).
 */
import type { CAC } from 'cac';
import { EXIT_USAGE } from '@devai-nyx/utils';
import {
  TaskServiceError,
  campaignStatus,
  composeAgentPrompt,
  materializeCampaignRound,
  type CampaignAgentBinding,
} from '#runtime-core';
import { defineCommand } from '../../define-command.js';
import { EXPERIMENTAL_TIER_ORDER } from '../../services/experimental-dispatch/index.js';
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

/**
 * The agent binding of materialization: the runtime model aliases of model-tiers.json and
 * the Article 37 composition id `round dispatch` recomputes before any attempt.
 */
export function campaignAgentBinding(repoRoot: string): CampaignAgentBinding {
  return {
    models: EXPERIMENTAL_TIER_ORDER,
    promptCompositionId: (task) => composeAgentPrompt({ repoRoot, task }).composition.id,
  };
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
          const repoRoot = root(options);
          const result = materializeCampaignRound({
            repoRoot,
            campaignId: requiredCampaign(options),
            roundId: options.round,
            agent: campaignAgentBinding(repoRoot),
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
