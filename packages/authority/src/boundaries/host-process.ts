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
  /**
   * How long after SIGKILL the process group may take to disappear before the termination
   * is reported unconfirmed (`termination_error`). Default 5s.
   */
  readonly killConfirmMs?: number;
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
  /**
   * Present only when a requested termination could not be confirmed: a member of the
   * process group was still alive `killConfirmMs` after SIGKILL, or the child or its
   * output streams had still not closed by then. Something it started may still run,
   * so its working directory must not be treated as quiescent or cleaned up.
   */
  readonly termination_error?: 'PROCESS_GROUP_TERMINATION_UNCONFIRMED';
}

export interface GuardedChildProcess {
  readonly pid: number | undefined;
  /**
   * Settles once, when the child and its streams have closed and, after a timeout or
   * `terminate()`, once its whole process group is gone or its termination is reported
   * unconfirmed; never rejects.
   */
  readonly result: Promise<GuardedProcessResult>;
  /**
   * Stop the whole process group: SIGTERM, then SIGKILL after the grace period to every
   * member still alive, including descendants that outlive the child. A no-op once the
   * result has settled.
   */
  terminate(): void;
}

const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_KILL_CONFIRM_MS = 5_000;
/** Interval between liveness probes of a terminated process group. */
const GROUP_POLL_MS = 20;
const TERMINATION_UNCONFIRMED = 'PROCESS_GROUP_TERMINATION_UNCONFIRMED';

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

/** Whether any member of the process group `pgid` is still alive. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    // EPERM: the group exists but may not be signalled; only ESRCH proves it is gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Wait for a terminated process group to disappear and report whether it did. The
 * leader closing proves nothing about its descendants: one that ignores SIGTERM keeps
 * the group alive, so SIGKILL goes to the group once `killDueAt` passes. The group id
 * stays reserved while any member lives, so it is never signalled again after it is
 * seen gone. A group still alive `confirmMs` after its SIGKILL (a member stuck in
 * uninterruptible I/O, or an unreaped zombie) is reported as not gone, never as
 * stopped. The probes keep the event loop alive, so an awaiting caller is not cut short.
 */
async function awaitGroupGone(
  pgid: number,
  killDueAt: number,
  confirmMs: number,
): Promise<boolean> {
  let killedAt: number | undefined;
  while (groupAlive(pgid)) {
    const now = Date.now();
    if (killedAt === undefined && now >= killDueAt) {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        // gone between the probe and the signal
      }
      killedAt = now;
    } else if (killedAt !== undefined && now - killedAt >= confirmMs) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
  }
  return true;
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
  // The termination bounds must be finite too, or a stuck group would be awaited forever.
  for (const bound of [options.killGraceMs, options.killConfirmMs]) {
    if (bound !== undefined && (!Number.isInteger(bound) || bound < 0)) {
      throw new Error('AUTHORITY_PROCESS_TIMEOUT_REQUIRED');
    }
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
  const confirm = options.killConfirmMs ?? DEFAULT_KILL_CONFIRM_MS;
  let timedOut = false;
  let spawnError: string | null = null;
  let killTimer: NodeJS.Timeout | undefined;
  let confirmTimer: NodeJS.Timeout | undefined;
  /** Set by the first termination request: when SIGKILL is due to the whole group. */
  let killDueAt: number | undefined;
  let terminationError: typeof TERMINATION_UNCONFIRMED | undefined;
  /** The child's own exit, which can precede the close of its output streams. */
  let exited: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined;
  let closed = false;
  let settled = false;
  let resolveResult: ((value: GuardedProcessResult) => void) | undefined;
  const result = new Promise<GuardedProcessResult>((resolve) => {
    resolveResult = resolve;
  });

  const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    clearTimeout(killTimer);
    clearTimeout(confirmTimer);
    resolveResult?.({
      exit_code: exitCode,
      signal,
      stdout: stdout.text(),
      stderr: stderr.text(),
      stdout_truncated: stdout.truncated,
      stderr_truncated: stderr.truncated,
      timed_out: timedOut,
      spawn_error: spawnError,
      ...(terminationError !== undefined && { termination_error: terminationError }),
    });
  };

  const terminate = (): void => {
    // After settlement its group is gone or reported unconfirmed: never signal its id again.
    if (settled) return;
    signalGroup(child, 'SIGTERM');
    if (killTimer !== undefined) return;
    killDueAt = Date.now() + grace;
    killTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), grace);
    killTimer.unref();
    // A child, or a process holding its output streams, that has still not closed when the
    // group should be gone cannot be confirmed stopped; once the child closes, the group
    // wait below decides instead.
    confirmTimer = setTimeout(() => {
      if (closed) return;
      terminationError = TERMINATION_UNCONFIRMED;
      settle(exited?.code ?? null, exited?.signal ?? null);
    }, grace + confirm);
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

  child.on('error', (error: NodeJS.ErrnoException) => {
    spawnError = error.code ?? error.message;
    if (child.pid === undefined) settle(null, null);
  });
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });
  child.on('close', (code, signal) => {
    closed = true;
    // The wall clock bounds the child itself; its exit ends that bound.
    clearTimeout(deadline);
    const pgid = child.pid;
    if (killDueAt === undefined || pgid === undefined) {
      settle(code, signal);
      return;
    }
    // Termination was requested: escalate until every member of the group is gone, and
    // never report a group that outlives the confirmation window as stopped.
    void awaitGroupGone(pgid, killDueAt, confirm).then((gone) => {
      if (!gone) terminationError = TERMINATION_UNCONFIRMED;
      settle(code, signal);
    });
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
