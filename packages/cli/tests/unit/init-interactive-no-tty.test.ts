// RED (TASK-0182 / ADR-CFG-0001, IA-004): `init plan` does not register an
// `--interactive` flag yet, so this file fails deterministically with a cac
// `Unknown option \`--interactive\`` error. It encodes
// docs/adopters/interactive-configuration.md#no-terminal-attached: "When
// either [standard input or standard output] is not a terminal, or standard
// input is closed, `init plan --interactive` exits with the structured error
// envelope every action uses (`law/schemas/error.schema.json` on stderr) and
// performs no write."
//
// This test drives the real CLI entry point (`initPlan` from
// packages/cli/src/commands/init/index.ts) rather than a service function,
// because terminal detection is a property of the CLI's standard streams at
// invocation time, not something an injected `io` object can exercise. The
// only environment fake it introduces is `process.stdin.isTTY`, forced to
// `false` to represent "not a terminal" (closed stdin surfaces the same way);
// stdout/stderr/exit are captured with the same monkeypatching used by every
// other `init` CLI test in this shard (see cli-shard09-init-core-planning.test.ts).
//
// Assumption the Engineer must honor: `init plan` gains `--interactive` and
// `--mode <bind|edit>` options, and when standard input is not a terminal it
// writes a `law/schemas/error.schema.json`-shaped envelope to stderr and sets
// a non-zero, in-range (2-7) exit code -- before constructing any plan or
// touching the target.

import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { CAC } from '../../node_modules/cac/dist/index.d.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { validators } from '@devai-nyx/schemas';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { initPlan } from '../../src/commands/init/index.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

const roots: string[] = [];

function fixture(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  if (spawnSync('git', ['init', '--quiet'], { cwd: root }).status !== 0) {
    throw new Error('test git init failed');
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Every entry below `root`, excluding `.git`, relative and sorted. */
function listTree(root: string): string[] {
  const entries: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (prefix === '' && entry.name === '.git') continue;
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      entries.push(relativePath);
      if (entry.isDirectory()) walk(join(dir, entry.name), relativePath);
    }
  };
  walk(root, '');
  return entries;
}

async function invoke(
  definition: { register(cli: CAC): void },
  argv: readonly string[],
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const cli = cac('devai-init-interactive-no-tty');
  definition.register(cli);
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalExitCode = process.exitCode;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  try {
    process.argv = ['node', 'devai', ...argv];
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: string | number | null) => {
      process.exitCode = typeof code === 'number' ? code : 0;
      throw new Error(`TEST_PROCESS_EXIT:${String(process.exitCode)}`);
    }) as typeof process.exit;
    cli.parse(process.argv, { run: false });
    try {
      await withAuthorityHostTestScope(() => cli.runMatchedCommand());
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('TEST_PROCESS_EXIT:')) throw error;
    }
    await new Promise<void>((done) => setImmediate(done));
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.argv = originalArgv;
    process.exit = originalExit;
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

describe('init plan --interactive with no terminal attached', () => {
  it('exits with a structured error and performs no write when standard input is not a terminal', async () => {
    const target = fixture('devai-init-interactive-no-tty-');
    const before = listTree(target);

    const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
      writable: true,
    });
    let result: { exit: number; stdout: string; stderr: string };
    try {
      result = await invoke(initPlan, [
        'init-plan',
        '--target',
        target,
        '--tier',
        'tier1',
        '--interactive',
        '--mode',
        'bind',
      ]);
    } finally {
      if (stdinIsTtyDescriptor === undefined) {
        Reflect.deleteProperty(process.stdin, 'isTTY');
      } else {
        Object.defineProperty(process.stdin, 'isTTY', stdinIsTtyDescriptor);
      }
    }

    expect(result.exit).not.toBe(0);
    expect(result.stdout).toBe('');
    const envelope = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(validators.error(envelope)).toBe(true);
    expect(envelope['exit']).toBe(result.exit);
    expect(envelope['exit']).toBeGreaterThanOrEqual(2);
    expect(envelope['exit']).toBeLessThanOrEqual(7);

    expect(listTree(target)).toEqual(before);
  });
});
