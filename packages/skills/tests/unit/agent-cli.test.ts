// ADR-MDL-0005 D-3, D-7, D-10 and IA-005: claude-cli and codex-cli attempt adapters, run
// against a fake provider through the governed asynchronous process effect. No live call.
import { runWithAuthorityHostEffects, type AuthorityHostEffectScope } from '@devai-nyx/authority';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createIssuer,
  runtimeApi,
} from '../../../authority/tests/unit/authority-runtime-testkit.js';
import {
  agentCliInvocation,
  parseAgentCliOutput,
  runAgentCliAttempt,
  type AgentCliRuntime,
} from '../../src/agent-cli/index.js';

const FAKE = join(import.meta.dirname, '..', 'fixtures', 'fake-agent-cli.mjs');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function worktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'devai-agent-cli-'));
  dirs.push(dir);
  return dir;
}

async function attempt(runtime: AgentCliRuntime, scenario: string, timeoutMs = 10_000) {
  const cwd = worktree();
  const issuer = createIssuer(await runtimeApi(), { invocation_id: 'agent-cli' });
  const apply_effect = vi.fn((_request: unknown, apply: () => unknown) => apply());
  const scope: AuthorityHostEffectScope = {
    action_id: 'round dispatch',
    invocation_id: 'agent-cli',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect,
  };
  const spawned: number[] = [];
  try {
    const result = await runWithAuthorityHostEffects(scope, () =>
      runAgentCliAttempt({
        invocation: { runtime, command: process.execPath, args: [FAKE] },
        cwd,
        prompt: 'COMPOSED PROMPT BYTES',
        timeoutMs,
        env: { ...process.env, FAKE_AGENT_SCENARIO: scenario },
        onSpawned: (pid) => spawned.push(pid),
      }),
    );
    return { result, cwd, apply_effect, spawned };
  } finally {
    issuer.dispose();
  }
}

describe('agent CLI invocation', () => {
  it('builds exact, session-less argv that never carries the prompt', () => {
    expect(
      agentCliInvocation({ runtime: 'claude-cli', model: 'claude-opus-5-5', effort: 'high' }),
    ).toEqual({
      runtime: 'claude-cli',
      command: 'claude',
      args: [
        '--print',
        '--verbose',
        '--output-format',
        'stream-json',
        '--no-session-persistence',
        '--permission-mode',
        'acceptEdits',
        '--model',
        'claude-opus-5-5',
        '--effort',
        'high',
      ],
      requested_containment: expect.stringContaining('acceptEdits'),
    });
    expect(
      agentCliInvocation({ runtime: 'claude-cli', model: 'm', effort: 'default' }).args,
    ).not.toContain('--effort');
    const codex = agentCliInvocation({ runtime: 'codex-cli', model: 'gpt-x', effort: 'high' });
    expect(codex.command).toBe('codex');
    expect(codex.args).toEqual(
      expect.arrayContaining([
        'exec',
        '--json',
        '--ephemeral',
        '--sandbox',
        'workspace-write',
        '-',
      ]),
    );
    expect(codex.args).toContain('model_reasoning_effort="high"');
    expect(() =>
      agentCliInvocation({ runtime: 'other' as AgentCliRuntime, model: 'm', effort: 'e' }),
    ).toThrow('AGENT_CLI_RUNTIME_UNSUPPORTED');
  });
});

describe('agent CLI attempts against a fake provider', () => {
  it('runs a claude attempt through the governed spawn and reports per-attempt usage and cost', async () => {
    const { result, cwd, apply_effect, spawned } = await attempt('claude-cli', 'claude-success');
    expect(apply_effect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'process', symbol: 'spawn' }),
      expect.any(Function),
    );
    expect(spawned).toHaveLength(1);
    expect(readFileSync(join(cwd, 'fake-agent-prompt.txt'), 'utf8')).toBe('COMPOSED PROMPT BYTES');
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      completed: true,
      final_text: 'Added the test.',
      cost: { amount: 0.42, currency: 'USD', source: 'provider-reported' },
      usage: {
        usage_version: 2,
        counter_mode: 'per-attempt',
        input_tokens: { value: 1200, status: 'reported' },
        output_tokens: { value: 300, status: 'reported' },
        cache_read_tokens: { value: 5000, status: 'reported' },
        cache_write_tokens: { value: 800, status: 'reported' },
      },
    });
  });

  it('runs a codex attempt and leaves the counters it never reports missing', async () => {
    const { result } = await attempt('codex-cli', 'codex-success');
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      final_text: 'Done.',
      cost: { amount: null, source: 'unknown' },
      usage: {
        input_tokens: { value: 900, status: 'reported' },
        cache_read_tokens: { value: 4000, status: 'reported' },
        cache_write_tokens: { value: null, status: 'missing' },
      },
    });
  });

  it('never records a missing counter or cost as zero (IA-005)', async () => {
    const { result } = await attempt('claude-cli', 'claude-missing-usage');
    expect(result.output.usage).toMatchObject({
      input_tokens: { value: null, status: 'missing' },
      output_tokens: { value: 10, status: 'reported' },
      cache_read_tokens: { value: null, status: 'missing' },
      cache_write_tokens: { value: null, status: 'missing' },
    });
    expect(result.output.cost).toEqual({ amount: null, currency: 'USD', source: 'unknown' });
  });

  it.each([
    ['claude-cli', 'claude-error', 'AGENT_CLI_REPORTED_FAILURE'],
    ['claude-cli', 'claude-twice', 'AGENT_CLI_OUTPUT_AMBIGUOUS'],
    ['codex-cli', 'codex-failed', 'AGENT_CLI_REPORTED_FAILURE'],
    ['claude-cli', 'malformed', 'AGENT_CLI_OUTPUT_INCOMPLETE'],
    ['codex-cli', 'malformed', 'AGENT_CLI_OUTPUT_INCOMPLETE'],
  ] as const)('never passes %s output from %s', async (runtime, scenario, failure) => {
    const { result } = await attempt(runtime, scenario);
    expect(result.ok).toBe(false);
    expect(result.output.completed).toBe(false);
    expect(result.output.failure).toBe(failure);
  });

  it('stops a hung provider at the attempt wall clock', async () => {
    const { result } = await attempt('claude-cli', 'hang', 300);
    expect(result.ok).toBe(false);
    expect(result.process.timed_out).toBe(true);
    expect(result.output.failure).toBe('AGENT_CLI_OUTPUT_INCOMPLETE');
  });

  it('leaves provider writes in the task worktree for the containment check', async () => {
    const { result, cwd } = await attempt('claude-cli', 'claude-writes');
    expect(result.ok).toBe(true);
    expect(existsSync(join(cwd, 'agent-output.txt'))).toBe(true);
  });

  it('parses stdout without a process for offline replay', () => {
    expect(parseAgentCliOutput('codex-cli', '').failure).toBe('AGENT_CLI_OUTPUT_INCOMPLETE');
  });
});
