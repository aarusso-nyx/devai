import { existsSync, execFileSync, readFileSync, spawn } from '@devai-nyx/authority';
import {
  buildTaskExecutionEvidence,
  persistTaskExecutionEvidence,
  type DigestBinding,
  type TaskRecordBinding,
  type TaskExecutionEvidence,
} from '@devai-nyx/evidence';
import {
  escalateTask,
  executeRoutineExecutor,
  listWorktrees,
  quarantineLocks,
  saveTask,
  taskLockTargets,
  type RoundTaskDispatchResult,
  type TaskRecord,
} from '@devai-nyx/loop';
import { canonicalSha256 } from '@devai-nyx/utils';
import { trackGovernanceEvent } from '@devai-nyx/loop';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

function taskExecutionRoot(repoRoot: string, task: TaskRecord): string {
  if (task.worktree_id === undefined) return repoRoot;
  const worktree = listWorktrees({ repoRoot }).find(
    (candidate) => candidate.id === task.worktree_id && candidate.task_id === task.id,
  );
  if (worktree === undefined) throw new Error('TASK_WORKTREE_REGISTRY_MISMATCH');
  const managedRoot = resolve(repoRoot, '.devai/worktrees');
  const candidate = resolve(worktree.path);
  const relativePath = relative(managedRoot, candidate);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('TASK_WORKTREE_PATH_ESCAPE');
  }
  return candidate;
}

function candidateSha(repoRoot: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Exact tree of HEAD. A commit SHA is not a tree SHA and must never stand in for one. */
function candidateTree(repoRoot: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
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

/** Retained bytes per routine output stream, matching the former spawnSync buffer (1 MiB). */
const ROUTINE_OUTPUT_BYTES = 1024 * 1024;

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
  const executionRoot = taskExecutionRoot(repoRoot, running);
  const startedAt = new Date().toISOString();
  let timedOut = false;
  let terminationUnconfirmed = false;
  /** The leader of a process group that may outlive the dispatch. */
  let livePid: number | null | undefined;
  const result = await executeRoutineExecutor({
    executor,
    authority: {
      discipline: running.discipline,
      write: executor.effects.some((effect) => effect !== 'read'),
      allow_publish: false,
      capabilities: [],
    },
    runArgv: async (argv, options) => {
      // Asynchronous so concurrent round workers overlap (ADR-MDL-0005 D-10).
      const child = spawn(argv[0] ?? '', argv.slice(1), {
        cwd: resolve(executionRoot, options.cwd),
        shell: false,
        timeout: options.timeout,
        maxOutputBytes: ROUTINE_OUTPUT_BYTES,
      });
      const executed = await child.result;
      if (executed.termination_error !== undefined) livePid ??= child.pid ?? null;
      // A routine that outlives its deadline fails even if it then exits 0 (for example
      // by trapping SIGTERM): its exit status no longer describes a bounded run. One whose
      // process group could not be confirmed gone may even still be running.
      timedOut ||= executed.timed_out;
      terminationUnconfirmed ||= executed.termination_error !== undefined;
      return {
        exit_code:
          executed.timed_out || executed.termination_error !== undefined
            ? null
            : executed.exit_code,
        stdout: executed.stdout,
        stderr: executed.stderr,
      };
    },
  });
  const completedAt = new Date().toISOString();
  const id = evidenceId(running, startedAt, completedAt);
  if (terminationUnconfirmed) {
    // The group may still be running and using the task's resources. Record that durably
    // before any fallible work (candidate resolution, evidence): whatever fails after this,
    // no escalation or reconciliation can release the task's locks. They stay held until
    // their TTL lapses, or a human removes the quarantine record.
    quarantineLocks({
      locksDir: join(repoRoot, '.devai/state/locks'),
      quarantine: {
        task_id: running.id,
        round_id: running.round_id,
        reason: 'PROCESS_GROUP_TERMINATION_UNCONFIRMED',
        pid: livePid ?? null,
        evidence_id: id,
        targets: taskLockTargets(running),
        recorded_at: completedAt,
      },
    });
  }
  const candidate = candidateSha(executionRoot);
  const tree = candidateTree(executionRoot);
  // An unconfirmed termination outranks the timeout that caused it: the routine may still run.
  const processFailure = terminationUnconfirmed
    ? {
        code: 'PROCESS_GROUP_TERMINATION_UNCONFIRMED',
        message:
          'routine was terminated but its process group could not be confirmed gone; it may still be running, so its resource locks are kept until they expire',
      }
    : timedOut
      ? {
          code: 'TASK_ROUTINE_TIMED_OUT',
          message: `routine exceeded its ${String(executor.timeout_ms)} ms deadline and was terminated`,
        }
      : undefined;
  const succeeded = result.ok && processFailure === undefined;
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
    input_digests: digestPaths(executionRoot, executor.inputs),
    output_digests: digestPaths(executionRoot, executor.outputs),
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
        ...(processFailure ?? {
          code: result.ok ? 'TASK_ROUTINE_EXIT_NONZERO' : result.code,
          message: result.ok ? 'literal argv failed without an adapter diagnostic' : result.message,
        }),
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
  // The verification receipt is the one place a candidate tree is known, so it
  // is where a governance event can carry an exact commit binding.
  trackGovernanceEvent({
    repoRoot,
    round: running.round_id,
    role: 'engineer',
    kind: 'verification_result',
    status: succeeded ? 'pass' : 'fail',
    taskId: running.id,
    summary: succeeded
      ? `Routine executor verified task ${running.id}.`
      : `Routine executor failed task ${running.id}: ${String(evidence.failure?.code)}`,
    payload: evidence,
    evidenceRefs: [id],
    commitBinding: {
      base_commit: candidate,
      base_tree: tree,
      candidate_commit: candidate,
      candidate_tree: tree,
    },
    checkpoint: true,
  });
  if (succeeded) {
    saveTask(repoRoot, { ...running, status: 'pre_merge' });
    saveTask(repoRoot, { ...running, status: 'merging' });
  } else {
    // A quarantined task's escalation releases none of its locks.
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
