/**
 * `devai round dispatch activate` — the Owner's activation of experimental agent
 * dispatch (ADR-MDL-0005 D-1 as amended by ADR-MDL-0006).
 *
 * The generic authority layer admits this action only for the Owner with both
 * `--write` and `--experimental`. The handler then checks the Owner-authored input
 * against its schema, its expiry, and every experimental-execution ceiling before
 * it replaces the runtime-state record; a refused input leaves any earlier record
 * untouched.
 */
import type { CAC } from 'cac';
import { readFileSync } from '@devai-nyx/authority';
import { EXIT_USAGE } from '@devai-nyx/utils';
import { resolve } from 'node:path';
import {
  EXPERIMENTAL_ACTIVATION_RECORD,
  TaskServiceError,
  canonicalSha256,
  checkExperimentalActivation,
  writeExperimentalActivation,
} from '#runtime-core';
import { defineCommand } from '../../define-command.js';
import { emit, failure, root, type RoundOptions } from './workflow-support.js';

interface ActivateOptions extends RoundOptions {
  readonly input?: string;
}

export const roundDispatchActivate = defineCommand({
  name: 'round dispatch activate',
  description:
    'Record the Owner activation that permits experimental agent dispatch in this repository, within the experimental-execution policy ceilings and until it expires.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('round-dispatch-activate', 'Activate experimental agent dispatch')
      .option('--repo-root <path>', 'Repository root (default: cwd)')
      .option('--input <file>', 'Owner-authored experimental-activation JSON')
      .option('--human', 'Human-readable output')
      .action((options: ActivateOptions) => {
        try {
          if (options.input === undefined) {
            throw new TaskServiceError('EXPERIMENTAL_ACTIVATION_INPUT_REQUIRED', EXIT_USAGE);
          }
          const repoRoot = root(options);
          let value: unknown;
          try {
            value = JSON.parse(readFileSync(resolve(options.input), 'utf8'));
          } catch {
            throw new TaskServiceError('EXPERIMENTAL_ACTIVATION_INVALID', EXIT_USAGE);
          }
          const checked = checkExperimentalActivation(value, new Date());
          if (!checked.ok) throw new TaskServiceError(checked.code, EXIT_USAGE);
          writeExperimentalActivation(repoRoot, checked.activation);
          emit(
            {
              activated: true,
              record: EXPERIMENTAL_ACTIVATION_RECORD,
              digest_sha256: canonicalSha256(checked.activation),
              expires_at: checked.activation.expires_at,
              disciplines: checked.activation.disciplines,
              runtimes: checked.activation.runtimes.map((entry) => entry.runtime),
              budgets: checked.activation.budgets,
            },
            options.human === true,
            `round dispatch activate: experimental dispatch active until ${checked.activation.expires_at}`,
          );
        } catch (error) {
          failure('dispatch activate', error);
        }
      });
  },
});
