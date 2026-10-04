import { spawn, type GuardedProcessResult } from '@devai-nyx/authority';

/*
 * Structural mirrors of the task-execution-evidence version-2 usage and cost
 * shapes (law/schemas/task-execution-evidence.schema.json, ADR-MDL-0005 D-7).
 */
export type AgentCliUsageCounter =
  | { readonly value: number; readonly status: 'reported' | 'derived' }
  | { readonly value: null; readonly status: 'missing' };

export interface AgentCliUsage {
  readonly usage_version: 2;
  readonly counter_mode: 'per-attempt' | 'cumulative-delta';
  readonly derivation?: string;
  readonly input_tokens: AgentCliUsageCounter;
  readonly output_tokens: AgentCliUsageCounter;
  readonly cache_read_tokens: AgentCliUsageCounter;
  readonly cache_write_tokens: AgentCliUsageCounter;
}

export type AgentCliCost =
  | { readonly amount: number; readonly currency: 'USD'; readonly source: 'provider-reported' }
  | { readonly amount: null; readonly currency: 'USD'; readonly source: 'unknown' };

/** Host CLI runtimes experimental execution admits (law/policy/experimental-execution.json). */
export type AgentCliRuntime = 'claude-cli' | 'codex-cli';

export interface AgentCliInvocation {
  readonly runtime: AgentCliRuntime;
  readonly command: string;
  readonly args: readonly string[];
  /** The containment the provider is asked for. It is recorded as requested, never verified. */
  readonly requested_containment: string;
}

export interface AgentCliInvocationOptions {
  readonly runtime: AgentCliRuntime;
  readonly model: string;
  readonly effort: string;
}

/**
 * The exact argv for one non-interactive, session-less attempt. The prompt is
 * written to stdin, never placed on the command line. The task worktree is the
 * working directory; nothing here grants network, push, or publish rights.
 */
export function agentCliInvocation(options: AgentCliInvocationOptions): AgentCliInvocation {
  if (options.model.length === 0 || options.effort.length === 0) {
    throw new Error('AGENT_CLI_SELECTION_INVALID');
  }
  if (options.runtime === 'claude-cli') {
    return {
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
        options.model,
        ...(options.effort === 'default' ? [] : ['--effort', options.effort]),
      ],
      requested_containment: 'claude --permission-mode acceptEdits with the task worktree as cwd',
    };
  }
  if (options.runtime === 'codex-cli') {
    return {
      runtime: 'codex-cli',
      command: 'codex',
      args: [
        'exec',
        '--json',
        '--ephemeral',
        '--sandbox',
        'workspace-write',
        '--model',
        options.model,
        '--config',
        `model_reasoning_effort="${options.effort}"`,
        '-',
      ],
      requested_containment: 'codex --sandbox workspace-write with the task worktree as cwd',
    };
  }
  throw new Error('AGENT_CLI_RUNTIME_UNSUPPORTED');
}

export interface AgentCliOutput {
  /** True only for an explicit, well-formed successful terminal event. */
  readonly completed: boolean;
  readonly final_text: string | null;
  readonly usage: AgentCliUsage;
  readonly cost: AgentCliCost;
  /** Why the output is not a completion, when it is not. */
  readonly failure: string | null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function events(stdout: string): { parsed: Record<string, unknown>[]; malformed: number } {
  const parsed: Record<string, unknown>[] = [];
  let malformed = 0;
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (text.length === 0) continue;
    try {
      const value = record(JSON.parse(text));
      if (value === undefined) malformed += 1;
      else parsed.push(value);
    } catch {
      malformed += 1;
    }
  }
  return { parsed, malformed };
}

/** A provider counter: a non-negative integer is reported; anything else is missing, never 0. */
function counter(value: unknown): AgentCliUsageCounter {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? { value, status: 'reported' }
    : { value: null, status: 'missing' };
}

const MISSING: AgentCliUsageCounter = { value: null, status: 'missing' };
const UNKNOWN_COST: AgentCliCost = { amount: null, currency: 'USD', source: 'unknown' };

function noUsage(derivation: string): AgentCliUsage {
  return {
    usage_version: 2,
    counter_mode: 'per-attempt',
    derivation,
    input_tokens: MISSING,
    output_tokens: MISSING,
    cache_read_tokens: MISSING,
    cache_write_tokens: MISSING,
  };
}

