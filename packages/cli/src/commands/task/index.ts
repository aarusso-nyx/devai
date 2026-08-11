import type { CAC } from 'cac';
import { EXIT_USAGE } from '@devai-nyx/utils';
import {
  addRoundQueueEntry,
  completeRoundQueueEntry,
  escalateRoundTask,
  finishRoundTask,
  listRoundQueue,
  nextRoundQueueEntry,
  pauseRoundTask,
  resumeRoundTask,
  roundTaskStatus,
  roundTaskResourceStatus,
  startRoundTask,
  TaskServiceError,
} from '#runtime-core';
import { defineCommand } from '../../define-command.js';

interface CommonOptions {
  readonly repoRoot?: string;
  readonly round?: string;
  readonly human?: boolean;
}

interface TaskOptions extends CommonOptions {
  readonly task?: string;
  readonly gap?: string;
  readonly destroyWorktree?: boolean;
  readonly databaseUrl?: string;
  readonly dropDb?: boolean;
  readonly evidence?: string | string[];
  readonly completedByRole?: 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';
  readonly containerName?: string;
}

function repoRoot(options: CommonOptions): string {
  return options.repoRoot ?? process.cwd();
}

function taskFailure(command: string, error: unknown): void {
  const code = error instanceof TaskServiceError ? error.code : 'TASK_OPERATION_FAILED';
  const exit = error instanceof TaskServiceError ? error.exitCode : 2;
  process.stderr.write(`${JSON.stringify({ code, operation: command, exit })}\n`);
  process.exitCode = exit;
}

function requiredTask(options: TaskOptions): string {
  if (options.task === undefined || options.task.length === 0) {
    throw new TaskServiceError('TASK_ID_REQUIRED', EXIT_USAGE);
  }
  return options.task;
}

function emit(value: unknown, human: boolean, text: string): void {
  process.stdout.write(human ? `${text}\n` : `${JSON.stringify(value)}\n`);
  process.exitCode = 0;
}

function registerRoundOption(command: ReturnType<CAC['command']>): ReturnType<CAC['command']> {
  return command
    .option('--repo-root <path>', 'Repository root (default: cwd)')
    .option('--round <round_id>', 'Explicit active owning round (required)')
    .option('--human', 'Human-readable output');
}

export const taskQueueAdd = defineCommand({
  name: 'task queue add',
  description: 'Add one task to an active round queue through hidden plumbing.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    registerRoundOption(cli.command('task-queue-add', 'Add one active-round queue item'))
      .option('--title <text>', 'Queue item title')
      .option('--priority <number>', 'Priority (default: 50)')
      .option('--description <text>', 'Queue item description')
      .action(
        (options: CommonOptions & { title?: string; priority?: number; description?: string }) => {
          try {
            if (options.round === undefined)
              throw new TaskServiceError('TASK_ROUND_REQUIRED', EXIT_USAGE);
            if (options.title === undefined)
              throw new TaskServiceError('TASK_QUEUE_TITLE_REQUIRED', EXIT_USAGE);
            const entry = addRoundQueueEntry({
              repoRoot: repoRoot(options),
              round: options.round,
              title: options.title,
              ...(options.priority !== undefined && { priority: options.priority }),
              ...(options.description !== undefined && { description: options.description }),
            });
            emit(entry, options.human === true, `task queue add: ${entry.id}`);
          } catch (error) {
            taskFailure('queue add', error);
          }
        },
      );
  },
});

export const taskQueueComplete = defineCommand({
  name: 'task queue complete',
  description: 'Complete one active-round queue item through hidden plumbing.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    registerRoundOption(cli.command('task-queue-complete', 'Complete one queue item'))
      .option('--task <task_id>', 'Queue task identity')
      .action((options: TaskOptions) => {
        try {
          if (options.round === undefined)
            throw new TaskServiceError('TASK_ROUND_REQUIRED', EXIT_USAGE);
          const entry = completeRoundQueueEntry({
            repoRoot: repoRoot(options),
            round: options.round,
            taskId: requiredTask(options),
          });
          emit(entry, options.human === true, `task queue complete: ${entry.id}`);
        } catch (error) {
          taskFailure('queue complete', error);
        }
      });
  },
});

