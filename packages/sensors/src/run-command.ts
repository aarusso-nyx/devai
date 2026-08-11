import { spawnSync } from '@devai-nyx/authority';

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit_code: number;
  readonly duration_ms: number;
  readonly killed: boolean;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
}

/** Synchronously run a command. Never throws — failures show up in exit_code/killed. */
export function runCommand(argv: readonly string[], opts: RunOptions = {}): RunResult {
  const [bin, ...args] = argv;
  if (bin === undefined) {
    return { stdout: '', stderr: 'empty command', exit_code: -1, duration_ms: 0, killed: false };
  }
  const start = Date.now();
  const result = spawnSync(bin, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    timeout: opts.timeoutMs,
    env: opts.env !== undefined ? { ...process.env, ...opts.env } : process.env,
    ...(opts.input !== undefined && { input: opts.input }),
  });
  const duration_ms = Date.now() - start;
  if (result.error !== undefined) {
    return {
      stdout: result.stdout ?? '',
      stderr: result.error.message,
      exit_code: 127,
      duration_ms,
      killed: false,
    };
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exit_code: result.status ?? -1,
    duration_ms,
    killed: result.signal !== null && result.signal !== undefined,
  };
}
