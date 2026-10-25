import { realpathSync } from 'node:fs';
import type { CAC } from 'cac';
import { readReconciliationPlan, ReconciliationPlanError } from '@devai-nyx/authority';
import { canonicalJson } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';
import { cliError, renderCliError } from '../../cli-error.js';

/** Read-only public entry; the live broker independently binds the original argv. */
export const evidenceReconcilePlan = defineCommand({
  name: 'evidence reconcile plan',
  description:
    'Inspect exact merge histories, staged sources and recovery obligations without writing.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('evidence-reconcile-plan', 'Plan exact evidence reconciliation without writing')
      .option('--repo-root <path>', 'Canonical repository root (required)')
      .option('--selected-parent <oid>', 'Exact published parent commit (required)')
      .option('--published-ref <ref>', 'Exact origin refs/heads branch (required)')
      .option('--as-role <role>', 'Architect initiation: architect (required)')
      .action((options: { repoRoot?: string }) => {
        try {
          if (options.repoRoot === undefined) throw new Error();
          const plan = readReconciliationPlan(realpathSync(options.repoRoot));
          process.stdout.write(`${canonicalJson(plan)}\n`);
          process.exitCode = 0;
        } catch (error) {
          const code =
            error instanceof ReconciliationPlanError ? error.code : 'RECONCILIATION_PLAN_INVALID';
          process.stderr.write(
            renderCliError(
              cliError({
                code,
                class: 'precondition',
                exit: 5,
                message: code,
                remediation:
                  'Inspect the exact source, index, publication and binding inputs; generate a fresh plan after resolving the refusal.',
              }),
              true,
            ),
          );
          process.exitCode = 5;
        }
      });
  },
});
