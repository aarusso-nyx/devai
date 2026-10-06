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
  AgentCliError,
  agentCliEnvironment,
  agentCliInvocation,
  parseAgentCliOutput,
  runAgentCliAttempt,
  type AgentCliAttemptOptions,
  type AgentCliRuntime,
} from '../../src/agent-cli/index.js';

const FAKE = join(import.meta.dirname, '..', 'fixtures', 'fake-agent-cli.mjs');
const dirs: string[] = [];
const started: number[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  vi.unstubAllEnvs();
});

function worktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'devai-agent-cli-'));
  dirs.push(dir);
  return dir;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function inScope<T>(run: () => Promise<T>) {
  const issuer = createIssuer(await runtimeApi(), { invocation_id: 'agent-cli' });
  const apply_effect = vi.fn((_request: unknown, apply: () => unknown) => apply());
  const scope: AuthorityHostEffectScope = {
    action_id: 'round dispatch',
    invocation_id: 'agent-cli',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect,
  };
  try {
    return { value: await runWithAuthorityHostEffects(scope, run), apply_effect };
  } finally {
    issuer.dispose();
  }
}

async function attempt(
  runtime: AgentCliRuntime,
  scenario: string,
  timeoutMs = 10_000,
  extra: Partial<AgentCliAttemptOptions> = {},
) {
  const cwd = worktree();
  const spawned: number[] = [];
  const { value: result, apply_effect } = await inScope(() =>
    runAgentCliAttempt({
      invocation: { runtime, command: process.execPath, args: [FAKE] },
      cwd,
      prompt: 'COMPOSED PROMPT BYTES',
      timeoutMs,
      // Only the fixture's own settings: the adapter supplies what a provider needs.
      env: {
        FAKE_AGENT_SCENARIO: scenario,
        FAKE_AGENT_PROMPT_FILE: 'fake-agent-prompt.txt',
      },
      onSpawned: (pid) => {
        started.push(pid);
        spawned.push(pid);
      },
      ...extra,
    }),
  );
  return { result, cwd, apply_effect, spawned };
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
        '--setting-sources',
        '',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
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
        '--ignore-user-config',
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
        input_tokens: { value: 1000, status: 'derived' },
        cache_read_tokens: { value: 4000, status: 'reported' },
        cache_write_tokens: { value: null, status: 'missing' },
      },
    });
  });

  it('counts codex cached input once: input_tokens already includes the cached tokens (#289)', async () => {
    const { result } = await attempt('codex-cli', 'codex-success');
    const usage = result.output.usage;
    // The provider reported 5000 input (4000 cached) and 200 output: 5200 tokens, not 9200.
    expect((usage.input_tokens.value ?? 0) + (usage.cache_read_tokens.value ?? 0)).toBe(5000);
    expect(usage.output_tokens.value).toBe(200);
  });

  it('leaves codex input missing when the cache count exceeds it, never inventing a figure', async () => {
    const { result } = await attempt('codex-cli', 'codex-cache-exceeds-input');
    expect(result.output.usage).toMatchObject({
      input_tokens: { value: null, status: 'missing' },
      cache_read_tokens: { value: 4000, status: 'reported' },
    });
  });

  it('keeps the reported codex input as it stands when no cache count is reported', async () => {
    const { result } = await attempt('codex-cli', 'codex-no-cache-count');
    expect(result.output.usage).toMatchObject({
      input_tokens: { value: 900, status: 'reported' },
      cache_read_tokens: { value: null, status: 'missing' },
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
    ['claude-cli', 'malformed', 'AGENT_CLI_OUTPUT_MALFORMED'],
    ['codex-cli', 'malformed', 'AGENT_CLI_OUTPUT_MALFORMED'],
    ['claude-cli', 'claude-noise', 'AGENT_CLI_OUTPUT_MALFORMED'],
  ] as const)('never passes %s output from %s', async (runtime, scenario, failure) => {
    const { result } = await attempt(runtime, scenario);
    expect(result.ok).toBe(false);
    expect(result.output.completed).toBe(false);
    expect(result.output.failure).toBe(failure);
  });

  it('refuses a damaged stream even beside a valid success event, keeping its usage', async () => {
    const { result } = await attempt('claude-cli', 'claude-noise');
    expect(result.process.exit_code).toBe(0);
    expect(result.output).toMatchObject({
      completed: false,
      failure: 'AGENT_CLI_OUTPUT_MALFORMED',
      // The provider spent these tokens whether or not its stream is trusted.
      usage: { input_tokens: { value: 1200, status: 'reported' } },
      cost: { amount: 0.42, source: 'provider-reported' },
    });
  });

  it('refuses a stream that outgrew the retained bound even when its tail succeeds', async () => {
    const { result } = await attempt('claude-cli', 'claude-long', 10_000, {
      maxOutputBytes: 1024,
    });
    expect(result.process.stdout_truncated).toBe(true);
    expect(result.process.stdout.trimEnd().split('\n').at(-1)).toContain('"subtype":"success"');
    expect(result.ok).toBe(false);
    expect(result.output.failure).toBe('AGENT_CLI_OUTPUT_TRUNCATED');
  });

  it('stops and awaits the provider when its spawn record fails, then refuses as uncertain', async () => {
    const cwd = worktree();
    const recorded: number[] = [];
    const journalFailure = new Error('JOURNAL_APPEND_FAILED');
    const startedAt = Date.now();
    const { value: outcome } = await inScope(() =>
      runAgentCliAttempt({
        invocation: { runtime: 'claude-cli', command: process.execPath, args: [FAKE, 'hang'] },
        cwd,
        prompt: 'COMPOSED PROMPT BYTES',
        timeoutMs: 60_000,
        onSpawned: (pid) => {
          started.push(pid);
          recorded.push(pid);
          throw journalFailure;
        },
      }).then(
        () => undefined,
        (error: unknown) => error,
      ),
    );
    expect(outcome).toBeInstanceOf(AgentCliError);
    const error = outcome as AgentCliError;
    expect(error.message).toBe('AGENT_CLI_SPAWN_RECORD_FAILED');
    expect(error.code).toBe('AGENT_CLI_SPAWN_RECORD_FAILED');
    expect(error.cause).toBe(journalFailure);
    expect(error.process).toMatchObject({ signal: 'SIGTERM', timed_out: false });
    // The provider is gone before the failure surfaces, long before its own wall clock.
    expect(recorded).toHaveLength(1);
    expect(alive(recorded[0] ?? 0)).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(30_000);
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
    const success = `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
      usage: { input_tokens: 1, output_tokens: 2 },
    })}\n`;
    expect(parseAgentCliOutput('claude-cli', success)).toMatchObject({
      completed: true,
      failure: null,
    });
    expect(parseAgentCliOutput('claude-cli', success, { truncated: true })).toMatchObject({
      completed: false,
      failure: 'AGENT_CLI_OUTPUT_TRUNCATED',
      usage: { input_tokens: { value: 1, status: 'reported' } },
    });
    expect(parseAgentCliOutput('claude-cli', `[]\n${success}`).failure).toBe(
      'AGENT_CLI_OUTPUT_MALFORMED',
    );
  });
});

