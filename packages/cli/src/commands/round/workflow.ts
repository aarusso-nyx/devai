import type { CAC } from 'cac';
import { readFileSync } from '@devai-nyx/authority';
import { EXIT_USAGE } from '@devai-nyx/utils';
import { resolve } from 'node:path';
import { runPostMergeAuditor } from '@devai-nyx/skills/post-merge-auditor';
import {
  closeGovernedRound,
  closePhase,
  declareGovernedRound,
  diffBlueprintAgainstInventory,
  emitRgr,
  governedRoundStatus,
  listRgrs,
  loadBlueprint,
  planScaffoldFromBlueprint,
  readRgr,
  requireActiveTaskRound,
  resolveRgr,
  roundTaskStatus,
  runRoundTasks,
  scaffoldGovernedRound,
  TaskServiceError,
  validateBlueprint,
  type PhaseClosureDraft,
} from '#runtime-core';
import { defineCommand } from '../../define-command.js';
import { resolveCliVersion } from '../../version.js';
import { dispatchRoundTask } from './dispatch.js';

interface RoundOptions {
  readonly repoRoot?: string;
  readonly round?: string;
  readonly human?: boolean;
}

function root(options: RoundOptions): string {
  return options.repoRoot ?? process.cwd();
}

function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function requiredRound(options: RoundOptions): string {
  if (options.round === undefined) throw new TaskServiceError('TASK_ROUND_REQUIRED', EXIT_USAGE);
  return options.round;
}

function emit(value: unknown, human: boolean, text: string, ok = true): void {
  process.stdout.write(human ? `${text}\n` : `${JSON.stringify(value)}\n`);
  process.exitCode = ok ? 0 : 2;
}

function failure(command: string, error: unknown): void {
  const code =
    error instanceof TaskServiceError
      ? error.code
      : error instanceof Error
        ? error.message
        : 'ROUND_OPERATION_FAILED';
  const exit = error instanceof TaskServiceError ? error.exitCode : 2;
  process.stderr.write(`${JSON.stringify({ code, operation: command, exit })}\n`);
  process.exitCode = exit;
}

function withRoundOptions(command: ReturnType<CAC['command']>): ReturnType<CAC['command']> {
  return command
    .option('--repo-root <path>', 'Repository root (default: cwd)')
    .option('--round <round_id>', 'Explicit governed round')
    .option('--human', 'Human-readable output');
}

export const roundAssess = defineCommand({
  name: 'round assess',
  description: 'Summarize tasks and open gaps for one active round.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    withRoundOptions(cli.command('round-assess', 'Assess one active governed round')).action(
      (options: RoundOptions) => {
        try {
          const round = requireActiveTaskRound({
            repoRoot: root(options),
            round: requiredRound(options),
          });
          const tasks = roundTaskStatus({ repoRoot: root(options), round });
          const taskIds = new Set(tasks.tasks.map((task) => task.id));
          const gaps = listRgrs(root(options)).filter((gap) => taskIds.has(gap.emitting_task_id));
          const byStatus: Record<string, number> = {};
          for (const task of tasks.tasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
          const assessment = {
            round_id: round,
            tasks: { count: tasks.count, by_status: byStatus },
            gaps: { count: gaps.length, open: gaps.filter((gap) => gap.status === 'open').length },
          };
          emit(
            assessment,
            options.human === true,
            `round assess: ${round}; ${String(tasks.count)} task(s), ${String(gaps.length)} gap(s)`,
          );
        } catch (error) {
          failure('assess', error);
        }
      },
    );
  },
});

