import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CAC } from '../../node_modules/cac/dist/index.d.ts';
import { afterAll, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { initPlan } from '../../src/commands/init/index.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

const root = mkdtempSync(join(tmpdir(), 'devai-init-plan-preconditions-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function invoke(target: string, introspect = false) {
  const cli = cac('devai-init-plan-preconditions');
  initPlan.register(cli);
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  try {
    process.argv = [
      'node',
      'devai',
      'init-plan',
      '--target',
      target,
      ...(introspect ? ['--introspect'] : []),
    ];
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    cli.parse(process.argv, { run: false });
    await withAuthorityHostTestScope(() => cli.runMatchedCommand());
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

describe('init plan target preconditions', () => {
  it('refuses a target that does not exist with its resolved path in context', async () => {
    const target = join(root, 'missing');
    const result = await invoke(target);
    expect(result.exit).toBe(5);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      class: 'precondition',
      exit: 5,
      context: { target_root: target },
    });
    expect(result.stderr).toContain(target);
  });

  it('refuses an existing non-repository directory', async () => {
    const result = await invoke(root);
    expect(result.exit).toBe(5);
    expect(JSON.parse(result.stderr)).toMatchObject({
      message: `Init target is not a Git repository: ${root}`,
      context: { target_root: root },
    });
  });

  it('applies the same repository precondition to introspection', async () => {
    const result = await invoke(root, true);
    expect(result.exit).toBe(5);
    expect(JSON.parse(result.stderr)).toMatchObject({
      class: 'precondition',
      context: { target_root: root },
    });
  });
});
