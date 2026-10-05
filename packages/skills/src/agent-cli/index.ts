import { spawn, type GuardedProcessResult } from '@devai-nyx/authority';

/*
 * Structural mirrors of the task-execution-evidence version-2 usage and cost
 * shapes (law/schemas/task-execution-evidence.schema.json, ADR-MDL-0005 D-7).
 */
export type AgentCliUsageCounter =
  | { readonly value: number; readonly status: 'reported' | 'derived' }
  | { readonly value: null; readonly status: 'missing' };

interface AgentCliUsageCounters {
  readonly usage_version: 2;
  readonly input_tokens: AgentCliUsageCounter;
  readonly output_tokens: AgentCliUsageCounter;
  readonly cache_read_tokens: AgentCliUsageCounter;
  readonly cache_write_tokens: AgentCliUsageCounter;
}

/** A cumulative-delta record must say how its delta was derived. */
export type AgentCliUsage = AgentCliUsageCounters &
  (
    | { readonly counter_mode: 'per-attempt'; readonly derivation?: string }
    | { readonly counter_mode: 'cumulative-delta'; readonly derivation: string }
  );

export type AgentCliCost =
  | { readonly amount: number; readonly currency: 'USD'; readonly source: 'provider-reported' }
  | { readonly amount: null; readonly currency: 'USD'; readonly source: 'unknown' };

/** Host CLI runtimes experimental execution admits (law/policy/experimental-execution.json). */
export type AgentCliRuntime = 'claude-cli' | 'codex-cli';

/** Codes the adapter throws: no attempt output exists to interpret. */
export type AgentCliErrorCode =
  | 'AGENT_CLI_SELECTION_INVALID'
  | 'AGENT_CLI_RUNTIME_UNSUPPORTED'
  /**
   * The provider started, but recording its start (journal `spawned`) failed. The
   * adapter stopped its whole process group before throwing; the provider may already
   * have changed its worktree, so the attempt is uncertain, never a refused spawn.
   */
  | 'AGENT_CLI_SPAWN_RECORD_FAILED';

/** Codes an interpreted attempt fails with (`AgentCliOutput.failure`). */
export type AgentCliFailureCode =
  /** No single explicit terminal event was emitted. */
  | 'AGENT_CLI_OUTPUT_INCOMPLETE'
  /** A stream line is not a JSON object, so events may be missing from the parse. */
  | 'AGENT_CLI_OUTPUT_MALFORMED'
  /** The retained stream lost its oldest bytes to the output bound. */
  | 'AGENT_CLI_OUTPUT_TRUNCATED'
  | 'AGENT_CLI_OUTPUT_AMBIGUOUS'
  | 'AGENT_CLI_REPORTED_FAILURE';

export class AgentCliError extends Error {
  /** The settled provider process, when one had started. */
  readonly process: GuardedProcessResult | undefined;

  constructor(
    readonly code: AgentCliErrorCode,
    options: { readonly cause?: unknown; readonly process?: GuardedProcessResult } = {},
  ) {
    super(code, 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'AgentCliError';
    this.process = options.process;
  }
}

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
    throw new AgentCliError('AGENT_CLI_SELECTION_INVALID');
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
        // Host user settings, hooks and MCP servers must not run inside a governed attempt.
        '--setting-sources',
        '',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--permission-mode',
        'acceptEdits',
        '--model',
        options.model,
        ...(options.effort === 'default' ? [] : ['--effort', options.effort]),
      ],
      requested_containment:
        'claude --permission-mode acceptEdits without host settings or MCP servers, the task worktree as cwd',
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
        // Host user configuration (hooks, MCP servers, profiles) must not run in an attempt.
        '--ignore-user-config',
        '--sandbox',
        'workspace-write',
        '--model',
        options.model,
        '--config',
        `model_reasoning_effort="${options.effort}"`,
        '-',
      ],
      requested_containment:
        'codex --sandbox workspace-write without host user configuration, the task worktree as cwd',
    };
  }
  throw new AgentCliError('AGENT_CLI_RUNTIME_UNSUPPORTED');
}

/**
 * Host variables a provider CLI needs and nothing more: executables on PATH, its own
 * stored login under HOME (claude reads the keychain item of USER), a shell for its
 * tools, a temporary directory, locale and terminal, and the proxy and CA settings that
 * reach its API. Every other host variable stays out of the attempt — GH_TOKEN, cloud
 * credentials, provider API keys, NODE_OPTIONS — so an allowlist, never a denylist.
 */
const AGENT_CLI_HOST_ENV: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'TERM',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
];

/** Locale categories: LC_ALL, LC_CTYPE, and the rest. */
const AGENT_CLI_HOST_ENV_PREFIX = 'LC_';

/** A relocated provider configuration home, where that provider's stored login lives. */
const AGENT_CLI_PROVIDER_ENV: Readonly<Record<AgentCliRuntime, readonly string[]>> = {
  'claude-cli': ['CLAUDE_CONFIG_DIR'],
  'codex-cli': ['CODEX_HOME'],
};

