import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runWithAuthorityHostEffects,
  spawn,
  type AuthorityHostEffectScope,
  type GuardedSpawnOptions,
} from '../../src/boundaries/host-effects.js';
import { createIssuer, runtimeApi } from './authority-runtime-testkit.js';

const dirs: string[] = [];
const strays: number[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  vi.restoreAllMocks();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A leader that starts a grandchild ignoring SIGTERM, detached from the leader's pipes so
 * the leader's close does not wait for it, and prints the grandchild pid once its handler
 * is installed.
 */
const STUBBORN_GRANDCHILD = [
  'const { spawn } = require("child_process");',
  'const grandchild = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); process.stdout.write(\\"ready\\"); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });',
  'grandchild.stdout.once("data", () => process.stdout.write(`${grandchild.pid}\\n`));',
  'setInterval(() => {}, 1000);',
].join('\n');

function grandchildPid(stdout: string): number {
  const pid = Number(/^(\d+)\n/u.exec(stdout)?.[1]);
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  strays.push(pid);
  return pid;
}

function cwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'devai-host-process-'));
  dirs.push(dir);
  return dir;
}

function options(overrides: Partial<GuardedSpawnOptions> = {}): GuardedSpawnOptions {
  return { cwd: cwd(), timeout: 10_000, shell: false, maxOutputBytes: 1024, ...overrides };
}

async function withScope<T>(
  run: (applyEffect: ReturnType<typeof vi.fn>) => Promise<T>,
  decide: (request: unknown, apply: () => unknown) => unknown = (_request, apply) => apply(),
): Promise<T> {
  const issuer = createIssuer(await runtimeApi(), { invocation_id: 'host-process' });
  const apply_effect = vi.fn(decide);
  const scope: AuthorityHostEffectScope = {
    action_id: 'round run',
    invocation_id: 'host-process',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect,
  };
  try {
    return await runWithAuthorityHostEffects(scope, () => run(apply_effect));
  } finally {
    issuer.dispose();
  }
}

const node = process.execPath;