function parseClaude(stdout: string): AgentCliOutput {
  const { parsed } = events(stdout);
  const results = parsed.filter((event) => event['type'] === 'result');
  const terminal = results.at(-1);
  if (terminal === undefined) {
    return {
      completed: false,
      final_text: null,
      usage: noUsage('no claude result event was emitted'),
      cost: UNKNOWN_COST,
      failure: 'AGENT_CLI_OUTPUT_INCOMPLETE',
    };
  }
  const usage = record(terminal['usage']);
  const cost = terminal['total_cost_usd'];
  const completed =
    results.length === 1 && terminal['subtype'] === 'success' && terminal['is_error'] === false;
  return {
    completed,
    final_text: typeof terminal['result'] === 'string' ? terminal['result'] : null,
    usage: {
      usage_version: 2,
      counter_mode: 'per-attempt',
      derivation: 'claude stream-json result.usage for this session-less attempt',
      input_tokens: counter(usage?.['input_tokens']),
      output_tokens: counter(usage?.['output_tokens']),
      cache_read_tokens: counter(usage?.['cache_read_input_tokens']),
      cache_write_tokens: counter(usage?.['cache_creation_input_tokens']),
    },
    cost:
      typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
        ? { amount: cost, currency: 'USD', source: 'provider-reported' }
        : UNKNOWN_COST,
    failure: completed
      ? null
      : results.length > 1
        ? 'AGENT_CLI_OUTPUT_AMBIGUOUS'
        : 'AGENT_CLI_REPORTED_FAILURE',
  };
}

function parseCodex(stdout: string): AgentCliOutput {
  const { parsed } = events(stdout);
  const turns = parsed.filter((event) => event['type'] === 'turn.completed');
  const failed = parsed.some(
    (event) => event['type'] === 'turn.failed' || event['type'] === 'error',
  );
  const messages = parsed
    .filter((event) => event['type'] === 'item.completed')
    .map((event) => record(event['item']))
    .filter((item) => item?.['type'] === 'agent_message');
  const last = messages.at(-1);
  const turn = turns.at(-1);
  const usage = record(turn?.['usage']);
  const completed = turns.length === 1 && !failed;
  return {
    completed,
    final_text: typeof last?.['text'] === 'string' ? last['text'] : null,
    usage:
      turn === undefined
        ? noUsage('no codex turn.completed event was emitted')
        : {
            usage_version: 2,
            counter_mode: 'per-attempt',
            derivation:
              'codex --json turn.completed.usage of one ephemeral turn; cached_input_tokens is the cache read; codex reports no cache write',
            input_tokens: counter(usage?.['input_tokens']),
            output_tokens: counter(usage?.['output_tokens']),
            cache_read_tokens: counter(usage?.['cached_input_tokens']),
            cache_write_tokens: MISSING,
          },
    // Codex reports no cost; it is unknown, never 0.
    cost: UNKNOWN_COST,
    failure: completed
      ? null
      : failed
        ? 'AGENT_CLI_REPORTED_FAILURE'
        : turns.length > 1
          ? 'AGENT_CLI_OUTPUT_AMBIGUOUS'
          : 'AGENT_CLI_OUTPUT_INCOMPLETE',
  };
}

/**
 * Interpret one attempt's stdout. Unknown or malformed output is never a pass
 * (round-execution.json failure.unknown_or_malformed_output); only a single,
 * explicit successful terminal event completes the attempt.
 */
export function parseAgentCliOutput(runtime: AgentCliRuntime, stdout: string): AgentCliOutput {
  return runtime === 'claude-cli' ? parseClaude(stdout) : parseCodex(stdout);
}

export interface AgentCliAttemptOptions {
  readonly invocation: Pick<AgentCliInvocation, 'runtime' | 'command' | 'args'>;
  /** The task worktree. */
  readonly cwd: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Called once the child has a pid, before it is awaited (journal `spawned`). */
  readonly onSpawned?: (pid: number) => void;
}

export interface AgentCliAttempt {
  readonly process: GuardedProcessResult;
  readonly output: AgentCliOutput;
  /**
   * Completed output from a process that exited 0 without timing out. Truncation
   * keeps the newest bytes, so the terminal event survives a long stream.
   */
  readonly ok: boolean;
}

const DEFAULT_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Run one attempt through the governed asynchronous process effect. */
export async function runAgentCliAttempt(
  options: AgentCliAttemptOptions,
): Promise<AgentCliAttempt> {
  const child = spawn(options.invocation.command, options.invocation.args, {
    cwd: options.cwd,
    shell: false,
    timeout: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES,
    input: options.prompt,
    ...(options.env !== undefined && { env: options.env }),
  });
  if (child.pid !== undefined) options.onSpawned?.(child.pid);
  const process = await child.result;
  const output = parseAgentCliOutput(options.invocation.runtime, process.stdout);
  return {
    process,
    output,
    ok:
      output.completed &&
      process.exit_code === 0 &&
      !process.timed_out &&
      process.spawn_error === null,
  };
}
