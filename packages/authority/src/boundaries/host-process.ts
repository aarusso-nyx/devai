import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { requireScope } from './host-operation.js';

/** Options for a governed asynchronous child process (ADR-MDL-0005 D-10). */
export interface GuardedSpawnOptions {
  /** Working directory; authorization binds it, as for `spawnSync`. */
  readonly cwd: string;
  /** Wall-clock limit in milliseconds. Required: an unbounded child is refused. */
  readonly timeout: number;
  /** Shell interpretation is never permitted. */
  readonly shell: false;
  /** Bytes of each stream retained in the result; the newest bytes are kept. */
  readonly maxOutputBytes: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. Without it stdin is closed at once. */
  readonly input?: string;
  /** Grace period between SIGTERM and SIGKILL when the child must stop. Default 5s. */
  readonly killGraceMs?: number;
  /** Streaming observers; they see every byte, independent of the retained bound. */
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
}

export interface GuardedProcessResult {
  readonly exit_code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdout_truncated: boolean;
  readonly stderr_truncated: boolean;
  readonly timed_out: boolean;
  /** Set when the process could not start (for example ENOENT). */
  readonly spawn_error: string | null;
}

export interface GuardedChildProcess {
  readonly pid: number | undefined;
  /** Settles once, when the child and its streams have closed; never rejects. */
  readonly result: Promise<GuardedProcessResult>;
  /** Stop the whole process group: SIGTERM, then SIGKILL after the grace period. */
  terminate(): void;
}

const DEFAULT_KILL_GRACE_MS = 5_000;

class BoundedTail {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit && this.chunks.length > 0) {
      const head = this.chunks[0] as Buffer;
      const excess = this.size - this.limit;
      this.truncated = true;
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size -= excess;
      }
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    // The child leads its own process group (detached), so this reaches its descendants.
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

function validate(command: string, args: readonly string[], options: GuardedSpawnOptions): void {
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('AUTHORITY_PROCESS_COMMAND_INVALID');
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new Error('AUTHORITY_PROCESS_COMMAND_INVALID');
  }
  if (options.shell !== false) throw new Error('AUTHORITY_PROCESS_SHELL_FORBIDDEN');
  if (!Number.isInteger(options.timeout) || options.timeout <= 0) {
    throw new Error('AUTHORITY_PROCESS_TIMEOUT_REQUIRED');
  }
  if (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0) {
    throw new Error('AUTHORITY_PROCESS_OUTPUT_BOUND_REQUIRED');
  }
}

function start(
  command: string,
  args: readonly string[],
  options: GuardedSpawnOptions,
): GuardedChildProcess {
  const child = Reflect.apply(nodeSpawn, undefined, [
    command,
    [...args],
    {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ]) as ChildProcess;
  const stdout = new BoundedTail(options.maxOutputBytes);
  const stderr = new BoundedTail(options.maxOutputBytes);
  const grace = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  let timedOut = false;
  let spawnError: string | null = null;
  let killTimer: NodeJS.Timeout | undefined;

  const terminate = (): void => {
    signalGroup(child, 'SIGTERM');
    if (killTimer === undefined) {
      killTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), grace);
      killTimer.unref();
    }
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.timeout);
  deadline.unref();

  child.stdout?.on('data', (chunk: Buffer) => {
    stdout.push(chunk);
    options.onStdout?.(chunk.toString('utf8'));
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(chunk);
    options.onStderr?.(chunk.toString('utf8'));
  });
  child.stdin?.on('error', () => {
    // A child that exits before reading its input closes the pipe; the exit is reported.
  });
  if (options.input !== undefined) child.stdin?.end(options.input);
  else child.stdin?.end();

  const result = new Promise<GuardedProcessResult>((resolve) => {
    let settled = false;
    const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve({
        exit_code: exitCode,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
        timed_out: timedOut,
        spawn_error: spawnError,
      });
    };
    child.on('error', (error: NodeJS.ErrnoException) => {
      spawnError = error.code ?? error.message;
      if (child.pid === undefined) settle(null, null);
    });
    child.on('close', (code, signal) => settle(code, signal));
  });

  return { pid: child.pid, result, terminate };
}

/**
 * Governed asynchronous process effect (ADR-MDL-0005 D-10). Authorization runs
 * synchronously through the active host scope before the child starts, exactly as
 * for `spawnSync`; the scope then survives awaiting `result`. The child leads its
 * own process group so a timeout or `terminate()` stops everything it started.
 */
export function spawn(
  command: string,
  args: readonly string[],
  options: GuardedSpawnOptions,
): GuardedChildProcess {
  validate(command, args, options);
  const scope = requireScope('process');
  return scope.apply_effect(
    { kind: 'process', symbol: 'spawn', arguments: [command, [...args], options] },
    () => start(command, args, options),
  ) as GuardedChildProcess;
}
