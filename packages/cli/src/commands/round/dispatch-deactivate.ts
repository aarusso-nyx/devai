/**
 * `devai round dispatch deactivate` — the Owner's withdrawal of experimental agent
 * dispatch (ADR-MDL-0007). The generic authority layer admits this action only for the
 * Owner with both `--write` and `--experimental`. It writes a create-only withdrawal
 * record naming the time and the withdrawn activation's digests, then removes the
 * activation record, so the repository returns to the supported serial runner. A
 * dispatch already running keeps the activation it read when it started.
 */
import type { CAC } from 'cac';
import { EXPERIMENTAL_ACTIVATION_RECORD, withdrawExperimentalActivation } from '#runtime-core';
import { relative } from 'node:path';
import { defineCommand } from '../../define-command.js';
import { emit, failure, root, type RoundOptions } from './workflow-support.js';

interface DeactivateOptions extends RoundOptions {
  readonly note?: string;
}

export const roundDispatchDeactivate = defineCommand({
  name: 'round dispatch deactivate',
  description:
    'Withdraw the Owner activation of experimental agent dispatch, recording who withdrew it, when, and the digest of the withdrawn activation.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('round-dispatch-deactivate', 'Withdraw experimental agent dispatch')
      .option('--repo-root <path>', 'Repository root (default: cwd)')
      .option('--note <text>', 'Reason recorded with the withdrawal')
      .option('--human', 'Human-readable output')
      .action((options: DeactivateOptions) => {
        try {
          const repoRoot = root(options);
          const withdrawn = withdrawExperimentalActivation({
            repoRoot,
            ...(options.note !== undefined && { note: String(options.note) }),
          });
          emit(
            {
              deactivated: true,
              record: EXPERIMENTAL_ACTIVATION_RECORD,
              withdrawal: relative(repoRoot, withdrawn.path),
              ...withdrawn.withdrawal,
            },
            options.human === true,
            `round dispatch deactivate: experimental dispatch withdrawn (${withdrawn.withdrawal.id})`,
          );
        } catch (error) {
          failure('dispatch deactivate', error);
        }
      });
  },
});