export const taskQueueList = defineCommand({
  name: 'task queue list',
  description: 'List active-round queue items through hidden plumbing.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    registerRoundOption(cli.command('task-queue-list', 'List active-round queue items')).action(
      (options: CommonOptions) => {
        try {
          if (options.round === undefined)
            throw new TaskServiceError('TASK_ROUND_REQUIRED', EXIT_USAGE);
          const entries = listRoundQueue({ repoRoot: repoRoot(options), round: options.round });
          emit(
            { round_id: options.round, count: entries.length, entries },
            options.human === true,
            `task queue list: ${String(entries.length)} item(s)`,
          );
        } catch (error) {
          taskFailure('queue list', error);
        }
      },
    );
  },
});

export const taskQueueNext = defineCommand({
  name: 'task queue next',
  description: 'Select the next ready active-round queue item through hidden plumbing.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    registerRoundOption(cli.command('task-queue-next', 'Read the next queue item')).action(
      (options: CommonOptions) => {
        try {
          if (options.round === undefined)
            throw new TaskServiceError('TASK_ROUND_REQUIRED', EXIT_USAGE);
          const next = nextRoundQueueEntry({ repoRoot: repoRoot(options), round: options.round });
          emit(
            { round_id: options.round, next },
            options.human === true,
            `task queue next: ${next?.id ?? '(empty)'}`,
          );
        } catch (error) {
          taskFailure('queue next', error);
        }
      },
    );
  },
});

export const taskStart = defineCommand({
  name: 'task start',
  description: 'Start one round-subordinate task and provision only its declared resources.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    registerRoundOption(cli.command('task-start', 'Start one active-round task'))
      .option('--task <task_id>', 'Task identity')
      .option('--with-worktree', 'Provision the declared managed worktree')
      .option('--with-db', 'Provision the declared task database')
      .option('--database-url <url>', 'Postgres URL for --with-db')
      .option('--base-ref <ref>', 'Exact base ref for a managed worktree')
      .action(
        (options: TaskOptions & { withWorktree?: boolean; withDb?: boolean; baseRef?: string }) => {
          try {
            if (options.round === undefined)
              throw new TaskServiceError('TASK_ROUND_REQUIRED', EXIT_USAGE);
            const result = startRoundTask({
              repoRoot: repoRoot(options),
              round: options.round,
              taskId: requiredTask(options),
              ...(options.withWorktree === true && { withWorktree: true }),
              ...(options.withDb === true && { withDb: true }),
              ...(options.databaseUrl !== undefined && { databaseUrl: options.databaseUrl }),
              ...(options.baseRef !== undefined && { baseRef: options.baseRef }),
            });
            emit(
              result,
              options.human === true,
              `task start: ${result.task.id} -> ${result.task.status}`,
            );
          } catch (error) {
            taskFailure('start', error);
          }
        },
      );
  },
});

function transitionCommand(
  name: 'task finish' | 'task escalate',
  description: string,
  transition: typeof finishRoundTask,
) {
  return defineCommand({
    name,
    description,
    authority: 'mesh_controller',
    register(cli: CAC): void {
      registerRoundOption(cli.command(name.replaceAll(' ', '-'), description))
        .option('--task <task_id>', 'Task identity')
        .option('--destroy-worktree', 'Destroy the declared managed worktree')
        .option('--drop-db', 'Drop the declared task database during the transition')
        .option('--database-url <url>', 'Postgres URL used only with --drop-db')
        .option('--evidence <ref>', 'Human completion evidence reference (repeatable)')
        .option('--completed-by-role <role>', 'Authenticated human completion role')
        .action((options: TaskOptions) => {
          try {
            if (options.round === undefined)
              throw new TaskServiceError('TASK_ROUND_REQUIRED', EXIT_USAGE);
            if (options.dropDb === true && options.databaseUrl === undefined) {
              throw new TaskServiceError('TASK_DATABASE_URL_REQUIRED', EXIT_USAGE);
            }
            if (options.databaseUrl !== undefined && options.dropDb !== true) {
              throw new TaskServiceError('TASK_DROP_DB_CONSENT_REQUIRED', EXIT_USAGE);
            }
            const task = transition({
              repoRoot: repoRoot(options),
              round: options.round,
              taskId: requiredTask(options),
              ...(options.destroyWorktree === true && { destroyWorktree: true }),
              ...(options.dropDb === true &&
                options.databaseUrl !== undefined && { databaseUrl: options.databaseUrl }),
              ...(options.evidence !== undefined && {
                evidence: Array.isArray(options.evidence) ? options.evidence : [options.evidence],
              }),
              ...(options.completedByRole !== undefined && {
                completedByRole: options.completedByRole,
              }),
            });
            emit(task, options.human === true, `${name}: ${task.id} -> ${task.status}`);
          } catch (error) {
            taskFailure(name.slice('task '.length), error);
          }
        });
    },
  });
}

