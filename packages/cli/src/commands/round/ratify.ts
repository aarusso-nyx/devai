/**
 * `devai round ratify` — record one human decision on a task awaiting review (ADR-GOV-0025,
 * S4c): accept moves it to pre_merge and reject escalates it. Merge stays a separate human
 * act; nothing here merges, pushes, or closes the round.
 */
import type { CAC } from 'cac';
import { EXIT_USAGE } from '@devai-nyx/utils';
import { TaskServiceError, ratifyRoundTask } from '#runtime-core';
import { declaredInvocationRole } from '../../authority/index.js';
import { defineCommand } from '../../define-command.js';
import { emit, failure, root, type RoundOptions } from './workflow-support.js';

interface RatifyOptions extends RoundOptions {
  readonly task?: string;
  readonly decision?: string;
  readonly note?: string;
}

export const roundRatify = defineCommand({
  name: 'round ratify',
  description:
    'Record the Owner or Architect ratification of a task awaiting human review, separate from any merge.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('round-ratify', 'Ratify a reviewed task')
      .option('--repo-root <path>', 'Repository root (default: cwd)')
      .option('--round <round_id>', 'Explicit governed round')
      .option('--task <task_id>', 'Task awaiting human review')
      .option('--decision <decision>', 'accept or reject')
      .option('--note <text>', 'Optional ratification note')
      .option('--human', 'Human-readable output')
      .action((options: RatifyOptions) => {
        try {
          if (options.task === undefined || options.decision === undefined) {
            throw new TaskServiceError('RATIFICATION_INPUT_REQUIRED', EXIT_USAGE);
          }
          const record = ratifyRoundTask({
            repoRoot: root(options),
            ...(options.round !== undefined && { round: options.round }),
            taskId: options.task,
            decision: options.decision as 'accept' | 'reject',
            role: declaredInvocationRole() ?? '',
            ...(options.note !== undefined && { note: options.note }),
          });
          emit(
            record,
            options.human === true,
            `round ratify: ${record.task_id} ${record.decision} -> ${record.resulting_status}`,
          );
        } catch (error) {
          failure('ratify', error);
        }
      });
  },
});