export const roundClose = defineCommand({
  name: 'round close',
  description: 'Execute the authorized round-close transition; never infer release or publication.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    withRoundOptions(cli.command('round-close', 'Record an authorized round closure'))
      .option('--input <path>', 'Schema-valid phase-closure draft JSON')
      .option(
        '--post-merge-receipt',
        'Process one verified merge-event receipt through the post-merge Auditor',
      )
      .option('--host-receipt <path>', 'Issuer-authentic merge-event receipt')
      .action(
        async (
          options: RoundOptions & {
            input?: string;
            postMergeReceipt?: boolean;
            hostReceipt?: string;
          },
        ) => {
          if (options.postMergeReceipt === true) {
            if (options.hostReceipt === undefined) {
              process.stderr.write('HOST_RECEIPT_MISSING\n');
              process.exitCode = EXIT_USAGE;
              return;
            }
            try {
              const result = await runPostMergeAuditor({
                repoRoot: resolve(root(options)),
                hostReceiptPath: resolve(options.hostReceipt),
                injectFailure: process.env['DEVAI_TEST_POST_MERGE_FAIL'] === '1',
                devaiVersion: resolveCliVersion(),
              });
              emit(result, options.human === true, `round close post-merge: ${result.status}`);
            } catch (error) {
              failure('close-post-merge', error);
            }
            return;
          }
          try {
            const round = requireActiveTaskRound({
              repoRoot: root(options),
              round: requiredRound(options),
            });
            if (options.input === undefined)
              throw new TaskServiceError('ROUND_CLOSE_INPUT_REQUIRED', EXIT_USAGE);
            const draft = JSON.parse(readFileSync(options.input, 'utf8')) as PhaseClosureDraft;
            if (draft.round_id !== round) throw new TaskServiceError('TASK_ROUND_MISMATCH');
            const result = closePhase(root(options), draft);
            emit(result, options.human === true, `round close: ${round} -> ${result.record.id}`);
          } catch (error) {
            failure('close', error);
          }
        },
      );
  },
});

interface GapCreateOptions extends RoundOptions {
  readonly task?: string;
  readonly discipline?: 'engineer' | 'inspector' | 'auditor';
  readonly summary?: string;
  readonly ambiguity?: string;
  readonly evidence?: string | string[];
}

export const roundGapCreate = defineCommand({
  name: 'round gap create',
  description: 'Create a governed round gap record through the harness boundary.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    withRoundOptions(cli.command('round-gap-create', 'Create one active-round gap'))
      .option('--task <task_id>', 'Emitting task identity')
      .option('--discipline <role>', 'Emitting role')
      .option('--summary <text>', 'Gap summary')
      .option('--ambiguity <text>', 'Precise ambiguity')
      .option('--evidence <ref>', 'Evidence reference (repeatable)')
      .action((options: GapCreateOptions) => {
        try {
          const round = requiredRound(options);
          if (
            options.task === undefined ||
            options.discipline === undefined ||
            options.summary === undefined ||
            options.ambiguity === undefined
          ) {
            throw new TaskServiceError('ROUND_GAP_INPUT_REQUIRED', EXIT_USAGE);
          }
          roundTaskStatus({ repoRoot: root(options), round, taskId: options.task });
          const record = emitRgr({
            repoRoot: root(options),
            emittingTaskId: options.task,
            emittingDiscipline: options.discipline,
            summary: options.summary,
            ambiguity: options.ambiguity,
            evidenceRefs: asArray(options.evidence),
          });
          emit(record, options.human === true, `round gap create: ${record.id}`);
        } catch (error) {
          failure('gap create', error);
        }
      });
  },
});

function roundGaps(options: RoundOptions) {
  const status = roundTaskStatus({ repoRoot: root(options), round: requiredRound(options) });
  const taskIds = new Set(status.tasks.map((task) => task.id));
  return {
    round: status.round_id,
    gaps: listRgrs(root(options)).filter((gap) => taskIds.has(gap.emitting_task_id)),
  };
}

export const roundGapList = defineCommand({
  name: 'round gap list',
  description: 'List governed gaps for the active round.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    withRoundOptions(cli.command('round-gap-list', 'List active-round gaps')).action(
      (options: RoundOptions) => {
        try {
          const { round, gaps } = roundGaps(options);
          emit(
            { round_id: round, count: gaps.length, gaps },
            options.human === true,
            `round gap list: ${String(gaps.length)} gap(s)`,
          );
        } catch (error) {
          failure('gap list', error);
        }
      },
    );
  },
});

