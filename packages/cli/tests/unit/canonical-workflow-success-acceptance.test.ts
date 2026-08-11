// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
// Inspector acceptance: canonical read and local-write facades complete through
// their real service seams while all mutations remain inside a temporary repo.
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CAC } from '../../node_modules/cac/dist/index.d.ts';
import { afterAll, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  initApplyArchitect,
  initApplyHarness,
  initApplyOwner,
  initBind,
  initPlan,
} from '../../src/commands/init/index.js';
import { executeInventorySlice } from '../../src/commands/sense/inventory.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

const ROOT = resolve(import.meta.dirname, '../../../..');
const TARGET = mkdtempSync(join(tmpdir(), 'devai-r0007-init-acceptance-'));

afterAll(() => {
  rmSync(TARGET, { recursive: true });
});

async function invoke(definition: { register(cli: CAC): void }, argv: readonly string[]) {
  const cli = cac('devai-canonical-workflow-success');
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
    return {
      exit: typeof process.exitCode === 'number' ? process.exitCode : 0,
      stdout,
      stderr,
    };
  } finally {
    process.argv = originalArgv;
    process.exit = originalExit;
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

describe('canonical workflow success acceptance', () => {
  it('executes every canonical inventory slice without implicit persistence', async () => {
    const output = await withAuthorityHostTestScope(() =>
      executeInventorySlice('all', { repoRoot: ROOT, adopterRoot: ROOT }),
    );

    expect(output.slice).toBe('all');
    expect(output.members).toHaveLength(11);
    expect(output.results.map((result) => result.member)).toEqual(output.members);
    expect(output.implicit_persistence).toBe(false);
    expect(['pass', 'review']).toContain(output.status);
  }, 120_000);

  it('plans and applies the three role-pure init segments only inside a temporary repo', async () => {
    const cases = [
      [initPlan, ['init-plan', '--target', TARGET, '--tier', 'tier1']],
      [initApplyOwner, ['init-apply-owner', '--target', TARGET, '--tier', 'tier1']],
      [initApplyArchitect, ['init-apply-architect', '--target', TARGET, '--tier', 'tier1']],
      [initApplyHarness, ['init-apply-harness', '--target', TARGET, '--tier', 'tier1']],
      [initPlan, ['init-plan', '--target', TARGET, '--tier', 'tier1', '--introspect']],
      [initBind, ['init-bind', '--target', TARGET]],
    ] as const;

    for (const [definition, argv] of cases) {
      const result = await invoke(definition, argv);
      expect(result.exit, `${argv.join(' ')}: ${result.stderr}`).toBe(0);
      expect(result.stdout, argv.join(' ')).not.toBe('');
      expect(result.stderr, argv.join(' ')).toBe('');
    }
  }, 120_000);

  it('installs both host recipe adapters idempotently through init apply harness', async () => {
    const argv = ['init-apply-harness', '--target', TARGET, '--include', 'skills'] as const;
    const first = await invoke(initApplyHarness, argv);
    const second = await invoke(initApplyHarness, argv);
    expect(first.exit, first.stderr).toBe(0);
    expect(second.exit, second.stderr).toBe(0);
    for (const name of [
      'devai-assess',
      'devai-plan',
      'devai-fix',
      'devai-docs',
      'devai-scaffold',
      'devai-verify',
      'devai-round',
    ]) {
      for (const hostRoot of ['.agents/skills', '.claude/skills']) {
        const base = join(TARGET, hostRoot, name);
        expect(existsSync(join(base, 'SKILL.md'))).toBe(true);
        expect(existsSync(join(base, 'devai.recipe.json'))).toBe(true);
        expect(existsSync(join(base, 'devai.operations.json'))).toBe(true);
      }
      expect(
        readFileSync(join(TARGET, '.agents/skills', name, 'devai.operations.json'), 'utf8'),
      ).toBe(readFileSync(join(TARGET, '.claude/skills', name, 'devai.operations.json'), 'utf8'));
    }
    expect(second.stdout).toContain('"written":[]');
  });
});
