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
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

  it('terminates on request', async () => {
    await withScope(async () => {
      const child = spawn(node, ['-e', 'setInterval(()=>{},1000)'], options());
      child.terminate();
      const result = await child.result;
      expect(result.signal).toBe('SIGTERM');
      expect(result.timed_out).toBe(false);
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