export const roundGapShow = defineCommand({
  name: 'round gap show',
  description: 'Show one governed round gap.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    withRoundOptions(cli.command('round-gap-show <gap-id>', 'Show one active-round gap')).action(
      (gapId: string, options: RoundOptions) => {
        try {
          const { gaps } = roundGaps(options);
          const gap =
            gaps.find((candidate) => candidate.id === gapId) ?? readRgr(root(options), gapId);
          if (gap === null || !gaps.some((candidate) => candidate.id === gapId))
            throw new TaskServiceError('ROUND_GAP_NOT_FOUND');
          emit(gap, options.human === true, `round gap show: ${gap.id} ${gap.status}`);
        } catch (error) {
          failure('gap show', error);
        }
      },
    );
  },
});

export const roundGapResolve = defineCommand({
  name: 'round gap resolve',
  description: 'Resolve a governed round gap through the harness boundary.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    withRoundOptions(cli.command('round-gap-resolve <gap-id>', 'Resolve one active-round gap'))
      .option('--resolver <identity>', 'Resolver identity')
      .option('--status <status>', 'resolved, rejected, or superseded')
      .action(
        (
          gapId: string,
          options: RoundOptions & {
            resolver?: string;
            status?: 'resolved' | 'rejected' | 'superseded';
          },
        ) => {
          try {
            const { gaps } = roundGaps(options);
            if (!gaps.some((gap) => gap.id === gapId))
              throw new TaskServiceError('ROUND_GAP_NOT_FOUND');
            if (options.resolver === undefined)
              throw new TaskServiceError('ROUND_GAP_RESOLVER_REQUIRED', EXIT_USAGE);
            const record = resolveRgr({
              repoRoot: root(options),
              rgrId: gapId,
              resolver: options.resolver,
              ...(options.status !== undefined && { newStatus: options.status }),
            });
            emit(
              record,
              options.human === true,
              `round gap resolve: ${record.id} -> ${record.status}`,
            );
          } catch (error) {
            failure('gap resolve', error);
          }
        },
      );
  },
});

export const roundPlan = defineCommand({
  name: 'round plan',
  description: 'Create or render Architect-owned round planning material from canonical inputs.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    withRoundOptions(cli.command('round-plan', 'Create governed round planning material'))
      .option('--scaffold', 'Scaffold the governed round')
      .option('--declare <record>', 'Declare from a schema-valid round record')
      .option('--blueprint <operation>', 'Blueprint projection: plan or diff')
      .option('--file <path>', 'Module-blueprint JSON input for --blueprint')
      .option('--against <path>', 'Repository inventory root for --blueprint diff')
      .action(
        (
          options: RoundOptions & {
            scaffold?: boolean;
            declare?: string;
            blueprint?: string;
            file?: string;
            against?: string;
          },
        ) => {
          try {
            if (options.blueprint !== undefined) {
              if (!['plan', 'diff'].includes(options.blueprint)) {
                throw new TaskServiceError('ROUND_BLUEPRINT_OPERATION_INVALID', 2);
              }
              if (options.file === undefined) {
                throw new TaskServiceError('ROUND_BLUEPRINT_FILE_REQUIRED', 2);
              }
              if (options.scaffold === true || options.declare !== undefined) {
                throw new TaskServiceError('ROUND_PLAN_SELECTION_CONFLICT', 2);
              }
              const file = resolve(root(options), options.file);
              const loaded = loadBlueprint(file);
              if (!loaded.ok || loaded.blueprint === undefined) {
                throw new TaskServiceError('ROUND_BLUEPRINT_SCHEMA_INVALID', 2);
              }
              if (options.blueprint === 'plan') {
                const validation = validateBlueprint(loaded.blueprint);
                if (!validation.ok) {
                  emit(
                    {
                      ok: false,
                      blueprint_id: loaded.blueprint.id,
                      violations: validation.violations,
                    },
                    options.human === true,
                    `round plan blueprint: ${loaded.blueprint.id} has ${String(validation.violations.length)} violation(s)`,
                    false,
                  );
                  return;
                }
                const plan = planScaffoldFromBlueprint(loaded.blueprint);
                emit(
                  { kind: 'blueprint-plan', ...plan },
                  options.human === true,
                  `round plan blueprint: ${plan.blueprint_id} v${plan.blueprint_version}; ${String(plan.tasks.length)} task(s)`,
                );
                return;
              }
              const inventoryRoot = resolve(root(options), options.against ?? '.');
              const diff = diffBlueprintAgainstInventory({
                blueprint: loaded.blueprint,
                inventoryRoot,
              });
              emit(
                {
                  kind: 'blueprint-diff',
                  ok: diff.status === 'aligned',
                  blueprint_id: loaded.blueprint.id,
                  blueprint_version: loaded.blueprint.module.version,
                  inventory_root: inventoryRoot,
                  ...diff,
                },
                options.human === true,
                `round plan blueprint diff: ${diff.status} (${String(diff.deltas.length)} delta(s))`,
              );
              return;
            }
            const round = requiredRound(options);
            const result =
              options.declare !== undefined
                ? declareGovernedRound({
                    repoRoot: root(options),
                    round,
                    recordPath: options.declare,
                  })
                : options.scaffold === true
                  ? scaffoldGovernedRound({ repoRoot: root(options), round })
                  : governedRoundStatus({ repoRoot: root(options), round });
            emit(result, options.human === true, `round plan: ${round}`);
          } catch (error) {
            failure('plan', error);
          }
        },
      );
  },
});

