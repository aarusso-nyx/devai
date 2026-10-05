// ADR-MDL-0005 D-6 and D-10: a provider whose process group cannot be confirmed gone after
// termination is an error after spawn, so the engine keeps the attempt uncertain and its
// worktree; it is never an interpretable attempt. The governed spawn is replaced by one
// whose settled result carries that report, so no process starts.
import type { GuardedChildProcess, GuardedProcessResult } from '@devai-nyx/authority';
import { describe, expect, it, vi } from 'vitest';
import { AgentCliError, runAgentCliAttempt } from '../../src/agent-cli/index.js';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawn,
}));

/** A stream that would pass on its own: only the termination report may refuse it. */
const SUCCESS = `${JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Done.',
  usage: { input_tokens: 1, output_tokens: 2 },
})}\n`;

function settled(overrides: Partial<GuardedProcessResult> = {}): GuardedProcessResult {
  return {
    exit_code: 0,
    signal: null,
    stdout: SUCCESS,
    stderr: '',
    stdout_truncated: false,
    stderr_truncated: false,
    timed_out: false,
    spawn_error: null,
    ...overrides,
  };
}

const UNCONFIRMED = settled({
  exit_code: null,
  signal: 'SIGTERM',
  timed_out: true,
  termination_error: 'PROCESS_GROUP_TERMINATION_UNCONFIRMED',
});

function provider(result: GuardedProcessResult) {
  const terminate = vi.fn();
  const child: GuardedChildProcess = { pid: 4242, result: Promise.resolve(result), terminate };
  spawn.mockReturnValueOnce(child);
  return terminate;
}

const OPTIONS = {
  invocation: { runtime: 'claude-cli', command: 'claude', args: [] },
  cwd: '/nonexistent/attempt-worktree',
  prompt: 'COMPOSED PROMPT BYTES',
  timeoutMs: 1_000,
} as const;

function failure(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('agent CLI attempts whose provider termination is unconfirmed', () => {
  it('resolves the same stream normally once termination is confirmed', async () => {
    provider(settled());
    await expect(runAgentCliAttempt(OPTIONS)).resolves.toMatchObject({ ok: true });
  });

  it('rejects after the recorded start instead of interpreting the stream', async () => {
    provider(UNCONFIRMED);
    const recorded: number[] = [];
    const error = await failure(
      runAgentCliAttempt({ ...OPTIONS, onSpawned: (pid) => recorded.push(pid) }),
    );
    // The start was recorded first, so the engine reads the rejection as uncertain.
    expect(recorded).toEqual([4242]);
    expect(error).toBeInstanceOf(AgentCliError);
    expect(error).toMatchObject({
      code: 'PROCESS_GROUP_TERMINATION_UNCONFIRMED',
      message: 'PROCESS_GROUP_TERMINATION_UNCONFIRMED',
      process: UNCONFIRMED,
    });
  });

  it('keeps the spawn-record failure code and carries the unconfirmed termination', async () => {
    const terminate = provider(UNCONFIRMED);
    const error = await failure(
      runAgentCliAttempt({
        ...OPTIONS,
        onSpawned: () => {
          throw new Error('JOURNAL_APPEND_FAILED');
        },
      }),
    );
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({
      code: 'AGENT_CLI_SPAWN_RECORD_FAILED',
      process: { termination_error: 'PROCESS_GROUP_TERMINATION_UNCONFIRMED' },
    });
  });
});
