import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cac } from 'cac';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { renderMatrix } from '../../src/commands/render/matrix.js';

interface Invocation {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-render-matrix-depth-'));
  roots.push(root);
  mkdirSync(join(root, '.devai/state/test-results'), { recursive: true });
  return root;
}

async function invoke(root: string, args: readonly string[]): Promise<Invocation> {
  const cli = cac('devai-render-matrix-depth');
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
    return { exit: typeof process.exitCode === 'number' ? process.exitCode : 0, stdout, stderr };
  } finally {
    process.argv = originalArgv;
    process.exit = originalExit;
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

function putResults(root: string): void {
  const dir = join(root, '.devai/state/test-results');
  const record = (input: {
    readonly id: string;
    readonly scope: string;
    readonly tier: string;
    readonly status: 'pass' | 'fail';
    readonly timestamp: string;
    readonly passed: number;
    readonly failed: number;
    readonly exitCode: number;
  }) => ({
    schemaVersion: '1.0.0',
    id: input.id,
    repo: 'devai-fixture',
    scope: input.scope,
    tier: input.tier,
    timestamp: input.timestamp,
    status: input.status,
    command: 'pnpm test',
    env: {
      node: 'v24.20.0',
      os: 'linux-x64',
      branch: 'fixture',
      commit: '1111111111111111111111111111111111111111',
      ci: false,
    },
    metrics: { passed: input.passed, failed: input.failed, duration_ms: 10 },
    evidence: { log_path: `.devai/state/test-results/${input.id}.log` },
    exit_code: input.exitCode,
    signal: null,
  });
  const records = [
    record({
      id: 'unit-a',
      scope: 'pkg-a',
      tier: 'unit',
      status: 'pass',
      timestamp: '2026-09-09T10:00:00.000Z',
      passed: 3,
      failed: 0,
      exitCode: 0,
    }),
    record({
      id: 'api-a',
      scope: 'pkg-a',
      tier: 'api',
      status: 'fail',
      timestamp: '2026-09-09T10:01:00.000Z',
      passed: 1,
      failed: 1,
      exitCode: 1,
    }),
    record({
      id: 'unit-b',
      scope: 'pkg-b',
      tier: 'unit',
      status: 'pass',
      timestamp: '2026-09-09T10:02:00.000Z',
      passed: 2,
      failed: 0,
      exitCode: 0,
    }),
  ];
  records.forEach((value, index) => {
    writeFileSync(join(dir, `${value.id}.log`), `${value.status}\n`);
    writeFileSync(join(dir, `${index}.json`), `${JSON.stringify(value)}\n`);
  });
}

describe('render matrix public command boundaries', () => {
  it('keeps default discovery inside the test-results directory', async () => {
    const root = repository();
    putResults(root);
    writeFileSync(
      join(root, 'unrelated-result.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        id: 'outside-root',
        scope: 'unrelated-root-scope',
        tier: 'perf',
        status: 'pass',
        timestamp: '2026-09-09T10:03:00.000Z',
        metrics: { passed: 1, failed: 0, duration_ms: 10 },
      }),
    );
    const defaultResult = await invoke(root, ['render-matrix', '--repo-root', root]);
    expect(defaultResult.exit).toBe(0);
    expect(defaultResult.stdout).toContain('| Scope | unit | api |');
    expect(defaultResult.stdout).not.toContain('unrelated-root-scope');

    // An explicit broader input includes the same valid record, proving the default
    // exclusion comes from the directory boundary rather than a malformed fixture.
    const explicitResult = await invoke(root, ['render-matrix', '--repo-root', root, '--in', '.']);
    expect(explicitResult.exit).toBe(0);
    expect(explicitResult.stdout).toContain('unrelated-root-scope');
    expect(explicitResult.stdout).toContain('perf');
  });
  it('renders observed scope and tier cells and applies tier/status filters', async () => {
    const root = repository();
    putResults(root);
    const rendered = await invoke(root, ['render-matrix', '--repo-root', root, '--format', 'md']);
    expect(rendered.exit).toBe(0);
    expect(rendered.stdout).toContain('| Scope | unit | api |');
    expect(rendered.stdout).toContain('| pkg-a | PASS 3/3 | FAIL 1/2 |');
    expect(rendered.stdout).toContain('| pkg-b | PASS 2/2 | N/A |');

    const filtered = await invoke(root, [
      'render-matrix',
      '--repo-root',
      root,
      '--format',
      'md',
      '--filter',
      'tier=unit,status=pass',
    ]);
    expect(filtered.exit).toBe(0);
    expect(filtered.stdout).toContain('| Scope | unit |');
    expect(filtered.stdout).not.toContain('api');
    expect(filtered.stdout).toContain('| pkg-a | PASS 3/3 |');
    for (const filter of ['tier=unit', 'status=pass']) {
      const independentlyFiltered = await invoke(root, [
        'render-matrix',
        '--repo-root',
        root,
        '--format',
        'md',
        '--filter',
        filter,
      ]);
      expect(independentlyFiltered.exit).toBe(0);
      expect(independentlyFiltered.stdout).toContain('| pkg-a | PASS 3/3 |');
      expect(independentlyFiltered.stdout).not.toContain('api');
      expect(independentlyFiltered.stdout).not.toContain('FAIL');
    }
  });

  it('renders the matrix before strict mode reports a missing configured tier', async () => {
    const root = repository();
    putResults(root);
    writeFileSync(
      join(root, 'matrix.json'),
      `${JSON.stringify({ schemaVersion: '1.0.0', tiers: ['unit', 'coverage'] })}\n`,
    );
    const result = await invoke(root, [
      'render-matrix',
      '--repo-root',
      root,
      '--config',
      'matrix.json',
      '--strict',
    ]);
    expect(result.exit).toBe(2);
    expect(result.stdout).toContain('| Scope | unit |');
    expect(result.stdout).toContain('| pkg-a | PASS 3/3 |');
    expect(result.stderr).toContain('strict mode');
    expect(result.stderr).toContain('missing: no test-result record found');
  });

  it('renders HTML cells with status classes and preserves the output path boundary', async () => {
    const root = repository();
    const dir = join(root, '.devai/state/test-results');
    const record = (id: string, tier: 'coverage' | 'mutation', metrics: object) => ({
      schemaVersion: '1.0.0',
      id,
      scope: 'pkg-html',
      tier,
      status: 'pass',
      timestamp: `2026-09-09T10:0${id.endsWith('c') ? '3' : '4'}:00.000Z`,
      metrics,
      command: 'pnpm test',
      exit_code: 0,
    });
    writeFileSync(
      join(dir, 'coverage.json'),
      JSON.stringify(record('coverage-c', 'coverage', { coverage_pct: { lines: 81.2 } })),
    );
    writeFileSync(
      join(dir, 'mutation.json'),
      JSON.stringify(record('mutation-m', 'mutation', { mutation_score: 72 })),
    );
    writeFileSync(
      join(root, 'thresholds.json'),
      JSON.stringify({ coverage: { lines: 80 }, mutation: { score_min: 70 } }),
    );
    const out = 'reports/nested/matrix.html';
    const result = await invoke(root, [
      'render-matrix',
      '--repo-root',
      root,
      '--format',
      'html',
      '--out',
      out,
      '--human',
      '--include-thresholds',
      '--thresholds-path',
      'thresholds.json',
    ]);
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain(`wrote 1 scope(s) × 2 tier(s) → ${out}`);
    expect(result.stdout).not.toContain('<!doctype html>');
    const html = readFileSync(join(root, out), 'utf8');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('cell-pass');
    expect(html).toContain('PASS 81.2% / req 80.0%');
    expect(html).toContain('PASS 72.0% / req 70.0%');

    const rawOut = 'reports/raw.html';
    const rawResult = await invoke(root, [
      'render-matrix',
      '--repo-root',
      root,
      '--format',
      'html',
      '--out',
      rawOut,
    ]);
    expect(rawResult.exit).toBe(0);
    expect(rawResult.stdout).toBe('');
    expect(readFileSync(join(root, rawOut), 'utf8')).toContain('<!doctype html>');
  });

  it('renders duration presets and explicit duration values at each display boundary', async () => {
    const root = repository();
    const dir = join(root, '.devai/state/test-results');
    const record = (id: string, timestamp: string, duration_ms: number) => ({
      schemaVersion: '1.0.0',
      id,
      scope: `scope-${id}`,
      tier: 'unit',
      status: 'pass',
      timestamp,
      metrics: { passed: 1, failed: 0, duration_ms },
      command: 'pnpm test',
      exit_code: 0,
    });
    writeFileSync(
      join(dir, 'short.json'),
      JSON.stringify(record('short', '2026-09-09T10:00:00.000Z', 500)),
    );
    writeFileSync(
      join(dir, 'seconds.json'),
      JSON.stringify(record('seconds', '2026-09-09T10:01:00.000Z', 1500)),
    );
    writeFileSync(
      join(dir, 'minutes.json'),
      JSON.stringify(record('minutes', '2026-09-09T10:02:00.000Z', 70_000)),
    );
    const explicit = await invoke(root, [
      'render-matrix',
      '--repo-root',
      root,
      '--include-duration',
    ]);
    expect(explicit.exit).toBe(0);
    expect(explicit.stdout).toContain('PASS 500ms');
    expect(explicit.stdout).toContain('PASS 1.5s');
    expect(explicit.stdout).toContain('PASS 1m 10s');
    const preset = await invoke(root, ['render-matrix', '--repo-root', root, '--view', 'timings']);
    expect(preset.exit).toBe(0);
    expect(preset.stdout).toContain('PASS 1.5s');
  });

  it('renders threshold annotations before strict below-threshold failure', async () => {
    const root = repository();
    const dir = join(root, '.devai/state/test-results');
    writeFileSync(
      join(dir, 'coverage.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        id: 'coverage-low',
        scope: 'pkg-threshold',
        tier: 'coverage',
        status: 'pass',
        timestamp: '2026-09-09T10:00:00.000Z',
        metrics: { coverage_pct: { lines: 74.9 } },
      }),
    );
    writeFileSync(
      join(dir, 'coverage-equal.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        id: 'coverage-equal',
        scope: 'pkg-threshold-equal',
        tier: 'coverage',
        status: 'pass',
        timestamp: '2026-09-09T10:00:00.000Z',
        metrics: { coverage_pct: { lines: 75 } },
      }),
    );
    writeFileSync(join(root, 'thresholds.json'), JSON.stringify({ coverage: { lines: 75 } }));
    const result = await invoke(root, [
      'render-matrix',
      '--repo-root',
      root,
      '--include-thresholds',
      '--thresholds-path',
      'thresholds.json',
      '--strict',
    ]);
    expect(result.exit).toBe(2);
    expect(result.stdout).toContain('PASS 74.9% / req 75.0%');
    expect(result.stdout).toContain('PASS 75.0% / req 75.0%');
    expect(result.stderr).toContain('below threshold: coverage 74.9% < required 75.0%');
    expect(result.stderr).not.toContain('[pkg-threshold-equal/coverage]');
  });

  it('applies configured scope inclusion, exclusion, and N/A overrides', async () => {
    const root = repository();
    const dir = join(root, '.devai/state/test-results');
    const base = (id: string, scope: string) => ({
      schemaVersion: '1.0.0',
      id,
      scope,
      tier: 'unit',
      status: 'pass',
      timestamp: '2026-09-09T10:00:00.000Z',
      metrics: { passed: 2, failed: 0 },
    });
    writeFileSync(join(dir, 'included.json'), JSON.stringify(base('included', 'pkg/included')));
    writeFileSync(join(dir, 'excluded.json'), JSON.stringify(base('excluded', 'pkg/excluded')));
    writeFileSync(
      join(root, 'matrix.json'),
      JSON.stringify({
        tiers: ['unit', 'coverage'],
        scopes_include: ['pkg/**'],
        scopes_exclude: ['pkg/excluded'],
        na_overrides: [{ scope: 'pkg/included', tier: 'coverage', reason: 'not applicable' }],
      }),
    );
    const result = await invoke(root, [
      'render-matrix',
      '--repo-root',
      root,
      '--config',
      'matrix.json',
    ]);
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain('| pkg/included | PASS 2/2 | N/A |');
    expect(result.stdout).not.toContain('pkg/excluded');
  });
});