describe('agent CLI environment', () => {
  const host = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/agent',
    USER: 'agent',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C.UTF-8',
    HTTPS_PROXY: 'http://proxy.invalid:3128',
    NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
    CLAUDE_CONFIG_DIR: '/home/agent/.claude-alt',
    CODEX_HOME: '/home/agent/.codex-alt',
    GH_TOKEN: 'sentinel-gh-token',
    GITHUB_TOKEN: 'sentinel-github-token',
    AWS_SECRET_ACCESS_KEY: 'sentinel-aws',
    ANTHROPIC_API_KEY: 'sentinel-anthropic',
    OPENAI_API_KEY: 'sentinel-openai',
    NODE_OPTIONS: '--require /tmp/inject.js',
    UNSET: undefined,
  };

  it('forwards only the provider allowlist from the host', () => {
    const shared = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/agent',
      USER: 'agent',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C.UTF-8',
      HTTPS_PROXY: 'http://proxy.invalid:3128',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
    };
    expect(agentCliEnvironment('claude-cli', host)).toEqual({
      ...shared,
      CLAUDE_CONFIG_DIR: '/home/agent/.claude-alt',
    });
    expect(agentCliEnvironment('codex-cli', host)).toEqual({
      ...shared,
      CODEX_HOME: '/home/agent/.codex-alt',
    });
    expect(() => agentCliEnvironment('other' as AgentCliRuntime, host)).toThrow(
      'AGENT_CLI_RUNTIME_UNSUPPORTED',
    );
  });

  it('never hands a host secret to the provider process', async () => {
    vi.stubEnv('DEVAI_SENTINEL_SECRET', 'sentinel-secret-value');
    vi.stubEnv('GH_TOKEN', 'sentinel-gh-token');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'sentinel-aws');
    vi.stubEnv('LC_DEVAI_PROBE', 'locale-probe');
    const cwd = worktree();
    const { value: result } = await inScope(() =>
      runAgentCliAttempt({
        invocation: {
          runtime: 'claude-cli',
          command: process.execPath,
          args: [FAKE, 'claude-env'],
        },
        cwd,
        prompt: 'COMPOSED PROMPT BYTES',
        timeoutMs: 10_000,
      }),
    );
    expect(result.ok).toBe(true);
    const seen = JSON.parse(readFileSync(join(cwd, 'fake-agent-env.json'), 'utf8')) as Record<
      string,
      string
    >;
    expect(seen).not.toHaveProperty('DEVAI_SENTINEL_SECRET');
    expect(seen).not.toHaveProperty('GH_TOKEN');
    expect(seen).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(JSON.stringify(seen)).not.toContain('sentinel');
    expect(seen['PATH']).toBe(process.env['PATH']);
    expect(seen['HOME']).toBe(process.env['HOME']);
    expect(seen['LC_DEVAI_PROBE']).toBe('locale-probe');
  });
});