/**
 * The environment one attempt starts with: only the allowlisted variables present in
 * `host`. Host configuration is already kept out by argv (no setting sources and an
 * empty strict MCP configuration for claude, --ignore-user-config for codex).
 */
export function agentCliEnvironment(
  runtime: AgentCliRuntime,
  host: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!Object.hasOwn(AGENT_CLI_PROVIDER_ENV, runtime)) {
    throw new AgentCliError('AGENT_CLI_RUNTIME_UNSUPPORTED');
  }
  const names = new Set([...AGENT_CLI_HOST_ENV, ...AGENT_CLI_PROVIDER_ENV[runtime]]);
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(host)) {
    if (value === undefined) continue;
    if (names.has(name) || name.startsWith(AGENT_CLI_HOST_ENV_PREFIX)) environment[name] = value;
  }
  return environment;
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

function parseClaude(parsed: readonly Record<string, unknown>[]): AgentCliOutput {
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

function parseCodex(parsed: readonly Record<string, unknown>[]): AgentCliOutput {
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
              'codex --json turn.completed.usage of one ephemeral turn; cached_input_tokens is the cache read and cache_write_input_tokens the cache write',
            input_tokens: counter(usage?.['input_tokens']),
            output_tokens: counter(usage?.['output_tokens']),
            cache_read_tokens: counter(usage?.['cached_input_tokens']),
            cache_write_tokens: counter(usage?.['cache_write_input_tokens']),
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

/** What the process boundary knows about the retained stream. */
export interface AgentCliStreamFacts {
  /** The output bound dropped the oldest bytes (`GuardedProcessResult.stdout_truncated`). */
  readonly truncated?: boolean;
}

/**
 * Interpret one attempt's stdout. Unknown or malformed output is never a pass
 * (round-execution.json failure.unknown_or_malformed_output); only a single,
 * explicit successful terminal event in a stream read whole completes the attempt.
 * A truncated stream, or one with any line that is not a JSON object, may have lost
 * a failure or a second terminal event, so it never passes on the strength of its
 * tail. Its usage and cost are still read from the terminal event, since the
 * provider spent them either way.
 */
export function parseAgentCliOutput(
  runtime: AgentCliRuntime,
  stdout: string,
  stream: AgentCliStreamFacts = {},
): AgentCliOutput {
  const { parsed, malformed } = events(stdout);
  const output = runtime === 'claude-cli' ? parseClaude(parsed) : parseCodex(parsed);
  const damage: AgentCliFailureCode | null =
    stream.truncated === true
      ? 'AGENT_CLI_OUTPUT_TRUNCATED'
      : malformed > 0
        ? 'AGENT_CLI_OUTPUT_MALFORMED'
        : null;
  return damage === null ? output : { ...output, completed: false, failure: damage };
}

export interface AgentCliAttemptOptions {
  readonly invocation: Pick<AgentCliInvocation, 'runtime' | 'command' | 'args'>;
  /** The task worktree. */
  readonly cwd: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
  /**
   * Variables the caller sets explicitly for this attempt, such as a scripted
   * provider's settings, layered over the provider allowlist of `agentCliEnvironment`.
   * The host environment itself never reaches the provider unless a caller copies it here.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Called once the child has a pid, before it is awaited (journal `spawned`). If it
   * throws, the provider's process group is stopped and awaited, and the attempt
   * rejects with AGENT_CLI_SPAWN_RECORD_FAILED.
   */
  readonly onSpawned?: (pid: number) => void;
}

export interface AgentCliAttempt {
  readonly process: GuardedProcessResult;
  readonly output: AgentCliOutput;
  /**
   * Completed output from a process that exited 0 without timing out. A stream that
   * outgrew the retained bound or carries a malformed line never completes.
   */
  readonly ok: boolean;
}

const DEFAULT_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Run one attempt through the governed asynchronous process effect. */
export async function runAgentCliAttempt(
  options: AgentCliAttemptOptions,
): Promise<AgentCliAttempt> {
  const { runtime } = options.invocation;
  const child = spawn(options.invocation.command, options.invocation.args, {
    cwd: options.cwd,
    shell: false,
    timeout: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES,
    input: options.prompt,
    // Always explicit: the guarded spawn would otherwise hand over the whole host environment.
    env: { ...agentCliEnvironment(runtime), ...options.env },
  });
  if (child.pid !== undefined && options.onSpawned !== undefined) {
    try {
      options.onSpawned(child.pid);
    } catch (error) {
      // The provider runs but its start is unrecorded: it must not outlive this attempt
      // unsupervised, so its whole group is stopped and awaited before the failure surfaces.
      child.terminate();
      const settled = await child.result;
      throw new AgentCliError('AGENT_CLI_SPAWN_RECORD_FAILED', {
        cause: error,
        process: settled,
      });
    }
  }
  const process = await child.result;
  const output = parseAgentCliOutput(runtime, process.stdout, {
    truncated: process.stdout_truncated,
  });
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
