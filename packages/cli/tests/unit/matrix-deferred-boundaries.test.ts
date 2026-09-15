import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cac } from 'cac';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { renderMatrix } from '../../src/commands/render/matrix.js';

interface Invocation {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RecordInput {
  readonly id: string;
  readonly scope: string;
  readonly tier?: string;
  readonly status?: 'pass' | 'fail' | 'error' | 'skipped' | 'flaky';
  readonly timestamp?: string;
  readonly metrics?: Readonly<Record<string, unknown>>;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-render-matrix-deferred-'));
  roots.push(root);
  mkdirSync(join(root, '.devai/state/test-results'), { recursive: true });
  return root;
}

function record(input: RecordInput): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    id: input.id,
    repo: 'devai-fixture',
    scope: input.scope,
    tier: input.tier ?? 'unit',
    status: input.status ?? 'pass',
    timestamp: input.timestamp ?? new Date(Date.now() - 60_000).toISOString(),
    metrics: input.metrics ?? { passed: 1, failed: 0 },
    command: 'pnpm test',
    exit_code: input.status === 'fail' || input.status === 'error' ? 1 : 0,
  };
}

function writeJson(root: string, path: string, value: unknown): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(value));
}

function putResult(root: string, path: string, input: RecordInput): void {
  writeJson(root, join('.devai/state/test-results', path), record(input));
}

function tableLines(stdout: string): string[] {
  return stdout.split('\n').filter((line) => line.startsWith('|'));
}

