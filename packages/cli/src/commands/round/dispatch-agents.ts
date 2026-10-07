/**
 * `devai round dispatch` — experimental agent dispatch (ADR-MDL-0005). The generic
 * authority layer admits it only with `--write` and `--experimental`. Before any lock,
 * worktree, or provider is touched, the handler requires a state root that `init apply
 * harness` durably initialized (#293) and an in-force Owner activation,
 * plans the selection exactly as the round runner will (its full same-round dependency
 * closure) and refuses it when the activation does not admit every planned task, and
 * refuses the round while uncertain work awaits a human disposition, naming each task.
 * Each admitted task then runs through the experimental ladder under the shared
 * invocation budget.
 */
import type { CAC } from 'cac';
import { EXIT_USAGE } from '@devai-nyx/utils';
import {
  DispatchUncertainError,
  TaskServiceError,
  assertNoUncertainDispatch,
  listTaskRecords,
  planRoundTaskAdmission,
  readExperimentalActivation,
  runRoundTasks,
  stateRootMarkerStatus,
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
import { commandRefusal } from '../../cli-error.js';

interface DispatchOptions extends RoundOptions {
  readonly task?: string | string[];
  readonly workers?: string | number;
}

/** The complete stored population; an unsupported or invalid record refuses with its code. */
function population(repoRoot: string): readonly TaskRecord[] {
  return listTaskRecords(repoRoot).map((entry) => {
    if (entry.kind !== 'current') throw new TaskServiceError(entry.code);
    return entry.record;
  });
}

/** The uncertainty refusal, naming every task and attempt that needs a disposition. */
function uncertainFailure(error: DispatchUncertainError): void {
  const envelope = commandRefusal(
    error.code,
    error.exitCode,
    { operation: 'dispatch', uncertain: error.uncertain },
    'Record a disposition for each named task and attempt with round dispatch dispose, then rerun.',
    'ROUND_OPERATION_FAILED',
  );
  process.stderr.write(`${JSON.stringify(envelope)}\n`);
  process.exitCode = envelope.exit;
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
          // #293: every dispatch record must live in a state root an authorized init step
          // made durable in `.devai`; the dispatch itself holds no authority above the root.
          const marker = stateRootMarkerStatus(repoRoot);
          if (marker !== 'valid') {
            throw new TaskServiceError(
              marker === 'absent'
                ? 'EXPERIMENTAL_STATE_ROOT_UNINITIALIZED'
                : 'EXPERIMENTAL_STATE_ROOT_MARKER_INVALID',
              EXIT_USAGE,
            );
          }
          const now = new Date();
          const activation = readExperimentalActivation(repoRoot, now);
          if (!activation.ok) throw new TaskServiceError(activation.code, EXIT_USAGE);
          const tasks = population(repoRoot);
          const selected = asArray(options.task);
          assertNoUncertainDispatch(repoRoot, round, tasks);
          // The runner dispatches the selection's whole dependency closure, so every task in
          // that closure must be one the activation admits before anything is locked.
          const plan = planRoundTaskAdmission({
            roundId: round,
            tasks,
            ...(selected.length > 0 && { selectedTaskIds: selected }),
          });
          for (const id of plan.orderedTaskIds) {
            const task = tasks.find((candidate) => candidate.id === id);
            if (task === undefined) throw new TaskServiceError('TASK_DEPENDENCY_MISSING');
            const refusal = experimentalTaskRefusal(task, activation.activation);
            if (refusal !== undefined) throw new TaskServiceError(refusal, EXIT_USAGE);
          }
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
          if (error instanceof DispatchUncertainError) uncertainFailure(error);
          else failure('dispatch', error);
        }
      });
  },
});
