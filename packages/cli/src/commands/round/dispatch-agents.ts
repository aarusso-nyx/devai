/**
 * `devai round dispatch` — experimental agent dispatch (ADR-MDL-0005). The generic
 * authority layer admits it only with `--write` and `--experimental`. Before any lock,
 * worktree, or provider is touched, the handler requires an in-force Owner activation,
 * refuses a selection with any task the activation does not admit, and refuses the
 * round while uncertain journal work awaits a human disposition. Each admitted task
 * then runs through the experimental ladder under the shared invocation budget.
 */
import type { CAC } from 'cac';
import { EXIT_USAGE } from '@devai-nyx/utils';
import {
  TaskServiceError,
  assertNoUncertainDispatch,
  listTaskRecords,
  readExperimentalActivation,
  runRoundTasks,
  type TaskRecord,
} from '#runtime-core';
import { defineCommand } from '../../define-command.js';
import {
  dispatchExperimentalTask,
  experimentalTaskRefusal,
  type ExperimentalBudget,
} from '../../services/experimental-dispatch/index.js';
import {
  asArray,
  emit,
  failure,
  requiredRound,
  root,
  type RoundOptions,
} from './workflow-support.js';

interface DispatchOptions extends RoundOptions {
  readonly task?: string | string[];
  readonly workers?: string | number;
}

function currentTasks(repoRoot: string): readonly TaskRecord[] {
  return listTaskRecords(repoRoot).flatMap((entry) =>
    entry.kind === 'current' ? [entry.record] : [],
  );
}

export const roundDispatch = defineCommand({
  name: 'round dispatch',
  description:
    'Dispatch admitted agent tasks of one active round through the experimental provider ladder under the Owner activation; evidence is non-promoting and results await human review.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('round-dispatch', 'Dispatch agent tasks under experimental policy')
      .option('--repo-root <path>', 'Repository root (default: cwd)')
      .option('--round <round_id>', 'Explicit governed round')
      .option('--task <task_id>', 'Explicit task identity (repeatable)')
      .option('--workers <count>', 'Opt-in concurrent workers (default 1)')
      .option('--human', 'Human-readable output')
      .action(async (options: DispatchOptions) => {
        try {
          const repoRoot = root(options);
          const round = requiredRound(options);
          const now = new Date();
          const activation = readExperimentalActivation(repoRoot, now);
          if (!activation.ok) throw new TaskServiceError(activation.code, EXIT_USAGE);
          const tasks = currentTasks(repoRoot);
          const selected = asArray(options.task);
          const population = tasks.filter(
            (task) =>
              task.round_id === round &&
              (selected.length > 0 ? selected.includes(task.id) : task.status === 'ready'),
          );
          for (const task of population) {
            const refusal = experimentalTaskRefusal(task, activation.activation);
            if (refusal !== undefined) throw new TaskServiceError(refusal, EXIT_USAGE);
          }
          assertNoUncertainDispatch(repoRoot, round, tasks);
          const budget: ExperimentalBudget = { attempts: 0, tokens: 0, unverifiable: false };
          const result = await runRoundTasks({
            repoRoot,
            round,
            ...(selected.length > 0 && { taskIds: selected }),
            ...(options.workers !== undefined && { maxWorkers: Number(options.workers) }),
            dispatch: (task) =>
              dispatchExperimentalTask(
                { repoRoot, roundId: round, activation: activation.activation, budget },
                task,
              ),
          });
          emit(
            { ...result, experimental: true, budget_used: budget },
            options.human === true,
            `round dispatch: ${result.round_id}; ${String(result.results.length)} task(s); ${String(budget.attempts)} attempt(s)`,
            result.ok,
          );
        } catch (error) {
          failure('dispatch', error);
        }
      });
  },
});
