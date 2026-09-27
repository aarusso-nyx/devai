import type { CAC } from 'cac';
import { EXIT_USAGE } from '@devai-nyx/utils';
import {
  emitRgr,
  listRgrs,
  readRgr,
  resolveRgr,
  roundTaskStatus,
  TaskServiceError,
} from '#runtime-core';
import { defineCommand } from '../../define-command.js';
import { trackGovernanceEvent } from '#runtime-core';
import {
  withRoundOptions,
  type RoundOptions,
  root,
  requiredRound,
  emit,
  failure,
  asArray,
} from './workflow-support.js';

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
          trackGovernanceEvent({
            repoRoot: root(options),
            round,
            role: record.emitting_discipline,
            kind: 'finding_emitted',
            status: 'review',
            taskId: record.emitting_task_id,
            summary: `Reference gap ${record.id} emitted: ${record.problem.summary}`,
            payload: record,
            evidenceRefs: [record.id, ...record.evidence_refs],
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
            trackGovernanceEvent({
              repoRoot: root(options),
              round: requiredRound(options),
              role: 'architect',
              kind: 'finding_classified',
              status: record.status === 'resolved' ? 'pass' : 'review',
              taskId: record.emitting_task_id,
              summary: `Reference gap ${record.id} resolved to ${record.status}.`,
              payload: record,
              evidenceRefs: [record.id],
              checkpoint: true,
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
