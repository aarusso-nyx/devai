// ADR-MDL-0005 D-10: a routine whose process group cannot be confirmed gone after its
// deadline is a failed run with its own code, never a timed-out success. The governed
// spawn is replaced by one whose settled result carries that report.
import type { GuardedChildProcess, GuardedProcessResult } from '@devai-nyx/authority';
import { runWithAuthorityHostEffects, type AuthorityHostEffectScope } from '@devai-nyx/authority';
import {
  acquireLocks,
  listLocks,
  loadTask,
  releaseLocks,
  runRoundTasks,
  type TaskRecord,
} from '@devai-nyx/loop';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createIssuer,
  runtimeApi,
} from '../../../authority/tests/unit/authority-runtime-testkit.js';
import { dispatchRoundTask } from '../../src/commands/round/dispatch.js';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawn,
}));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-round-dispatch-termination-'));
  roots.push(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  writeFileSync(join(root, 'input.txt'), 'managed input\n');
  execFileSync('git', ['add', 'input.txt'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=DEVAI Test',
      '-c',
      'user.email=devai-test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
    { cwd: root },
  );
  return root;
}

const TASK: TaskRecord = {
  schemaVersion: '2.0.0',
  id: 'TASK-9711',
  round_id: 'R-9711',
  status: 'queued',
  discipline: 'engineer',
  title: 'Routine whose termination cannot be confirmed',
  target_modules: [],
  target_substrates: ['F2'],
  created_at: '2026-10-05T00:00:00.000Z',
  db_isolation: 'database',
  iteration_count: 0,
  executor: {
    kind: 'routine',
    argv: [process.execPath, '-e', 'process.exit(0)'],
    cwd: '.',
    inputs: ['input.txt'],
    outputs: [],
    effects: ['read'],
    timeout_ms: 300,
    authority_checks: ['discipline'],
  },
};

async function permissive<T>(run: () => Promise<T>): Promise<T> {
  const issuer = createIssuer(await runtimeApi(), { invocation_id: 'routine-termination' });
  const scope: AuthorityHostEffectScope = {
    action_id: 'round run',
    invocation_id: 'routine-termination',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (_request, apply) => apply(),
  };
  try {
    return await runWithAuthorityHostEffects(scope, run);
  } finally {
    issuer.dispose();
  }
}

const unconfirmed: GuardedProcessResult = {
  exit_code: 0,
  signal: null,
  stdout: '',
  stderr: '',
  stdout_truncated: false,
  stderr_truncated: false,
  timed_out: true,
  spawn_error: null,
  termination_error: 'PROCESS_GROUP_TERMINATION_UNCONFIRMED',
};

describe('routine dispatch of a process group whose termination is unconfirmed', () => {
  it('fails the run with its own code even though the routine exited 0', async () => {
    const root = repository();
    const settled: GuardedProcessResult = unconfirmed;
    const child: GuardedChildProcess = {
      pid: 4343,
      result: Promise.resolve(settled),
      terminate: vi.fn(),
    };
    spawn.mockReturnValueOnce(child);

    const result = await permissive(() => dispatchRoundTask(root, TASK));

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, code: 'PROCESS_GROUP_TERMINATION_UNCONFIRMED' });
    const evidenceRoot = join(root, '.devai/state/round-runs/R-9711/task-executions');
    const [file] = readdirSync(evidenceRoot);
    expect(JSON.parse(readFileSync(join(evidenceRoot, file ?? ''), 'utf8'))).toMatchObject({
      verdict: 'error',
      failure: {
        code: 'PROCESS_GROUP_TERMINATION_UNCONFIRMED',
        rollback_disposition: 'preserved-for-repair',
      },
    });
    expect(
      JSON.parse(readFileSync(join(root, '.devai/state/tasks/TASK-9711.json'), 'utf8')),
    ).toMatchObject({ status: 'escalated' });
  });

  // #288: the escalation must not hand the task's resources to another task while the
  // group may still be running; the locks stay held and the condition is recorded.
  it('keeps the task locks quarantined and records the live process group', async () => {
    const root = repository();
    mkdirSync(join(root, 'work/rounds/R-9711'), { recursive: true });
    writeFileSync(join(root, 'work/rounds/R-9711/AUTHORIZATION.md'), 'status: active\nGRANTED\n');
    const value: TaskRecord = { ...TASK, status: 'ready', target_modules: ['MOD-routine'] };
    mkdirSync(join(root, '.devai/state/tasks'), { recursive: true });
    writeFileSync(
      join(root, '.devai/state/tasks/TASK-9711.json'),
      `${JSON.stringify(value, null, 2)}\n`,
    );
    spawn.mockClear();
    spawn.mockReturnValueOnce({
      pid: 4343,
      result: Promise.resolve({ ...unconfirmed, exit_code: 0 }),
      terminate: vi.fn(),
    } satisfies GuardedChildProcess);

    const result = await permissive(() =>
      runRoundTasks({
        repoRoot: root,
        round: 'R-9711',
        dispatch: (running) => dispatchRoundTask(root, running),
      }),
    );

    expect(result.results).toMatchObject([
      { task_id: 'TASK-9711', ok: false, code: 'PROCESS_GROUP_TERMINATION_UNCONFIRMED' },
    ]);
    const locksDir = join(root, '.devai/state/locks');
    expect(loadTask(root, 'TASK-9711').status).toBe('escalated');
    expect(listLocks({ locksDir })).toMatchObject([
      { task_id: 'TASK-9711', substrate: 'F2', module: 'MOD-routine' },
    ]);
    const evidenceRoot = join(root, '.devai/state/round-runs/R-9711/task-executions');
    const [evidenceFile = ''] = readdirSync(evidenceRoot);
    expect(
      JSON.parse(readFileSync(join(root, '.devai/state/lock-quarantine/TASK-9711.json'), 'utf8')),
    ).toMatchObject({
      task_id: 'TASK-9711',
      round_id: 'R-9711',
      reason: 'PROCESS_GROUP_TERMINATION_UNCONFIRMED',
      pid: 4343,
      evidence_id: evidenceFile.replace(/\.json$/u, ''),
      targets: ['F2:MOD-routine'],
    });
    // Another task cannot take the module while the group may live, nor can a later run's
    // reconciliation release it; the locks lapse only by their TTL.
    await permissive(async () => {
      expect(
        acquireLocks({ locksDir, taskId: 'TASK-9712', targets: ['F2:MOD-routine'] }).denied,
      ).toEqual([{ target: 'F2:MOD-routine', held_by: 'TASK-9711' }]);
      expect(releaseLocks({ locksDir, taskId: 'TASK-9711' })).toEqual([]);
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
