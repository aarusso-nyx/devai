/**
 * `devai round dispatch dispose` — the Owner's recorded disposition of uncertain or
 * blocked experimental work (ADR-MDL-0007, amending ADR-MDL-0005 D-6). The generic
 * authority layer admits it only for the Owner with both `--write` and
 * `--experimental`. It holds the round controller, so it never races a live dispatch.
 *
 * `--task T --as retry|escalate` disposes of one agent task with an open journal
 * attempt, left in progress by a crashed dispatch, or experimental_blocked: it writes
 * the disposition record, closes each open attempt in the journal, releases the task's
 * attempt worktrees, and moves the task to ready (continuing its attempt ladder) or
 * escalated. `--quarantine-journal` moves a damaged journal aside, named by its
 * SHA-256, with a disposition record, so dispatch can start a fresh chain; tasks left
 * in flight still need their own disposition.
 */
import type { CAC } from 'cac';
import { EXIT_USAGE } from '@devai-nyx/utils';
import {
  TaskServiceError,
  disposeDispatchTask,
  quarantineRoundDispatchJournal,
  type DispatchDisposition,
} from '#runtime-core';
import { defineCommand } from '../../define-command.js';
import {
  emit,
  failure,
  requiredRound,
  root,
  withRoundOptions,
  type RoundOptions,
} from './workflow-support.js';

interface DisposeOptions extends RoundOptions {
  readonly task?: string;
  readonly as?: string;
  readonly quarantineJournal?: boolean;
  readonly note?: string;
}

export const roundDispatchDispose = defineCommand({
  name: 'round dispatch dispose',
  description:
    'Record the Owner disposition of uncertain or blocked experimental work: retry or escalate one agent task, or quarantine a damaged dispatch journal, freeing its attempt worktrees.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    withRoundOptions(cli.command('round-dispatch-dispose', 'Dispose of uncertain dispatch work'))
      .option('--task <task_id>', 'Agent task to dispose of')
      .option('--as <disposition>', 'retry (back to ready) or escalate')
      .option('--quarantine-journal', 'Move a damaged dispatch journal aside')
      .option('--note <text>', 'Reason recorded with the disposition')
      .action((options: DisposeOptions) => {
        try {
          const repoRoot = root(options);
          const round = requiredRound(options);
          const note = options.note === undefined ? {} : { note: String(options.note) };
          if (options.quarantineJournal === true) {
            if (options.task !== undefined || options.as !== undefined) {
              throw new TaskServiceError('DISPOSITION_ARGUMENTS_CONFLICT', EXIT_USAGE);
            }
            const record = quarantineRoundDispatchJournal({ repoRoot, round, ...note });
            emit(
              record,
              options.human === true,
              `round dispatch dispose: journal quarantined (${record.id})`,
            );
            return;
          }
          if (options.task === undefined) {
            throw new TaskServiceError('DISPOSITION_TASK_REQUIRED', EXIT_USAGE);
          }
          if (options.as !== 'retry' && options.as !== 'escalate') {
            throw new TaskServiceError('DISPOSITION_INVALID', EXIT_USAGE);
          }
          const record = disposeDispatchTask({
            repoRoot,
            round,
            taskId: String(options.task),
            disposition: options.as as DispatchDisposition,
            ...note,
          });
          emit(
            record,
            options.human === true,
            `round dispatch dispose: ${String(record.task_id)} -> ${String(record.resulting_status)} (${record.id})`,
          );
        } catch (error) {
          failure('dispatch dispose', error);
        }
      });
  },
});
