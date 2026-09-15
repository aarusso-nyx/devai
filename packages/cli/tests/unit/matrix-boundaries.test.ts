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
  const root = mkdtempSync(join(tmpdir(), 'devai-render-matrix-boundaries-'));
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
    timestamp: input.timestamp ?? '2026-09-09T10:00:00.000Z',
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
  const cli = cac('devai-render-matrix-boundaries');
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
      // The stubbed process.exit throws into the command's catch; remove only that impossible-in-production echo.
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

describe('render matrix behavioral boundaries', () => {
  it('compiles single-star, double-star, prefix, and literal-dot scope globs', async () => {
    const root = repository();
    for (const [index, scope] of [
      'pkg/one',
      'pkg/deep/leaf',
      'pkgx',
      'zeta/core',
      'zeta/deep/leaf',
      'alpha/core',
      'deep/nest/core',
      'xcore',
      'pkg.one',
      'pkgXone',
    ].entries()) {
      putResult(root, `${String(index)}.json`, { id: `glob-${String(index)}`, scope });
    }

    const cases = [
      { pattern: 'pkg/*', scopes: ['pkg/one'] },
      { pattern: 'zeta/**', scopes: ['zeta/core', 'zeta/deep/leaf'] },
      { pattern: '*/core', scopes: ['alpha/core', 'zeta/core'] },
      { pattern: 'pkg.one', scopes: ['pkg.one'] },
    ] as const;
    for (const fixture of cases) {
      writeJson(root, 'matrix.json', { scopes_include: [fixture.pattern] });
      const result = await invoke(root, [
        'render-matrix',
        '--repo-root',
        root,
        '--config',
        'matrix.json',
      ]);
      expect(result).toMatchObject({ exit: 0, stderr: '' });
      expect(tableLines(result.stdout)).toEqual([
        '| Scope | unit |',
        '|---|---|',
        ...fixture.scopes.map((scope) => `| ${scope} | PASS 1/1 |`),
      ]);
    }
  });

  it('fails closed for missing and non-object explicit matrix configs', async () => {
    const root = repository();
    putResult(root, 'baseline.json', { id: 'baseline', scope: 'pkg-config' });

    const missingPath = join(root, 'absent.json');
    const missing = await invoke(root, [
      'render-matrix',
      '--repo-root',
      root,
      '--config',
      'absent.json',
    ]);
    expect(missing).toEqual({
      exit: 2,
      stdout: '',
      stderr: `devai evidence test matrix: config not found: ${missingPath}\n`,
    });

    for (const [name, value] of [
      ['array.json', []],
      ['null.json', null],
      ['scalar.json', 42],
    ] as const) {
      writeJson(root, name, value);
      const result = await invoke(root, ['render-matrix', '--repo-root', root, '--config', name]);
      expect(result).toEqual({
        exit: 2,
        stdout: '',
        stderr: `devai evidence test matrix: config at ${join(root, name)} must be a JSON object\n`,
      });
    }
  });

  it('treats a null thresholds document as absent', async () => {
    const root = repository();
    putResult(root, 'coverage.json', {
      id: 'coverage',
      scope: 'pkg-coverage',
      tier: 'coverage',
      metrics: { coverage_pct: { lines: 81.2 } },
    });
    writeJson(root, 'thresholds.json', null);

    const result = await invoke(root, [
      'render-matrix',
      '--repo-root',
      root,
      '--include-thresholds',
      '--thresholds-path',
      'thresholds.json',
    ]);
    expect(result).toMatchObject({ exit: 0, stderr: '' });
    expect(tableLines(result.stdout)).toEqual([
      '| Scope | coverage |',
      '|---|---|',
      '| pkg-coverage | PASS 81.2% |',
    ]);
  });

  it('admits only JSON files with string identity fields', async () => {
    const root = repository();
    putResult(root, 'valid.json', { id: 'valid', scope: 'valid-scope' });
    writeFileSync(
      join(root, '.devai/state/test-results/stray.txt'),
      JSON.stringify(record({ id: 'stray', scope: 'stray-scope' })),
    );
    const missingId = record({ id: 'placeholder', scope: 'no-id-scope' });
    delete missingId.id;
    writeJson(root, '.devai/state/test-results/no-id.json', missingId);

    const result = await invoke(root, ['render-matrix', '--repo-root', root]);
    expect(result).toMatchObject({ exit: 0, stderr: '' });
    expect(tableLines(result.stdout)).toEqual([
      '| Scope | unit |',
      '|---|---|',
      '| valid-scope | PASS 1/1 |',
    ]);
  });

  it('ignores incomplete filters and tokenizes known filter values', async () => {
    const root = repository();
    putResult(root, 'a-unit.json', {
      id: 'a-unit',
      scope: 'pkg-a',
      metrics: { passed: 3, failed: 0 },
    });
    putResult(root, 'a-api.json', {
      id: 'a-api',
      scope: 'pkg-a',
      tier: 'api',
      status: 'fail',
      metrics: { passed: 1, failed: 1 },
    });
    putResult(root, 'b-unit.json', {
      id: 'b-unit',
      scope: 'pkg-b',
      metrics: { passed: 2, failed: 0 },
    });
    const fullTable = [
      '| Scope | unit | api |',
      '|---|---|---|',
      '| pkg-a | PASS 3/3 | FAIL 1/2 |',
      '| pkg-b | PASS 2/2 | N/A |',
    ];

    for (const filter of ['tiers', 'tier=', 'zzz=pass']) {
      const result = await invoke(root, ['render-matrix', '--repo-root', root, '--filter', filter]);
      expect(result).toMatchObject({ exit: 0, stderr: '' });
      expect(tableLines(result.stdout)).toEqual(fullTable);
    }

    const spaced = await invoke(root, [
      'render-matrix',
      '--repo-root',
      root,
      '--filter',
      'tier= unit',
    ]);
    expect(spaced).toMatchObject({ exit: 0, stderr: '' });
    expect(tableLines(spaced.stdout)).toEqual([
      '| Scope | unit |',
      '|---|---|',
      '| pkg-a | PASS 3/3 |',
      '| pkg-b | PASS 2/2 |',
    ]);
  });

  it('selects the strictly latest result and preserves the first result on a tie', async () => {
    const root = repository();
    putResult(root, 'r1.json', {
      id: 'r1',
      scope: 'pkg-latest',
      status: 'fail',
      timestamp: '2026-09-09T10:00:00.000Z',
      metrics: { passed: 0, failed: 1 },
    });
    putResult(root, 'n1/r2.json', {
      id: 'r2',
      scope: 'pkg-latest',
      timestamp: '2026-09-09T10:02:00.000Z',
      metrics: { passed: 2, failed: 0 },
    });
    putResult(root, 'n1/n2/r3.json', {
      id: 'r3',
      scope: 'pkg-latest',
      status: 'error',
      timestamp: '2026-09-09T10:01:00.000Z',
      metrics: {},
    });
    putResult(root, 'n1/n2/n3/r4.json', {
      id: 'r4',
      scope: 'pkg-latest',
      status: 'skipped',
      timestamp: '2026-09-09T10:02:00.000Z',
      metrics: {},
    });

    const result = await invoke(root, ['render-matrix', '--repo-root', root]);
    expect(result).toMatchObject({ exit: 0, stderr: '' });
    expect(tableLines(result.stdout)).toEqual([
      '| Scope | unit |',
      '|---|---|',
      '| pkg-latest | PASS 2/2 |',
    ]);
  });

  it('distinguishes declared N/A cells from every required missing cell in strict mode', async () => {
    const root = repository();
    putResult(root, 'beta-unit.json', {
      id: 'beta-unit',
      scope: 'beta',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
    });
    writeJson(root, 'strict-na.json', {
      tiers: ['unit', 'coverage', 'perf'],
      na_overrides: [{ scope: 'alpha', tier: 'coverage' }],
    });

    const result = await invoke(root, [
      'render-matrix',
      '--repo-root',
      root,
      '--config',
      'strict-na.json',
      '--strict',
    ]);
    expect(result).toEqual({
      exit: 2,
      stdout:
        '# Test matrix\n\n| Scope | unit | coverage |\n|---|---|---|\n| alpha | N/A | N/A |\n| beta | PASS 1/1 | N/A |\n',
      stderr:
        'devai evidence test matrix: strict mode — 4 violation(s):\n' +
        '  [alpha/unit] missing: no test-result record found\n' +
        '  [alpha/perf] missing: no test-result record found\n' +
        '  [beta/coverage] missing: no test-result record found\n' +
        '  [beta/perf] missing: no test-result record found\n',
    });
  });

  it('rejects unsupported formats and named views before rendering', async () => {
    const root = repository();
    putResult(root, 'baseline.json', { id: 'baseline', scope: 'pkg-usage' });

    const invalidFormat = await invoke(root, [
      'render-matrix',
      '--repo-root',
      root,
      '--format',
      'xml',
    ]);
    expect(invalidFormat).toEqual({
      exit: 2,
      stdout: '',
      stderr: "devai evidence test matrix: --format must be md|html (got 'xml')\n",
    });

    const invalidView = await invoke(root, [
      'render-matrix',
      '--repo-root',
      root,
      '--view',
      'bogus',
    ]);
    expect(invalidView).toEqual({
      exit: 2,
      stdout: '',
      stderr: "devai evidence test matrix: --view must be 'timings' (got 'bogus')\n",
    });
  });

  it('renders distinct error and flaky status glyphs through the command', async () => {
    const root = repository();
    putResult(root, 'error.json', {
      id: 'error',
      scope: 'pkg-err',
      status: 'error',
      metrics: {},
    });
    putResult(root, 'flaky.json', {
      id: 'flaky',
      scope: 'pkg-flaky',
      status: 'flaky',
      metrics: {},
    });

    const result = await invoke(root, ['render-matrix', '--repo-root', root]);
    expect(result).toMatchObject({ exit: 0, stderr: '' });
    expect(tableLines(result.stdout)).toEqual([
      '| Scope | unit |',
      '|---|---|',
      '| pkg-err | ERR |',
      '| pkg-flaky | FLAKY |',
    ]);
  });

  it('renders the exact markdown empty state and non-empty heading', async () => {
    const emptyRoot = repository();
    const empty = await invoke(emptyRoot, [
      'render-matrix',
      '--repo-root',
      emptyRoot,
      '--format',
      'md',
    ]);
    expect(empty).toEqual({
      exit: 0,
      stderr: '',
      stdout: '# Test matrix\n\n_No test-result records found._\n',
    });

    const populatedRoot = repository();
    putResult(populatedRoot, 'one.json', { id: 'one', scope: 'pkg-heading' });
    const populated = await invoke(populatedRoot, [
      'render-matrix',
      '--repo-root',
      populatedRoot,
      '--format',
      'md',
    ]);
    expect(populated).toEqual({
      exit: 0,
      stderr: '',
      stdout: '# Test matrix\n\n| Scope | unit |\n|---|---|\n| pkg-heading | PASS 1/1 |\n',
    });
  });
});
