import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AuthorityHostEffectRequest } from '@devai-nyx/authority';

interface RoutineTaskRecord {
  readonly schemaVersion: '2.0.0';
  readonly id: string;
  readonly round_id: string;
  readonly status: string;
  readonly worktree_id?: string;
  readonly executor: {
    readonly kind: 'routine';
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly timeout_ms: number;
  };
}

interface WorktreeRecord {
  readonly id: string;
  readonly path: string;
  readonly task_id?: string;
}

export interface DeclaredRoundTaskProcess {
  readonly taskId: string;
  readonly cwd: string;
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function flagValues(argv: readonly string[], flag: string): readonly string[] {
  return argv.flatMap((value, index) =>
    value === flag && typeof argv[index + 1] === 'string' ? [argv[index + 1] as string] : [],
  );
}

function loadTasks(repoRoot: string): readonly RoutineTaskRecord[] {
  const tasksRoot = resolve(repoRoot, '.devai/state/tasks');
  if (!existsSync(tasksRoot)) return [];
  return readdirSync(tasksRoot)
    .filter((name) => /^TASK-[0-9]+\.json$/u.test(name))
    .flatMap((name) => {
      try {
        const value = JSON.parse(readFileSync(resolve(tasksRoot, name), 'utf8')) as unknown;
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
        const task = value as Partial<RoutineTaskRecord>;
        const executor = task.executor;
        if (
          task.schemaVersion !== '2.0.0' ||
          typeof task.id !== 'string' ||
          typeof task.round_id !== 'string' ||
          task.status !== 'in_progress' ||
          executor?.kind !== 'routine' ||
          !Array.isArray(executor.argv) ||
          executor.argv.length === 0 ||
          executor.argv.some((argument) => typeof argument !== 'string') ||
          typeof executor.cwd !== 'string' ||
          executor.cwd.length === 0 ||
          isAbsolute(executor.cwd) ||
          executor.cwd.split(/[\\/]/u).includes('..') ||
          !Number.isSafeInteger(executor.timeout_ms) ||
          Number(executor.timeout_ms) < 1
        ) {
          return [];
        }
        return [task as RoutineTaskRecord];
      } catch {
        return [];
      }
    });
}

function executionRoot(repoRoot: string, task: RoutineTaskRecord): string | undefined {
  if (task.worktree_id === undefined) return realpathSync(repoRoot);
  const registryPath = resolve(repoRoot, '.devai/state/worktrees.json');
  if (!existsSync(registryPath)) return undefined;
  try {
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
      readonly worktrees?: readonly WorktreeRecord[];
    };
    const record = registry.worktrees?.find(
      (candidate) => candidate.id === task.worktree_id && candidate.task_id === task.id,
    );
    if (record === undefined || !existsSync(record.path)) return undefined;
    const root = realpathSync(repoRoot);
    const managedRoot = realpathSync(resolve(root, '.devai/worktrees'));
    const candidate = realpathSync(record.path);
    return within(managedRoot, candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** Match only the exact process declared by the selected, in-progress round task. */
export function matchDeclaredRoundTaskProcess(
  repoRoot: string,
  invocationArgv: readonly string[],
  request: AuthorityHostEffectRequest,
): DeclaredRoundTaskProcess | undefined {
  if (request.kind !== 'process' || request.symbol !== 'spawnSync') return undefined;
  const roundId = flagValues(invocationArgv, '--round').at(-1);
  if (roundId === undefined || !/^R-[0-9]{4}$/u.test(roundId)) return undefined;
  const selectedTaskIds = flagValues(invocationArgv, '--task');
  if (selectedTaskIds.some((id) => !/^TASK-[0-9]+$/u.test(id))) return undefined;
  const executable = request.arguments[0];
  const argv = request.arguments[1];
  const rawOptions = request.arguments[2];
  if (
    typeof executable !== 'string' ||
    !Array.isArray(argv) ||
    argv.some((argument) => typeof argument !== 'string') ||
    rawOptions === null ||
    typeof rawOptions !== 'object' ||
    Array.isArray(rawOptions)
  ) {
    return undefined;
  }
  const options = rawOptions as Readonly<Record<string, unknown>>;
  if (
    options.shell !== false ||
    typeof options.cwd !== 'string' ||
    typeof options.timeout !== 'number'
  ) {
    return undefined;
  }
  const task = loadTasks(repoRoot).find((candidate) => {
    if (candidate.round_id !== roundId) return false;
    if (selectedTaskIds.length > 0 && !selectedTaskIds.includes(candidate.id)) return false;
    const declared = candidate.executor.argv;
    return (
      declared[0] === executable &&
      JSON.stringify(declared.slice(1)) === JSON.stringify(argv) &&
      candidate.executor.timeout_ms === options.timeout
    );
  });
  if (task === undefined) return undefined;
  const root = executionRoot(repoRoot, task);
  if (root === undefined || !existsSync(resolve(root, task.executor.cwd))) return undefined;
  const expectedCwd = realpathSync(resolve(root, task.executor.cwd));
  const actualCwd = existsSync(options.cwd) ? realpathSync(resolve(options.cwd)) : undefined;
  if (actualCwd === undefined || expectedCwd !== actualCwd) return undefined;
  return { taskId: task.id, cwd: actualCwd };
}