async function invoke(root: string, args: readonly string[]): Promise<Invocation> {
  const cli = cac('devai-render-matrix-deferred');
  renderMatrix.register(cli);
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalExitCode = process.exitCode;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  try {
    process.argv = ['node', 'devai', ...args];
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
    await new Promise<void>((resolve) => setImmediate(resolve));
    return {
      exit: typeof process.exitCode === 'number' ? process.exitCode : 0,
      stdout,
      stderr: stderr.replace(/^devai evidence test matrix: TEST_PROCESS_EXIT:\d+\n/gm, ''),
    };
  } finally {
    process.argv = originalArgv;
    process.exit = originalExit;
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

function putExtraRecords(root: string): void {
  putResult(root, 'unit-complete.json', {
    id: 'unit-complete',
    scope: 'unit-complete',
    metrics: { passed: 3, failed: 1 },
  });
  putResult(root, 'unit-failed.json', {
    id: 'unit-failed',
    scope: 'unit-failed',
    metrics: { failed: 2 },
  });
  putResult(root, 'unit-passed.json', {
    id: 'unit-passed',
    scope: 'unit-passed',
    metrics: { passed: 3 },
  });
  putResult(root, 'unit-mutation.json', {
    id: 'unit-mutation',
    scope: 'unit-mutation',
    metrics: { mutation_score: 20 },
  });
  putResult(root, 'unit-coverage.json', {
    id: 'unit-coverage',
    scope: 'unit-coverage',
    metrics: { coverage_pct: { lines: 12.5 } },
  });
  putResult(root, 'actual-mutation.json', {
    id: 'actual-mutation',
    scope: 'actual-mutation',
    tier: 'mutation',
    metrics: { mutation_score: 65 },
  });
  putResult(root, 'actual-coverage.json', {
    id: 'actual-coverage',
    scope: 'actual-coverage',
    tier: 'coverage',
    metrics: { coverage_pct: { lines: 81.2 } },
  });
}

describe('render matrix deferred behavioral boundaries', () => {
  it('keeps threshold and default extras tied to complete metrics on the correct tier', async () => {
    const root = repository();
    putExtraRecords(root);
    writeJson(root, 'thresholds.json', { mutation: { score_min: 70 } });

    const withThresholds = await invoke(root, [
      'render-matrix',
      '--repo-root',
      root,
      '--include-thresholds',
      '--thresholds-path',
      'thresholds.json',
    ]);
    expect(withThresholds).toMatchObject({ exit: 0, stderr: '' });
    expect(tableLines(withThresholds.stdout)).toEqual([
      '| Scope | unit | mutation | coverage |',
      '|---|---|---|---|',
      '| actual-coverage | N/A | N/A | PASS 81.2% |',
      '| actual-mutation | N/A | PASS 65.0% / req 70.0% | N/A |',
      '| unit-complete | PASS 3/4 | N/A | N/A |',
      '| unit-coverage | PASS | N/A | N/A |',
      '| unit-failed | PASS | N/A | N/A |',
      '| unit-mutation | PASS | N/A | N/A |',
      '| unit-passed | PASS | N/A | N/A |',
    ]);

    const defaults = await invoke(root, ['render-matrix', '--repo-root', root]);
    expect(defaults).toMatchObject({ exit: 0, stderr: '' });
    expect(tableLines(defaults.stdout)).toEqual([
      '| Scope | unit | mutation | coverage |',
      '|---|---|---|---|',
      '| actual-coverage | N/A | N/A | PASS 81.2% |',
      '| actual-mutation | N/A | PASS 65.0% | N/A |',
      '| unit-complete | PASS 3/4 | N/A | N/A |',
      '| unit-coverage | PASS | N/A | N/A |',
      '| unit-failed | PASS | N/A | N/A |',
      '| unit-mutation | PASS | N/A | N/A |',
      '| unit-passed | PASS | N/A | N/A |',
    ]);
  });

  it('uses the strictly latest result independently in strict-mode status checks', async () => {
    const root = repository();
    const now = Date.now() - 60_000;
    const at = (offset: number): string => new Date(now + offset).toISOString();
    putResult(root, 'always-first.json', {
      id: 'always-first',
      scope: 'always-overwrite',
      timestamp: at(5_000),
    });
    putResult(root, 'n1/always-last.json', {
      id: 'always-last',
      scope: 'always-overwrite',
      status: 'fail',
      timestamp: at(0),
    });
    putResult(root, 'n1/n2/never-first.json', {
      id: 'never-first',
      scope: 'never-overwrite',
      status: 'fail',
      timestamp: at(0),
    });
    putResult(root, 'n1/n2/n3/never-last.json', {
      id: 'never-last',
      scope: 'never-overwrite',
      timestamp: at(5_000),
    });
    putResult(root, 'n1/n2/n3/n4/tie-first.json', {
      id: 'tie-first',
      scope: 'tie-overwrite',
      timestamp: at(2_000),
    });
    putResult(root, 'n1/n2/n3/n4/n5/tie-last.json', {
      id: 'tie-last',
      scope: 'tie-overwrite',
      status: 'fail',
      timestamp: at(2_000),
    });

    const result = await invoke(root, ['render-matrix', '--repo-root', root, '--strict']);
    expect(result).toEqual({
      exit: 0,
      stderr: '',
      stdout:
        '# Test matrix\n\n| Scope | unit |\n|---|---|\n' +
        '| always-overwrite | PASS 1/1 |\n' +
        '| never-overwrite | PASS 1/1 |\n' +
        '| tie-overwrite | PASS 1/1 |\n',
    });
  });

  it('falls back from an empty configured tier list when enforcing strict status', async () => {
    const root = repository();
    putResult(root, 'failure.json', {
      id: 'failure',
      scope: 'empty-config',
      status: 'fail',
    });
    writeJson(root, 'empty-tiers.json', { tiers: [] });

    const result = await invoke(root, [
      'render-matrix',
      '--repo-root',
      root,
      '--config',
      'empty-tiers.json',
      '--strict',
    ]);
    expect(result).toMatchObject({ exit: 2 });
    expect(result.stderr).toBe(
      'devai evidence test matrix: strict mode — 1 violation(s):\n' +
        '  [empty-config/unit] status: fail\n',
    );
  });

  it('reports the default freshness limit and age from a dynamic timestamp', async () => {
    const root = repository();
    putResult(root, 'stale.json', {
      id: 'stale',
      scope: 'stale-default',
      timestamp: new Date(Date.now() - 200 * 3_600_000).toISOString(),
    });

    const result = await invoke(root, ['render-matrix', '--repo-root', root, '--strict']);
    expect(result).toMatchObject({ exit: 2 });
    expect(result.stderr).toBe(
      'devai evidence test matrix: strict mode — 1 violation(s):\n' +
        '  [stale-default/unit] stale: record is 200.0h old (limit 168h)\n',
    );
  });

  it('treats an error result as a strict status violation', async () => {
    const root = repository();
    putResult(root, 'error.json', {
      id: 'error',
      scope: 'error-status',
      status: 'error',
      metrics: {},
    });

    const result = await invoke(root, ['render-matrix', '--repo-root', root, '--strict']);
    expect(result).toMatchObject({ exit: 2 });
    expect(result.stderr).toBe(
      'devai evidence test matrix: strict mode — 1 violation(s):\n' +
        '  [error-status/unit] status: error\n',
    );
  });

  it('does not apply coverage or mutation thresholds to another tier', async () => {
    const root = repository();
    putResult(root, 'unit.json', {
      id: 'unit',
      scope: 'unit-with-unrelated-metrics',
      metrics: { coverage_pct: { lines: 10 }, mutation_score: 20 },
    });
    writeJson(root, 'thresholds.json', {
      coverage: { lines: 75 },
      mutation: { score_min: 70 },
    });

    const result = await invoke(root, [
      'render-matrix',
      '--repo-root',
      root,
      '--thresholds-path',
      'thresholds.json',
      '--strict',
    ]);
    expect(result).toEqual({
      exit: 0,
      stderr: '',
      stdout:
        '# Test matrix\n\n| Scope | unit |\n|---|---|\n' +
        '| unit-with-unrelated-metrics | PASS |\n',
    });
  });

  it('renders exact empty and N/A HTML structures', async () => {
    const emptyRoot = repository();
    const empty = await invoke(emptyRoot, [
      'render-matrix',
      '--repo-root',
      emptyRoot,
      '--format',
      'html',
    ]);
    expect(empty).toMatchObject({ exit: 0, stderr: '' });
    expect(empty.stdout).toContain(
      '<h1>Test matrix</h1><p><em>No test-result records found.</em></p>',
    );
    expect(empty.stdout).not.toContain('<table>');

    const populatedRoot = repository();
    putResult(populatedRoot, 'unit.json', { id: 'unit', scope: 'pkg-html' });
    writeJson(populatedRoot, 'matrix.json', {
      tiers: ['unit', 'coverage'],
      na_overrides: [{ scope: 'pkg-html', tier: 'coverage' }],
    });
    const populated = await invoke(populatedRoot, [
      'render-matrix',
      '--repo-root',
      populatedRoot,
      '--config',
      'matrix.json',
      '--format',
      'html',
    ]);
    expect(populated).toMatchObject({ exit: 0, stderr: '' });
    expect(populated.stdout).toContain('<tr><th>Scope</th><th>unit</th><th>coverage</th></tr>');
    expect(populated.stdout).toContain(
      '<tr><th>pkg-html</th><td class="cell cell-pass">PASS 1/1</td>' +
        '<td class="cell cell-na">N/A</td></tr>',
    );
    expect(populated.stdout).not.toContain('undefined');
  });
});