describe('governed asynchronous spawn (ADR-MDL-0005 D-10)', () => {
  it('refuses outside an authority scope', () => {
    expect(() => spawn(node, ['-e', ''], options())).toThrow('AUTHORITY_FINAL_BOUNDARY_REQUIRED');
  });

  it('authorizes through the scope as a process effect before the child starts', async () => {
    await withScope(async (applyEffect) => {
      const child = spawn(node, ['-e', 'process.stdout.write("ok")'], options());
      expect(applyEffect).toHaveBeenCalledTimes(1);
      expect(applyEffect.mock.calls[0]?.[0]).toMatchObject({
        kind: 'process',
        symbol: 'spawn',
        arguments: [node, ['-e', 'process.stdout.write("ok")'], { shell: false, timeout: 10_000 }],
      });
      const result = await child.result;
      expect(result).toMatchObject({
        exit_code: 0,
        stdout: 'ok',
        timed_out: false,
        spawn_error: null,
      });
    });
  });

  it('starts nothing when the scope refuses the effect', async () => {
    await withScope(
      async () => {
        expect(() => spawn(node, ['-e', ''], options())).toThrow(
          'AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED',
        );
      },
      () => {
        throw new Error('AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED');
      },
    );
  });

  it.each([
    [{ shell: true as unknown as false }, 'AUTHORITY_PROCESS_SHELL_FORBIDDEN'],
    [{ timeout: 0 }, 'AUTHORITY_PROCESS_TIMEOUT_REQUIRED'],
    [{ maxOutputBytes: 0 }, 'AUTHORITY_PROCESS_OUTPUT_BOUND_REQUIRED'],
    [{ killGraceMs: Number.NaN }, 'AUTHORITY_PROCESS_TIMEOUT_REQUIRED'],
    [{ killConfirmMs: -1 }, 'AUTHORITY_PROCESS_TIMEOUT_REQUIRED'],
  ])('refuses %j before authorization', async (change, code) => {
    await withScope(async (applyEffect) => {
      expect(() => spawn(node, ['-e', ''], options(change))).toThrow(code);
      expect(applyEffect).not.toHaveBeenCalled();
    });
  });

  it('keeps the newest output bytes and reports truncation, while observers see everything', async () => {
    await withScope(async () => {
      let observed = '';
      const child = spawn(
        node,
        ['-e', 'process.stdout.write("a".repeat(100) + "TAIL")'],
        options({ maxOutputBytes: 10, onStdout: (chunk) => (observed += chunk) }),
      );
      const result = await child.result;
      expect(result.stdout).toBe('aaaaaaTAIL');
      expect(result.stdout_truncated).toBe(true);
      expect(observed).toHaveLength(104);
    });
  });

  it('passes input on stdin', async () => {
    await withScope(async () => {
      const child = spawn(
        node,
        ['-e', 'process.stdin.pipe(process.stdout)'],
        options({ input: 'prompt-bytes' }),
      );
      expect((await child.result).stdout).toBe('prompt-bytes');
    });
  });

  it('stops the whole process group on timeout', async () => {
    await withScope(async () => {
      const started = Date.now();
      // The child spawns a grandchild that would outlive a plain kill of the child.
      const script =
        'require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});setInterval(()=>{},1000)';
      const child = spawn(node, ['-e', script], options({ timeout: 300, killGraceMs: 200 }));
      const result = await child.result;
      expect(result.timed_out).toBe(true);
      expect(result.exit_code === null || result.signal !== null).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  });

  it('kills a group member that ignores SIGTERM after the leader exits on timeout', async () => {
    await withScope(async () => {
      let ready = false;
      const child = spawn(
        node,
        ['-e', STUBBORN_GRANDCHILD],
        options({
          timeout: 2_000,
          killGraceMs: 200,
          onStdout: (chunk) => (ready ||= /\d+\n/u.test(chunk)),
        }),
      );
      const result = await child.result;
      expect(ready).toBe(true);
      expect(result.timed_out).toBe(true);
      expect(result.signal).toBe('SIGTERM');
      // The leader died of SIGTERM; its grandchild survived it and must not outlive the result.
      expect(alive(grandchildPid(result.stdout))).toBe(false);
    });
  });

  it('kills a group member that ignores SIGTERM after a requested termination', async () => {
    await withScope(async () => {
      const child = spawn(
        node,
        ['-e', STUBBORN_GRANDCHILD],
        options({
          killGraceMs: 200,
          onStdout: (chunk) => {
            if (/\d+\n/u.test(chunk)) child.terminate();
          },
        }),
      );
      const result = await child.result;
      expect(result.timed_out).toBe(false);
      expect(alive(grandchildPid(result.stdout))).toBe(false);
      // The group really is gone, so the termination is confirmed.
      expect(result.termination_error).toBeUndefined();
    });
  });

  it('reports an unconfirmed termination while the group still answers its probe', async () => {
    await withScope(async () => {
      const realKill = process.kill.bind(process);
      // Injected probe: every group liveness probe (signal 0 to a negative pid) answers that
      // the group is alive, as for a member stuck in uninterruptible I/O. Real signals still
      // reach the real processes.
      vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) =>
        signal === 0 && pid < 0 ? true : realKill(pid, signal),
      );
      const startedAt = Date.now();
      const child = spawn(
        node,
        ['-e', 'setInterval(()=>{},1000)'],
        options({ killGraceMs: 100, killConfirmMs: 300 }),
      );
      child.terminate();
      const result = await child.result;
      expect(result.signal).toBe('SIGTERM');
      expect(result.termination_error).toBe('PROCESS_GROUP_TERMINATION_UNCONFIRMED');
      // It waited out the grace period and the confirmation window before saying so.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400);
    });
  });

  it('reports an unconfirmed termination when an escaped descendant keeps its output open', async () => {
    await withScope(async () => {
      // A descendant in its own session survives the group kill and holds the child's
      // stdout, so the child's streams never close on their own.
      const script = [
        'const { spawn } = require("child_process");',
        'const escaped = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", "inherit", "ignore"] });',
        'process.stdout.write(`${escaped.pid}\\n`);',
        'setInterval(() => {}, 1000);',
      ].join('\n');
      let escapedPid: number | undefined;
      const child = spawn(
        node,
        ['-e', script],
        options({
          killGraceMs: 100,
          killConfirmMs: 300,
          onStdout: (chunk) => {
            const pid = Number(/^(\d+)\n/u.exec(chunk)?.[1]);
            if (escapedPid !== undefined || !Number.isInteger(pid) || pid <= 0) return;
            escapedPid = pid;
            strays.push(pid);
            child.terminate();
          },
        }),
      );
      const result = await child.result;
      expect(escapedPid).toBeDefined();
      expect(alive(escapedPid ?? 0)).toBe(true);
      expect(result.termination_error).toBe('PROCESS_GROUP_TERMINATION_UNCONFIRMED');
      // The child itself exited on SIGTERM; only its streams stayed open.
      expect(result.signal).toBe('SIGTERM');
    });
  }, 15_000);

  it('terminates on request', async () => {
    await withScope(async () => {
      const child = spawn(node, ['-e', 'setInterval(()=>{},1000)'], options());
      child.terminate();
      const result = await child.result;
      expect(result.signal).toBe('SIGTERM');
      expect(result.timed_out).toBe(false);
    });
  });

  it('never signals a settled process group again', async () => {
    await withScope(async () => {
      const child = spawn(node, ['-e', ''], options());
      await child.result;
      const kill = vi.spyOn(process, 'kill');
      child.terminate();
      expect(kill).not.toHaveBeenCalled();
    });
  });

  it('reports a missing executable without rejecting', async () => {
    await withScope(async () => {
      const child = spawn('devai-no-such-executable', [], options());
      const result = await child.result;
      expect(result.spawn_error).toBe('ENOENT');
      expect(result.exit_code).toBeNull();
    });
  });
});