export const roundRun = defineCommand({
  name: 'round run',
  description:
    'Advance selected ready tasks within one active round through their declared executors.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    withRoundOptions(cli.command('round-run', 'Advance active-round ready tasks'))
      .option('--task <task_id>', 'Explicit task identity (repeatable)')
      .action(async (options: RoundOptions & { task?: string | string[] }) => {
        try {
          const repoRoot = root(options);
          const result = await runRoundTasks({
            repoRoot,
            round: requiredRound(options),
            ...(options.task !== undefined && { taskIds: asArray(options.task) }),
            dispatch: (task) => dispatchRoundTask(repoRoot, task),
          });
          emit(
            result,
            options.human === true,
            `round run: ${result.round_id}; ${String(result.results.length)} task(s)`,
            result.ok,
          );
        } catch (error) {
          failure('run', error);
        }
      });
  },
});

export const roundSeal = defineCommand({
  name: 'round seal',
  description: 'Seal Architect-owned round material without publishing it.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    withRoundOptions(cli.command('round-seal', 'Seal one closed governed round')).action(
      (options: RoundOptions) => {
        try {
          const round = requiredRound(options);
          const result = closeGovernedRound({ repoRoot: root(options), round });
          emit(result, options.human === true, `round seal: ${round}`);
        } catch (error) {
          failure('seal', error);
        }
      },
    );
  },
});

export const roundStatus = defineCommand({
  name: 'round status',
  description: 'Read one governed round in place and report its schema-valid canonical status.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    withRoundOptions(cli.command('round-status', 'Read governed round status')).action(
      (options: RoundOptions) => {
        try {
          const round = requiredRound(options);
          let lifecycle: unknown;
          try {
            lifecycle = governedRoundStatus({ repoRoot: root(options), round });
          } catch {
            lifecycle = {
              id: requireActiveTaskRound({ repoRoot: root(options), round }),
              location: 'active',
            };
          }
          const tasks = roundTaskStatus({ repoRoot: root(options), round });
          emit(
            { lifecycle, tasks },
            options.human === true,
            `round status: ${tasks.round_id}; ${String(tasks.count)} task(s)`,
          );
        } catch (error) {
          failure('status', error);
        }
      },
    );
  },
});

/** Current round handlers for central registration. */
export const roundWorkflowCommands = [
  roundAssess,
  roundClose,
  roundGapCreate,
  roundGapList,
  roundGapResolve,
  roundGapShow,
  roundPlan,
  roundRun,
  roundSeal,
  roundStatus,
] as const;
