import type { CAC } from 'cac';
import { spawnSync } from '@devai-nyx/authority';
import { EXIT_USAGE } from '@devai-nyx/utils';
import {
  addBacklogItem,
  GovernanceTrackingError,
  listBacklogItems,
  projectBacklogItem,
  resolveBacklogItem,
  showBacklogItem,
  type BacklogClass,
  type BacklogKind,
  type BacklogRole,
} from '#runtime-core';
import { declaredInvocationRole } from '../../authority/index.js';
import { defineCommand } from '../../define-command.js';
import { directCliChainId } from '../round/tracking-session.js';

/**
 * Repository backlog actions (ADR-GOV-0019). Every action is local: add and
 * resolve write only under `.devai/state/backlog/` and the shared counters
 * file, list and show only read, and none of them reaches the network. A
 * round is attributed only through an explicit `--round`.
 */

const KINDS: readonly BacklogKind[] = ['finding', 'proposition', 'note', 'flaky-test'];
const CLASSES: readonly BacklogClass[] = [
  'law',
  'spec',
  'plan',
  'code',
  'tests',
  'docs',
  'ci',
  'toolchain',
  'generated',
];
const ROLES: readonly BacklogRole[] = ['owner', 'architect', 'inspector', 'engineer', 'auditor'];
const STATUSES = ['open', 'resolved', 'all'] as const;
const ID_PATTERN = /^BL-[0-9]{4,}$/u;
const ROUND_PATTERN = /^R-[0-9]{4}$/u;

type Value = string | string[] | undefined;

interface BacklogOptions {
  readonly repoRoot?: Value;
  readonly human?: boolean;
}

class BacklogUsageError extends Error {
  constructor(
    readonly code: string,
    readonly exit: number = EXIT_USAGE,
  ) {
    super(code);
    this.name = 'BacklogUsageError';
  }
}

/** A repeated flag keeps its last value, as a later declaration overrides an earlier one. */
function single(value: Value): string | undefined {
  if (Array.isArray(value)) return value.length === 0 ? undefined : String(value.at(-1));
  return value === undefined ? undefined : String(value);
}

function root(options: BacklogOptions): string {
  return single(options.repoRoot) ?? process.cwd();
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], code: string) {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new BacklogUsageError(code);
  return value as T;
}

function emit(value: unknown, human: boolean, text: string): void {
  process.stdout.write(human ? `${text}\n` : `${JSON.stringify(value)}\n`);
  process.exitCode = 0;
}

const NOT_FOUND_CODES = new Set(['BACKLOG_ITEM_NOT_FOUND', 'BACKLOG_ITEM_ALREADY_RESOLVED']);

function failure(operation: string, error: unknown): void {
  let code = 'BACKLOG_OPERATION_FAILED';
  let exit = 1;
  if (error instanceof BacklogUsageError) {
    code = error.code;
    exit = error.exit;
  } else if (error instanceof Error) {
    const declared = (error as { code?: unknown }).code;
    code = typeof declared === 'string' ? declared : error.message;
    exit = NOT_FOUND_CODES.has(code) ? 1 : EXIT_USAGE;
  }
  process.stderr.write(`${JSON.stringify({ code, operation: `backlog ${operation}`, exit })}\n`);
  process.exitCode = exit;
}

function requireId(id: unknown): string {
  const value = typeof id === 'string' ? id : undefined;
  if (value === undefined || !ID_PATTERN.test(value)) {
    throw new BacklogUsageError('BACKLOG_ITEM_ID_INVALID');
  }
  return value;
}

function headCommit(repoRoot: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  const head = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (result.status !== 0 || !/^[0-9a-f]{40}$/u.test(head)) {
    throw new BacklogUsageError('BACKLOG_ORIGIN_COMMIT_UNAVAILABLE', 1);
  }
  return head;
}

function withRepoRoot(command: ReturnType<CAC['command']>): ReturnType<CAC['command']> {
  return command
    .option('--repo-root <path>', 'Repository root (default: cwd)')
    .option('--human', 'Human-readable output');
}

interface AddOptions extends BacklogOptions {
  readonly kind?: Value;
  readonly title?: Value;
  readonly body?: Value;
  readonly class?: Value;
  readonly round?: Value;
  readonly role?: Value;
}

