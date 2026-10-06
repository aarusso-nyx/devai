/**
 * Broker matching for experimental agent processes (ADR-MDL-0005 D-3, D-10). Under
 * `round dispatch` the only admitted provider process is the exact session-less argv of
 * the claude-cli or codex-cli adapter for an in-progress agent task of the selected round,
 * at its requested model or the one bumped tier, running inside that task's own attempt
 * worktree. Everything else is refused.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AuthorityHostEffectRequest } from '@devai-nyx/authority';
import {
  agentCliInvocation,
  agentCliSandboxArgv,
  type AgentCliInvocation,
  type AgentCliRuntime,
  type AgentCliSandbox,
} from '@devai-nyx/skills';
import { EXPERIMENTAL_TIER_ORDER } from './index.js';

export interface DeclaredExperimentalAgentProcess {
  readonly taskId: string;
  readonly cwd: string;
}

interface AgentTask {
  readonly id: string;
  readonly round_id: string;
  readonly status: string;
  readonly executor: {
    readonly kind: string;
    readonly runtime?: string;
    readonly model?: string;
    readonly effort?: string;
  };
}

function flagValues(argv: readonly string[], flag: string): readonly string[] {
  return argv.flatMap((value, index) =>
    value === flag && typeof argv[index + 1] === 'string' ? [argv[index + 1] as string] : [],
  );
}

function inProgressAgentTasks(repoRoot: string, roundId: string): readonly AgentTask[] {
  const tasksRoot = resolve(repoRoot, '.devai/state/tasks');
  if (!existsSync(tasksRoot)) return [];
  return readdirSync(tasksRoot)
    .filter((name) => /^TASK-[0-9]+\.json$/u.test(name))
    .flatMap((name) => {
      try {
        const task = JSON.parse(readFileSync(resolve(tasksRoot, name), 'utf8')) as AgentTask;
        return task.round_id === roundId &&
          task.status === 'in_progress' &&
          task.executor.kind === 'agent'
          ? [task]
          : [];
      } catch {
        return [];
      }
    });
}

/**
 * ADR-MDL-0008: the provider-enforced sandbox is asserted, not assumed. The spawned argv
 * must carry the runtime's whole confinement sequence, rooted at the spawn cwd, so a
 * change that dropped a confinement flag from the adapter could never be admitted even
 * if the exact-argv comparison were loosened.
 */
function carriesSandbox(argv: readonly unknown[], sandbox: AgentCliSandbox, cwd: string): boolean {
  const flags = agentCliSandboxArgv(sandbox, cwd);
  if (sandbox.enforced_by !== 'provider' || sandbox.write_root !== 'attempt-worktree') return false;
  return argv.some((_, start) => flags.every((flag, offset) => argv[start + offset] === flag));
}

function models(runtime: AgentCliRuntime, model: string): readonly string[] {
  const order = EXPERIMENTAL_TIER_ORDER[runtime];
  const next = order[order.indexOf(model) + 1];
  return order.includes(model) && next !== undefined ? [model, next] : [model];
}

/** Match only the exact adapter process of an admitted, in-progress agent task. */
export function matchExperimentalAgentProcess(
  repoRoot: string,
  invocationArgv: readonly string[],
  request: AuthorityHostEffectRequest,
): DeclaredExperimentalAgentProcess | undefined {
  if (request.kind !== 'process' || request.symbol !== 'spawn') return undefined;
  const roundId = flagValues(invocationArgv, '--round').at(-1);
  if (roundId === undefined || !/^R-[0-9]{4}$/u.test(roundId)) return undefined;
  const selected = flagValues(invocationArgv, '--task');
  const [executable, argv, rawOptions] = request.arguments;
  if (
    typeof executable !== 'string' ||
    !Array.isArray(argv) ||
    rawOptions === null ||
    typeof rawOptions !== 'object'
  ) {
    return undefined;
  }
  const options = rawOptions as Readonly<Record<string, unknown>>;
  if (options.shell !== false || typeof options.cwd !== 'string' || !existsSync(options.cwd)) {
    return undefined;
  }
  const spawnCwd = options.cwd;
  const cwd = realpathSync(spawnCwd);
  for (const task of inProgressAgentTasks(repoRoot, roundId)) {
    if (selected.length > 0 && !selected.includes(task.id)) continue;
    const { runtime, model, effort } = task.executor;
    if (
      (runtime !== 'claude-cli' && runtime !== 'codex-cli') ||
      typeof model !== 'string' ||
      typeof effort !== 'string'
    ) {
      continue;
    }
    const exact = models(runtime, model).some((candidate) => {
      let expected: AgentCliInvocation;
      try {
        expected = agentCliInvocation({
          runtime,
          model: candidate,
          effort,
          worktree: spawnCwd,
        });
      } catch {
        // A runtime that cannot be confined on this host is never admitted.
        return false;
      }
      return (
        expected.command === executable &&
        JSON.stringify(expected.args) === JSON.stringify(argv) &&
        carriesSandbox(argv as readonly unknown[], expected.sandbox, spawnCwd)
      );
    });
    if (!exact) continue;
    const managed = resolve(repoRoot, '.devai/worktrees');
    if (!existsSync(managed)) continue;
    const path = relative(realpathSync(managed), cwd);
    const attemptDir = path.split(sep)[0] ?? '';
    if (
      path.startsWith('..') ||
      isAbsolute(path) ||
      path.includes(sep) ||
      !new RegExp(`^WT-${task.id}-A[1-4]$`, 'u').test(attemptDir)
    ) {
      continue;
    }
    return { taskId: task.id, cwd };
  }
  return undefined;
}