export const taskFinish = transitionCommand(
  'task finish',
  'Finish one round-subordinate task and release its declared resources.',
  finishRoundTask,
);
export const taskEscalate = transitionCommand(
  'task escalate',
  'Escalate one round-subordinate task through hidden plumbing.',
  escalateRoundTask,
);

export const taskPause = defineCommand({
  name: 'task pause',
  description: 'Pause one round-subordinate task on a governed gap.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    registerRoundOption(cli.command('task-pause', 'Pause one task on a governed gap'))
      .option('--task <task_id>', 'Task identity')
      .option('--gap <gap_id>', 'Governed gap identity')
      .action((options: TaskOptions) => {
        try {
          if (options.round === undefined)
            throw new TaskServiceError('TASK_ROUND_REQUIRED', EXIT_USAGE);
          if (options.gap === undefined)
            throw new TaskServiceError('TASK_GAP_REQUIRED', EXIT_USAGE);
          const task = pauseRoundTask({
            repoRoot: repoRoot(options),
            round: options.round,
            taskId: requiredTask(options),
            gapId: options.gap,
          });
          emit(task, options.human === true, `task pause: ${task.id} -> ${task.status}`);
        } catch (error) {
          taskFailure('pause', error);
        }
      });
  },
});

export const taskResume = defineCommand({
  name: 'task resume',
  description: 'Resume one paused round-subordinate task after its governed gap resolves.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    registerRoundOption(cli.command('task-resume', 'Resume one task after gap resolution'))
      .option('--task <task_id>', 'Task identity')
      .option('--gap <gap_id>', 'Governed gap identity')
      .action((options: TaskOptions) => {
        try {
          if (options.round === undefined)
            throw new TaskServiceError('TASK_ROUND_REQUIRED', EXIT_USAGE);
          if (options.gap === undefined)
            throw new TaskServiceError('TASK_GAP_REQUIRED', EXIT_USAGE);
          const task = resumeRoundTask({
            repoRoot: repoRoot(options),
            round: options.round,
            taskId: requiredTask(options),
            gapId: options.gap,
          });
          emit(task, options.human === true, `task resume: ${task.id} -> ${task.status}`);
        } catch (error) {
          taskFailure('resume', error);
        }
      });
  },
});

export const taskStatus = defineCommand({
  name: 'task status',
  description: 'Read task and managed-resource status for one active round.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    registerRoundOption(cli.command('task-status', 'Read active-round task status'))
      .option('--task <task_id>', 'Optional task identity')
      .option('--resources <kind>', 'Resource projection: db, locks, or worktrees')
      .option('--container-name <name>', 'Shared database container identity')
      .option('--database-url <url>', 'Postgres URL for task database enumeration')
      .action((options: TaskOptions & { resources?: string }) => {
        try {
          if (options.round === undefined)
            throw new TaskServiceError('TASK_ROUND_REQUIRED', EXIT_USAGE);
          const common = {
            repoRoot: repoRoot(options),
            round: options.round,
            ...(options.task !== undefined && { taskId: options.task }),
          };
          const status =
            options.resources === undefined
              ? roundTaskStatus(common)
              : ['db', 'locks', 'worktrees'].includes(options.resources)
                ? roundTaskResourceStatus({
                    ...common,
                    resource: options.resources as 'db' | 'locks' | 'worktrees',
                    ...(options.containerName !== undefined && {
                      containerName: options.containerName,
                    }),
                    ...(options.databaseUrl !== undefined && {
                      databaseUrl: options.databaseUrl,
                    }),
                  })
                : (() => {
                    throw new TaskServiceError('TASK_RESOURCE_KIND_INVALID', EXIT_USAGE);
                  })();
          emit(
            status,
            options.human === true,
            `task status: ${options.round}${options.resources === undefined ? '' : ` ${options.resources}`}`,
          );
        } catch (error) {
          taskFailure('status', error);
        }
      });
  },
});

export const taskCommands = [
  taskQueueAdd,
  taskQueueComplete,
  taskQueueList,
  taskQueueNext,
  taskStart,
  taskFinish,
  taskEscalate,
  taskPause,
  taskResume,
  taskStatus,
] as const;
