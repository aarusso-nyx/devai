import { existsSync, execFileSync, readFileSync, spawnSync } from '@devai-nyx/authority';
import {
  buildTaskExecutionEvidence,
  persistTaskExecutionEvidence,
  type DigestBinding,
  type TaskRecordBinding,
  type TaskExecutionEvidence,
} from '@devai-nyx/evidence';
import {
  completeTask,
  escalateTask,
  executeRoutineExecutor,
  saveTask,
  type RoundTaskDispatchResult,
  type TaskRecord,
} from '@devai-nyx/loop';
import { canonicalSha256 } from '@devai-nyx/utils';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

function candidateSha(repoRoot: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function digestPaths(repoRoot: string, paths: readonly string[]): readonly DigestBinding[] {
  return paths.flatMap((path) => {
    const target = resolve(repoRoot, path);
    if (!existsSync(target)) return [];
    return [
      {
        id: path,
        digest_sha256: createHash('sha256').update(readFileSync(target)).digest('hex'),
      },
    ];
  });
}

function notApplicable(reason: string): Readonly<{ not_applicable_reason: string }> {
  return { not_applicable_reason: reason };
}

function evidenceId(task: TaskRecord, startedAt: string, completedAt: string): string {
  return `TXE-${canonicalSha256({ task, startedAt, completedAt }).slice(0, 16)}`;
}

async function dispatchRoutine(
  repoRoot: string,
  task: TaskRecord,
): Promise<RoundTaskDispatchResult> {
  if (task.executor.kind !== 'routine') return { ok: false, code: 'TASK_ROUTINE_REQUIRED' };
  const executor = task.executor;
  if (executor.action_id !== undefined) {
    return { ok: false, code: 'TASK_ROUTINE_ACTION_DISPATCH_UNBOUND' };
  }
  const running: TaskRecord = {
    ...task,
    status: 'in_progress',
    spawned_at: new Date().toISOString(),
  };
  saveTask(repoRoot, running);
  const startedAt = new Date().toISOString();
  const result = await executeRoutineExecutor({
    executor,
    authority: {
      discipline: running.discipline,
      write: executor.effects.some((effect) => effect !== 'read'),
      allow_publish: false,
      capabilities: [],
    },
    runArgv: (argv, options) => {
      const executed = spawnSync(argv[0] ?? '', argv.slice(1), {
        cwd: resolve(repoRoot, options.cwd),
        shell: false,
        timeout: options.timeout,
        encoding: 'utf8',
      });
      return {
        exit_code: executed.status,
        stdout: executed.stdout,
        stderr: executed.stderr,
      };
    },
  });
  const completedAt = new Date().toISOString();
  const candidate = candidateSha(repoRoot);
  const id = evidenceId(running, startedAt, completedAt);
  const succeeded = result.ok;
  const resolvedArgv = result.ok ? (result.resolved.argv ?? []) : (executor.argv ?? []);
  const evidenceTask = running as unknown as TaskRecordBinding;
  const evidence: TaskExecutionEvidence = buildTaskExecutionEvidence(evidenceTask, {
    id,
    candidate_sha: candidate,
    resolved_executor: {
      kind: 'routine',
      action_id: null,
      argv: resolvedArgv,
      cwd: executor.cwd,
      effects: executor.effects,
    },
    adapter_versions: [{ id: '@devai-nyx/loop:routine-executor', version: '1.0.0' }],
    tool_versions: [],
    input_digests: digestPaths(repoRoot, executor.inputs),
    output_digests: digestPaths(repoRoot, executor.outputs),
    selection: {
      mode: 'not-applicable',
      considered_registry_ids: [],
      selected_registry_id: null,
      rejection_codes: [],
      fallback: false,
      fallback_reason: null,
    },
    prompt: notApplicable('routine executor has no provider prompt'),
    usage: notApplicable('routine executor has no provider usage'),
    cost: notApplicable('routine executor has no provider cost'),
    started_at: startedAt,
    completed_at: completedAt,
    verdict: succeeded ? 'pass' : 'error',
    ...(!succeeded && {
      failure: {
        code: result.ok ? 'TASK_ROUTINE_EXIT_NONZERO' : result.code,
        message: result.ok ? 'literal argv failed without an adapter diagnostic' : result.message,
        rollback_disposition: 'preserved-for-repair' as const,
      },
    }),
    evidence_refs: [],
  });
  persistTaskExecutionEvidence({
    repoRoot,
    relativePath: join(
      '.devai/state/round-runs',
      running.round_id,
      'task-executions',
      `${id}.json`,
    ),
    task: evidenceTask,
    candidate_sha: candidate,
    evidence,
  });
  if (succeeded) {
    saveTask(repoRoot, { ...running, status: 'pre_merge' });
    saveTask(repoRoot, { ...running, status: 'merging' });
    completeTask({ repoRoot, taskId: running.id });
  } else {
    escalateTask({ repoRoot, taskId: running.id });
  }
  return { ok: succeeded, evidence_id: id, ...(!succeeded && { code: evidence.failure?.code }) };
}

/** Default CLI dispatcher: deterministic literal routines only; other adapters stay fail-closed. */
export async function dispatchRoundTask(
  repoRoot: string,
  task: TaskRecord,
): Promise<RoundTaskDispatchResult> {
  if (task.executor.kind === 'routine') return dispatchRoutine(repoRoot, task);
  if (task.executor.kind === 'human') {
    const running: TaskRecord = {
      ...task,
      status: 'in_progress',
      spawned_at: new Date().toISOString(),
    };
    saveTask(repoRoot, running);
    saveTask(repoRoot, { ...running, status: 'awaiting_human_review' });
    return { ok: false, code: 'TASK_HUMAN_COMPLETION_REQUIRED' };
  }
  return {
    ok: false,
    code:
      task.executor.kind === 'agent'
        ? 'TASK_AGENT_ADAPTER_UNBOUND'
        : 'TASK_COMPOSITE_DISPATCH_UNBOUND',
  };
}
