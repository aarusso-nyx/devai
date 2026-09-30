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
  governedRoundStatus,
  listBacklogItems,
  listRgrs,
  loadBlueprint,
  planScaffoldFromBlueprint,
  requireActiveTaskRound,
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
import { recordRoundCloseTracking } from './tracking.js';

import {
  withRoundOptions,
  type RoundOptions,
  root,
  requiredRound,
  emit,
  failure,
  asArray,
} from './workflow-support.js';
import { roundGapCreate, roundGapList, roundGapResolve, roundGapShow } from './workflow-gaps.js';
export { roundGapCreate, roundGapList, roundGapShow, roundGapResolve } from './workflow-gaps.js';

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
            // Closure records and seals its final tracking event locally and never
            // waits for GitHub. Any remaining outbox is projected later, from sealed
            // evidence, by an explicit sync or the trusted-main workflow.
            const tracking = recordRoundCloseTracking({
              repoRoot: root(options),
              round,
              verdict: result.record.id,
            });
            emit(
              { ...result, ...(tracking === undefined ? {} : { tracking }) },
              options.human === true,
              `round close: ${round} -> ${result.record.id}` +
                (tracking === undefined ? '' : `; tracking_projection: ${tracking.projection}`),
            );
          } catch (error) {
            failure('close', error);
          }
        },
      );
  },
});

/**
 * ADR-GOV-0019: a planner sees open repository backlog items before scoping
 * tasks. Items are listed for every round alike; attribution is never inferred.
 */
function openBacklogItems(repoRoot: string): ReadonlyArray<Record<string, string>> {
  try {
    return listBacklogItems({ repoRoot }).map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      status: item.status,
      ...(item.round_id === undefined ? {} : { round_id: item.round_id }),
    }));
  } catch {
    // The backlog is advisory for planning; an unreadable item is reported by doctor.
    return [];
  }
}

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
            const backlog = openBacklogItems(root(options));
            emit(
              backlog.length === 0 ? result : { ...result, open_backlog_items: backlog },
              options.human === true,
              `round plan: ${round}` +
                (backlog.length === 0 ? '' : `; ${String(backlog.length)} open backlog item(s)`),
            );
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
          const repoRoot = root(options);
          let lifecycle: { readonly location: string; readonly [key: string]: unknown };
          try {
            lifecycle = governedRoundStatus({ repoRoot, round });
          } catch (error) {
            // Named lifecycle failures (missing round, conflicting close state) surface as is.
            if (error instanceof Error && /^ROUND_[A-Z0-9_]+$/u.test(error.message)) throw error;
            lifecycle = { id: requireActiveTaskRound({ repoRoot, round }), location: 'active' };
          }
          let tasks: ReturnType<typeof roundTaskStatus> | undefined;
          try {
            tasks = roundTaskStatus({ repoRoot, round });
          } catch (error) {
            // An inactive or sealed task round omits the summary; other failures surface.
            if (!(error instanceof TaskServiceError) || error.code !== 'TASK_ROUND_INACTIVE') {
              throw error;
            }
          }
          emit(
            tasks === undefined ? { lifecycle } : { lifecycle, tasks },
            options.human === true,
            tasks === undefined
              ? `round status: ${round}; ${lifecycle.location}`
              : `round status: ${tasks.round_id}; ${String(tasks.count)} task(s)`,
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