export const backlogAdd = defineCommand({
  name: 'backlog add',
  description: 'Record one schema-validated repository backlog item.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    withRepoRoot(cli.command('backlog-add', 'Record one repository backlog item'))
      .option('--kind <kind>', 'finding, proposition, note, or flaky-test')
      .option('--title <text>', 'Short title')
      .option('--body <text>', 'Item body')
      .option('--class <class>', 'Change class when the item concerns a path')
      .option('--round <round_id>', 'Explicit round attribution; never inferred')
      .option('--role <role>', 'Originating role (default: the declared invocation role)')
      .action((options: AddOptions) => {
        try {
          const kind = oneOf(single(options.kind), KINDS, 'BACKLOG_KIND_INVALID');
          const title = single(options.title);
          const body = single(options.body);
          if (kind === undefined || title === undefined || body === undefined) {
            throw new BacklogUsageError('BACKLOG_ADD_INPUT_REQUIRED');
          }
          const itemClass = oneOf(single(options.class), CLASSES, 'BACKLOG_CLASS_INVALID');
          const round = single(options.round);
          if (round !== undefined && !ROUND_PATTERN.test(round)) {
            throw new BacklogUsageError('BACKLOG_ROUND_INVALID');
          }
          const role =
            oneOf(single(options.role), ROLES, 'BACKLOG_ROLE_INVALID') ?? declaredInvocationRole();
          if (role === undefined) throw new BacklogUsageError('BACKLOG_ROLE_REQUIRED');
          const repoRoot = root(options);
          const item = addBacklogItem({
            repoRoot,
            kind,
            title,
            body,
            ...(itemClass === undefined ? {} : { class: itemClass }),
            ...(round === undefined ? {} : { roundId: round }),
            origin: {
              session: directCliChainId({
                repositoryId: 'repository-backlog',
                role,
                round: 'backlog',
              }),
              role,
              commit: headCommit(repoRoot),
            },
          });
          if (item.round_id !== undefined) {
            try {
              projectBacklogItem({ repoRoot, id: item.id });
            } catch (error) {
              // Projection is opt-in through the round's Owner activation. Without
              // one the item stays local; tracking never alters the recorded item.
              if (!(error instanceof GovernanceTrackingError)) throw error;
            }
          }
          emit(item, options.human === true, `backlog add: ${item.id}`);
        } catch (error) {
          failure('add', error);
        }
      });
  },
});

interface ListOptions extends BacklogOptions {
  readonly status?: Value;
  readonly round?: Value;
}

export const backlogList = defineCommand({
  name: 'backlog list',
  description: 'List repository backlog items, open by default.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    withRepoRoot(cli.command('backlog-list', 'List repository backlog items'))
      .option('--status <status>', 'open (default), resolved, or all')
      .option('--round <round_id>', 'Only items attributed to this round')
      .action((options: ListOptions) => {
        try {
          const status = oneOf(single(options.status), STATUSES, 'BACKLOG_STATUS_INVALID');
          const round = single(options.round);
          if (round !== undefined && !ROUND_PATTERN.test(round)) {
            throw new BacklogUsageError('BACKLOG_ROUND_INVALID');
          }
          const items = listBacklogItems({
            repoRoot: root(options),
            ...(status === undefined ? {} : { status }),
            ...(round === undefined ? {} : { roundId: round }),
          });
          emit(
            { schemaVersion: '1.0.0', items },
            options.human === true,
            [
              `backlog list: ${String(items.length)} item(s)`,
              ...items.map((item) => `  ${item.id} [${item.status}] ${item.kind}: ${item.title}`),
            ].join('\n'),
          );
        } catch (error) {
          failure('list', error);
        }
      });
  },
});

export const backlogShow = defineCommand({
  name: 'backlog show',
  description: 'Show one repository backlog item by id.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    withRepoRoot(cli.command('backlog-show <id>', 'Show one repository backlog item')).action(
      (id: unknown, options: BacklogOptions) => {
        try {
          const item = showBacklogItem({ repoRoot: root(options), id: requireId(id) });
          emit(item, options.human === true, `backlog show: ${item.id} [${item.status}]`);
        } catch (error) {
          failure('show', error);
        }
      },
    );
  },
});

interface ResolveOptions extends BacklogOptions {
  readonly resolution?: Value;
}

export const backlogResolve = defineCommand({
  name: 'backlog resolve',
  description: 'Resolve one repository backlog item with a resolution reference.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    withRepoRoot(cli.command('backlog-resolve <id>', 'Resolve one repository backlog item'))
      .option('--resolution <reference>', 'Commit, pull request, record, task, or item reference')
      .action((id: unknown, options: ResolveOptions) => {
        try {
          const itemId = requireId(id);
          const resolution = single(options.resolution);
          if (resolution === undefined || resolution.trim().length === 0) {
            throw new BacklogUsageError('BACKLOG_RESOLUTION_REQUIRED');
          }
          const item = resolveBacklogItem({ repoRoot: root(options), id: itemId, resolution });
          emit(item, options.human === true, `backlog resolve: ${item.id} -> ${resolution}`);
        } catch (error) {
          failure('resolve', error);
        }
      });
  },
});

/** Backlog handlers for central registration, in registry order. */
export const backlogCommands = [backlogAdd, backlogList, backlogResolve, backlogShow] as const;
