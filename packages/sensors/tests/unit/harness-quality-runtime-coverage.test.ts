// Invariants: INV-DEVAI-001, INV-DEVAI-012, INV-DEVAI-017
/**
 * Behaviour coverage for the three F5 harness-quality sensors that observe CI
 * itself: `harness_green_main` (F5×T9), `harness_coverage` (F5×T1) and
 * `harness_performance` (F5×T7).
 *
 * All three reach the host only through the authority `spawnSync` seam (`gh`
 * for the two runtime sensors, `git ls-files` for the coverage sensor), so the
 * seam is stubbed per case and the exact argv is asserted. `harness_coverage`
 * additionally parses real workflow YAML off disk, so its fixtures are real
 * files under a per-case temporary root; an unreadable workflow is simulated by
 * failing `readFileSync` for one exact path rather than by changing file modes
 * (acceptance runs as root, where mode bits do not deny reads).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  /** Absolute paths whose `readFileSync` must fail for the current case. */
  readFaults: new Set<string>(),
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: mocks.spawnSync,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { resolve: resolvePath } = await import('node:path');
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      const target = args[0];
      if (typeof target === 'string' && mocks.readFaults.has(resolvePath(target))) {
        throw Object.assign(new Error(`EACCES: injected read fault for ${target}`), {
          code: 'EACCES',
        });
      }
      return actual.readFileSync(...args);
    }) as typeof actual.readFileSync,
  };
});

import { senseHarnessGreenMain } from '../../src/harness-green-main.js';
import { senseHarnessCoverage } from '../../src/harness-coverage.js';
import { senseHarnessPerformance } from '../../src/harness-performance.js';
import type { SensorReading } from '../../src/sensor-reading.js';

const NOW = '2026-09-08T12:00:00.000Z';

interface SpawnResult {
  status: number | null;
  signal: null;
  stdout: string;
  stderr: string | undefined;
  error: NodeJS.ErrnoException | undefined;
}

const roots: string[] = [];

beforeEach(() => {
  mocks.spawnSync.mockReset();
  mocks.spawnSync.mockImplementation((command: string) => {
    throw new Error(`unstubbed spawnSync call: ${command}`);
  });
});

afterEach(() => {
  mocks.readFaults.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-harness-quality-'));
  roots.push(root);
  return root;
}

/** Write inside `root` only; a traversing relative path is refused outright. */
function write(root: string, rel: string, contents: string): string {
  const path = resolve(root, rel);
  if (path !== root && !path.startsWith(root + sep)) {
    throw new Error(`fixture writer refused a path outside ${root}: ${rel}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

function spawnResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return { status: 0, signal: null, stdout: '', stderr: '', error: undefined, ...overrides };
}

/** Stub the authority seam per binary; any other binary is a test failure. */
function stubCommands(handlers: Readonly<Record<string, SpawnResult>>): void {
  mocks.spawnSync.mockImplementation((command: string) => {
    const handler = handlers[command];
    if (handler === undefined) throw new Error(`unexpected spawnSync call: ${command}`);
    return handler;
  });
}

function ghJson(value: unknown): SpawnResult {
  return spawnResult({ stdout: JSON.stringify(value) });
}

function gitFiles(files: readonly string[]): SpawnResult {
  return spawnResult({ stdout: files.map((f) => `${f}\n`).join('') });
}

function enoent(): SpawnResult {
  return spawnResult({
    status: null,
    error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }),
  });
}

function codes(reading: SensorReading): readonly string[] {
  return (reading.findings ?? []).map((finding) => finding.code);
}

function message(reading: SensorReading, code: string): string | undefined {
  return (reading.findings ?? []).find((finding) => finding.code === code)?.message;
}

function argvOf(callIndex: number): readonly string[] {
  return mocks.spawnSync.mock.calls[callIndex]?.[1] as readonly string[];
}

describe('harness green-main sensor', () => {
  interface GhRunFixture {
    conclusion?: string;
    createdAt?: string;
  }

  function runs(count: number, successes: number, createdAt?: string): GhRunFixture[] {
    return Array.from({ length: count }, (_, i) => ({
      conclusion: i < successes ? 'success' : 'failure',
      ...(createdAt !== undefined && { createdAt }),
    }));
  }

  it('emits unknown with the default argv when the gh binary is missing', () => {
    stubCommands({ gh: enoent() });

    const reading = senseHarnessGreenMain({ repoRoot: '/repo', now: NOW });

    expect(reading).toMatchObject({
      sensor: { name: 'harness-green-main', kind: 'harness_green_main' },
      status: 'unknown',
      deterministic: false,
      tier: 'L2',
      timestamp: NOW,
      command: 'gh run list --branch main --json conclusion,createdAt --limit 50',
      findings: [
        {
          severity: 'info',
          code: 'HARNESS_GREEN_MAIN_GH_UNAVAILABLE',
          message: 'Skipped: gh-cli-unavailable',
        },
      ],
      metrics: { run_count: 0, success_pct: 0 },
    });
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      'gh',
      ['run', 'list', '--branch', 'main', '--json', 'conclusion,createdAt', '--limit', '50'],
      expect.objectContaining({ cwd: '/repo', encoding: 'utf8', timeout: 30_000 }),
    );
  });

  it('separates a generic spawn failure from a missing binary', () => {
    stubCommands({
      gh: spawnResult({
        status: null,
        error: Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      }),
    });

    const reading = senseHarnessGreenMain({ repoRoot: '/repo', now: NOW });

    expect(reading.status).toBe('unknown');
    expect(message(reading, 'HARNESS_GREEN_MAIN_GH_UNAVAILABLE')).toBe(
      'Skipped: gh-cli-error: permission denied',
    );
  });

  it('truncates non-zero-exit stderr to 256 characters verbatim', () => {
    stubCommands({ gh: spawnResult({ status: 1, stderr: `  ${'x'.repeat(300)}` }) });

    const reading = senseHarnessGreenMain({ repoRoot: '/repo', now: NOW });

    // Not trimmed: the leading spaces are part of the 256-character window.
    expect(message(reading, 'HARNESS_GREEN_MAIN_GH_UNAVAILABLE')).toBe(
      `Skipped: gh-cli-nonzero-exit:   ${'x'.repeat(254)}`,
    );
  });

  it('treats absent stderr as empty on a non-zero exit', () => {
    stubCommands({ gh: spawnResult({ status: 1, stderr: undefined }) });

    expect(
      message(
        senseHarnessGreenMain({ repoRoot: '/repo', now: NOW }),
        'HARNESS_GREEN_MAIN_GH_UNAVAILABLE',
      ),
    ).toBe('Skipped: gh-cli-nonzero-exit: ');
  });

  it('emits unknown when stdout is not JSON', () => {
    stubCommands({ gh: spawnResult({ stdout: '{not json' }) });

    const reading = senseHarnessGreenMain({ repoRoot: '/repo', now: NOW });

    expect(reading.status).toBe('unknown');
    expect(message(reading, 'HARNESS_GREEN_MAIN_GH_UNAVAILABLE')).toMatch(
      /^Skipped: gh-cli-parse-error: /u,
    );
  });

  it('reviews an empty run list and reports the unfiltered window in the message', () => {
    stubCommands({ gh: ghJson([]) });

    const reading = senseHarnessGreenMain({
      repoRoot: '/repo',
      branch: 'release',
      limit: 7,
      now: NOW,
    });

    expect(reading).toMatchObject({
      status: 'review',
      findings: [
        {
          severity: 'warning',
          code: 'HARNESS_GREEN_MAIN_NO_RUNS',
          message: 'No CI runs found for branch release in the last 7 entries.',
        },
      ],
    });
    expect(reading.metrics).toEqual({ run_count: 0, success_pct: 0 });
  });

  it('reviews an empty post-since window and flags that the filter ran', () => {
    stubCommands({ gh: ghJson(runs(3, 3, '2026-08-01T00:00:00Z')) });

    const reading = senseHarnessGreenMain({
      repoRoot: '/repo',
      since: '2026-09-01T00:00:00Z',
      now: NOW,
    });

    expect(reading.status).toBe('review');
    expect(message(reading, 'HARNESS_GREEN_MAIN_NO_RUNS')).toBe(
      'No CI runs found for branch main since 2026-09-01T00:00:00Z (within the last 50 entries).',
    );
    expect(reading.metrics).toEqual({ run_count: 0, success_pct: 0, since_filter_applied: 1 });
  });

  it('passes at exactly the 95% pass threshold with no findings', () => {
    stubCommands({ gh: ghJson(runs(20, 19)) });

    const reading = senseHarnessGreenMain({ repoRoot: '/repo', now: NOW });

    expect(reading.status).toBe('pass');
    expect(reading.findings).toEqual([]);
    expect(reading.metrics).toEqual({
      run_count: 20,
      success_count: 19,
      success_pct: 95,
      threshold_pass: 95,
      threshold_review: 80,
    });
  });

  it('reviews at exactly the 80% review threshold', () => {
    stubCommands({ gh: ghJson(runs(20, 16)) });

    const reading = senseHarnessGreenMain({ repoRoot: '/repo', now: NOW });

    expect(reading.status).toBe('review');
    expect(reading.findings?.[0]?.severity).toBe('warning');
    expect(message(reading, 'HARNESS_GREEN_MAIN_PARTIAL')).toBe(
      'Main branch success rate 80.0% (over last 20 runs) is below pass threshold 95%.',
    );
  });

  it('fails below the review threshold with an error finding', () => {
    stubCommands({ gh: ghJson(runs(20, 15)) });

    const reading = senseHarnessGreenMain({ repoRoot: '/repo', now: NOW });

    expect(reading.status).toBe('fail');
    expect(reading.findings?.[0]?.severity).toBe('error');
    expect(message(reading, 'HARNESS_GREEN_MAIN_BELOW_THRESHOLD')).toBe(
      'Main branch success rate 75.0% (over last 20 runs) is below review threshold 80%.',
    );
  });

  it('rounds success_pct to two decimals and the message to one', () => {
    stubCommands({ gh: ghJson(runs(3, 2)) });

    const reading = senseHarnessGreenMain({ repoRoot: '/repo', now: NOW });

    expect(reading.metrics?.success_pct).toBe(66.67);
    expect(message(reading, 'HARNESS_GREEN_MAIN_BELOW_THRESHOLD')).toContain('66.7%');
  });

  it('counts only runs whose conclusion is exactly success', () => {
    stubCommands({
      gh: ghJson([
        { conclusion: 'success' },
        { conclusion: 'SUCCESS' },
        { conclusion: 'failure' },
        { conclusion: 'cancelled' },
        {},
      ]),
    });

    const reading = senseHarnessGreenMain({ repoRoot: '/repo', now: NOW });

    expect(reading.metrics).toMatchObject({ run_count: 5, success_count: 1, success_pct: 20 });
    expect(reading.status).toBe('fail');
  });

  it('honours custom thresholds over the defaults', () => {
    stubCommands({ gh: ghJson(runs(20, 15)) });

    const reading = senseHarnessGreenMain({
      repoRoot: '/repo',
      thresholds: { pass: 75, review: 50 },
      now: NOW,
    });

    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({ threshold_pass: 75, threshold_review: 50 });
  });

  it('passes --created server-side and still filters createdAt client-side', () => {
    stubCommands({
      gh: ghJson([
        { conclusion: 'success', createdAt: '2026-09-05T00:00:00Z' },
        { conclusion: 'success', createdAt: '2026-09-01T00:00:00Z' },
        { conclusion: 'failure', createdAt: '2026-08-31T23:59:59Z' },
        { conclusion: 'success' },
        { conclusion: 'success', createdAt: '2026-09-06T00:00:00Z' },
        { conclusion: 'failure', createdAt: '2026-09-07T00:00:00Z' },
      ]),
    });

    const reading = senseHarnessGreenMain({
      repoRoot: '/repo',
      since: '2026-09-01T00:00:00Z',
      minSampleSize: 2,
      now: NOW,
    });

    expect(argvOf(0)).toEqual([
      'run',
      'list',
      '--branch',
      'main',
      '--json',
      'conclusion,createdAt',
      '--limit',
      '50',
      '--created',
      '>=2026-09-01T00:00:00Z',
    ]);
    // The undated run and the pre-window run are both dropped.
    expect(reading.metrics).toEqual({
      run_count: 4,
      success_count: 3,
      success_pct: 75,
      threshold_pass: 95,
      threshold_review: 80,
      since_filter_applied: 1,
      min_sample_size: 2,
    });
    expect(reading.status).toBe('fail');
  });

  it('suppresses the verdict below the default min sample size', () => {
    stubCommands({ gh: ghJson(runs(4, 4, '2026-09-02T00:00:00Z')) });

    const reading = senseHarnessGreenMain({
      repoRoot: '/repo',
      since: '2026-09-01T00:00:00Z',
      now: NOW,
    });

    expect(reading.status).toBe('unknown');
    expect(message(reading, 'HARNESS_GREEN_MAIN_INSUFFICIENT_SAMPLE_POST_FILTER')).toBe(
      'Only 4 run(s) since 2026-09-01T00:00:00Z; below min_sample_size 5. Verdict suppressed.',
    );
    expect(reading.metrics).toEqual({
      run_count: 4,
      success_pct: 0,
      min_sample_size: 5,
      since_filter_applied: 1,
    });
  });

  it('emits a real verdict at exactly the min sample size', () => {
    stubCommands({ gh: ghJson(runs(5, 5, '2026-09-02T00:00:00Z')) });

    const reading = senseHarnessGreenMain({
      repoRoot: '/repo',
      since: '2026-09-01T00:00:00Z',
      now: NOW,
    });

    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({ run_count: 5, success_pct: 100, min_sample_size: 5 });
  });

  it('honours a custom min sample size', () => {
    stubCommands({ gh: ghJson(runs(6, 6, '2026-09-02T00:00:00Z')) });

    const reading = senseHarnessGreenMain({
      repoRoot: '/repo',
      since: '2026-09-01T00:00:00Z',
      minSampleSize: 7,
      now: NOW,
    });

    expect(reading.status).toBe('unknown');
    expect(codes(reading)).toEqual(['HARNESS_GREEN_MAIN_INSUFFICIENT_SAMPLE_POST_FILTER']);
    expect(reading.metrics).toMatchObject({ min_sample_size: 7 });
  });

  it('never applies the sample guard without a since window', () => {
    stubCommands({ gh: ghJson(runs(1, 1)) });

    const reading = senseHarnessGreenMain({ repoRoot: '/repo', now: NOW });

    expect(reading.status).toBe('pass');
    expect(reading.metrics).not.toHaveProperty('min_sample_size');
    expect(reading.metrics).not.toHaveProperty('since_filter_applied');
  });

  it('stamps the current time when no timestamp is supplied', () => {
    stubCommands({ gh: ghJson(runs(1, 1)) });

    const reading = senseHarnessGreenMain({ repoRoot: '/repo' });

    expect(Number.isFinite(Date.parse(reading.timestamp))).toBe(true);
  });
});

describe('harness coverage sensor', () => {
  function workflow(opts: { paths?: readonly string[]; ignore?: readonly string[] } = {}): string {
    const lines = ['name: ci', 'on:', '  push:'];
    if (opts.paths !== undefined) {
      lines.push('    paths:');
      for (const p of opts.paths) lines.push(`      - '${p}'`);
    }
    if (opts.ignore !== undefined) {
      lines.push('    paths-ignore:');
      for (const p of opts.ignore) lines.push(`      - '${p}'`);
    }
    lines.push(
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo hi',
      '',
    );
    return lines.join('\n');
  }

  function writeWorkflow(
    root: string,
    name: string,
    opts: { paths?: readonly string[]; ignore?: readonly string[] } = {},
    dir = '.github/workflows',
  ): string {
    return write(root, join(dir, name), workflow(opts));
  }

  it('reviews without touching git when no workflow directory exists', () => {
    const root = fixtureRoot();

    const reading = senseHarnessCoverage({ repoRoot: root, now: NOW });

    expect(reading).toMatchObject({
      sensor: { name: 'harness-coverage', kind: 'harness_coverage' },
      status: 'review',
      deterministic: true,
      tier: 'L0',
      timestamp: NOW,
      command: 'devai sense-harness-coverage',
      findings: [
        {
          severity: 'info',
          code: 'HARNESS_COVERAGE_NO_WORKFLOWS',
          message: 'No workflow files found.',
        },
      ],
    });
    expect(reading.metrics).toEqual({
      workflow_count: 0,
      total_files: 0,
      covered_files: 0,
      coverage_pct: 0,
    });
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it('short-circuits to pass when any workflow declares no path filter', () => {
    const root = fixtureRoot();
    writeWorkflow(root, 'filtered.yml', { paths: ['src/**'] });
    writeWorkflow(root, 'everything.yml');

    const reading = senseHarnessCoverage({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('pass');
    expect(reading.findings).toEqual([]);
    expect(reading.metrics).toEqual({
      workflow_count: 2,
      covered_by_unfiltered_workflow: 1,
      coverage_pct: 100,
    });
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it('counts tracked files against the union of every path filter', () => {
    const root = fixtureRoot();
    writeWorkflow(root, 'a.yml', { paths: ['packages/**'] });
    writeWorkflow(root, 'b.yml', { paths: ['docs/*.md'] });
    stubCommands({
      git: gitFiles([
        'packages/sensors/src/a.ts',
        'docs/readme.md',
        'docs/nested/deep.md',
        'README.md',
        'build.js',
      ]),
    });

    const reading = senseHarnessCoverage({ repoRoot: root, now: NOW });

    expect(mocks.spawnSync).toHaveBeenCalledWith(
      'git',
      ['ls-files'],
      expect.objectContaining({ cwd: root, encoding: 'utf8' }),
    );
    // `**` crosses separators, a single `*` does not: docs/nested/deep.md misses.
    expect(reading.metrics).toEqual({
      workflow_count: 2,
      total_files: 5,
      covered_files: 2,
      coverage_pct: 40,
      threshold_pass: 80,
      threshold_review: 50,
    });
    expect(reading.status).toBe('fail');
    expect(message(reading, 'HARNESS_COVERAGE_BELOW_THRESHOLD')).toBe(
      '40.0% coverage (below review 50%).',
    );
  });

  it('subtracts files matched by paths-ignore before counting coverage', () => {
    const root = fixtureRoot();
    writeWorkflow(root, 'a.yml', { paths: ['**'], ignore: ['docs/**'] });
    stubCommands({ git: gitFiles(['src/a.ts', 'src/b.ts', 'docs/x.md', 'docs/y.md']) });

    const reading = senseHarnessCoverage({ repoRoot: root, now: NOW });

    expect(reading.metrics).toMatchObject({
      total_files: 4,
      covered_files: 2,
      coverage_pct: 50,
    });
    expect(reading.status).toBe('review');
    expect(message(reading, 'HARNESS_COVERAGE_PARTIAL')).toBe(
      '50.0% of tracked files are covered by some workflow path filter (below pass 80%).',
    );
  });

  it('passes at exactly the 80% pass threshold', () => {
    const root = fixtureRoot();
    writeWorkflow(root, 'a.yml', { paths: ['src/**'] });
    stubCommands({
      git: gitFiles(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'other/e.ts']),
    });

    const reading = senseHarnessCoverage({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('pass');
    expect(reading.findings).toEqual([]);
    expect(reading.metrics).toMatchObject({ covered_files: 4, coverage_pct: 80 });
  });

  it('rounds coverage_pct to two decimals', () => {
    const root = fixtureRoot();
    writeWorkflow(root, 'a.yml', { paths: ['src/**'] });
    stubCommands({ git: gitFiles(['src/a.ts', 'docs/b.md', 'docs/c.md']) });

    const reading = senseHarnessCoverage({ repoRoot: root, now: NOW });

    expect(reading.metrics?.coverage_pct).toBe(33.33);
    expect(message(reading, 'HARNESS_COVERAGE_BELOW_THRESHOLD')).toBe(
      '33.3% coverage (below review 50%).',
    );
  });

  it('honours custom thresholds', () => {
    const root = fixtureRoot();
    writeWorkflow(root, 'a.yml', { paths: ['src/**'] });
    stubCommands({ git: gitFiles(['src/a.ts', 'docs/b.md', 'docs/c.md']) });

    const reading = senseHarnessCoverage({
      repoRoot: root,
      thresholds: { pass: 30, review: 10 },
      now: NOW,
    });

    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({ threshold_pass: 30, threshold_review: 10 });
  });

  it('anchors path-filter globs at both ends', () => {
    const root = fixtureRoot();
    writeWorkflow(root, 'a.yml', { paths: ['src/*.ts'] });
    stubCommands({ git: gitFiles(['src/a.ts', 'vendor/src/a.ts', 'src/a.ts.bak']) });

    const reading = senseHarnessCoverage({ repoRoot: root, now: NOW });

    expect(reading.metrics).toMatchObject({ total_files: 3, covered_files: 1 });
  });

  it('escapes regex metacharacters inside path filters', () => {
    const root = fixtureRoot();
    writeWorkflow(root, 'a.yml', { paths: ['a+b/x.ts', 'docs/a.md'] });
    stubCommands({
      git: gitFiles(['a+b/x.ts', 'aab/x.ts', 'aaab/x.ts', 'docs/a.md', 'docs/aXmd']),
    });

    const reading = senseHarnessCoverage({ repoRoot: root, now: NOW });

    // Unescaped, `a+b` would claim aab/x.ts and aaab/x.ts while losing the
    // literal a+b/x.ts, and `a.md` would also claim docs/aXmd — four covered
    // files instead of the two the filters literally name.
    expect(reading.metrics).toMatchObject({ total_files: 5, covered_files: 2 });
  });

  it('ignores non-YAML entries in the workflow directory', () => {
    const root = fixtureRoot();
    writeWorkflow(root, 'a.yml', { paths: ['src/**'] });
    writeWorkflow(root, 'b.yaml', { paths: ['docs/**'] });
    write(root, '.github/workflows/notes.txt', workflow({ paths: ['**'] }));
    stubCommands({ git: gitFiles(['src/a.ts', 'docs/b.md', 'other/c.txt']) });

    const reading = senseHarnessCoverage({ repoRoot: root, now: NOW });

    expect(reading.metrics).toMatchObject({ workflow_count: 2, covered_files: 2, total_files: 3 });
  });

  it('reads workflows from a relative workflow-dir override', () => {
    const root = fixtureRoot();
    writeWorkflow(root, 'a.yml', { paths: ['src/**'] }, 'ci/flows');
    stubCommands({ git: gitFiles(['src/a.ts', 'docs/b.md']) });

    const reading = senseHarnessCoverage({ repoRoot: root, workflowDir: 'ci/flows', now: NOW });

    expect(reading.metrics).toMatchObject({ workflow_count: 1, covered_files: 1 });
  });

  it('reads workflows from an absolute workflow-dir override', () => {
    const root = fixtureRoot();
    writeWorkflow(root, 'a.yml', { paths: ['src/**'] }, 'ci/flows');
    stubCommands({ git: gitFiles(['src/a.ts', 'docs/b.md']) });

    const reading = senseHarnessCoverage({
      repoRoot: root,
      workflowDir: join(root, 'ci/flows'),
      now: NOW,
    });

    expect(reading.metrics).toMatchObject({ workflow_count: 1, covered_files: 1 });
  });

  it('skips exactly the workflow whose read fails and keeps the rest', () => {
    const root = fixtureRoot();
    writeWorkflow(root, 'a.yml', { paths: ['src/**'] });
    const unreadable = writeWorkflow(root, 'b.yml', { paths: ['docs/**'] });
    mocks.readFaults.add(unreadable);
    stubCommands({ git: gitFiles(['src/a.ts', 'docs/b.md']) });

    const reading = senseHarnessCoverage({ repoRoot: root, now: NOW });

    expect(reading.metrics).toMatchObject({ workflow_count: 1, covered_files: 1, total_files: 2 });
  });

  it('reviews as workflow-less when every workflow read fails', () => {
    const root = fixtureRoot();
    mocks.readFaults.add(writeWorkflow(root, 'a.yml', { paths: ['src/**'] }));
    mocks.readFaults.add(writeWorkflow(root, 'b.yml', { paths: ['docs/**'] }));

    const reading = senseHarnessCoverage({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('review');
    expect(codes(reading)).toEqual(['HARNESS_COVERAGE_NO_WORKFLOWS']);
  });

  it('reports zero coverage when git ls-files exits non-zero', () => {
    const root = fixtureRoot();
    writeWorkflow(root, 'a.yml', { paths: ['src/**'] });
    stubCommands({ git: spawnResult({ status: 128, stdout: '', stderr: 'not a git repo' }) });

    const reading = senseHarnessCoverage({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('fail');
    expect(reading.metrics).toMatchObject({ total_files: 0, covered_files: 0, coverage_pct: 0 });
  });

  it('drops blank lines from the git ls-files output', () => {
    const root = fixtureRoot();
    writeWorkflow(root, 'a.yml', { paths: ['src/**'] });
    stubCommands({ git: spawnResult({ stdout: 'src/a.ts\n\ndocs/b.md\n' }) });

    const reading = senseHarnessCoverage({ repoRoot: root, now: NOW });

    expect(reading.metrics).toMatchObject({ total_files: 2, covered_files: 1, coverage_pct: 50 });
  });

  it('refuses fixture writes that escape the temporary root', () => {
    const root = fixtureRoot();

    expect(() => write(root, '../escaped.yml', 'name: ci\n')).toThrow(
      /fixture writer refused a path outside/u,
    );
  });
});

describe('harness performance sensor', () => {
  const START = '2026-09-01T00:00:00.000Z';

  function successRun(durationMs: number, startIso = START) {
    const start = Date.parse(startIso);
    return {
      conclusion: 'success',
      createdAt: new Date(start).toISOString(),
      updatedAt: new Date(start + durationMs).toISOString(),
    };
  }

  it('emits unknown with the default argv when the gh binary is missing', () => {
    stubCommands({ gh: enoent() });

    const reading = senseHarnessPerformance({ repoRoot: '/repo', now: NOW });

    expect(reading).toMatchObject({
      sensor: { name: 'harness-performance', kind: 'harness_performance' },
      status: 'unknown',
      deterministic: false,
      tier: 'L2',
      timestamp: NOW,
      command: 'gh run list --branch main --json conclusion,createdAt,updatedAt --limit 50',
      findings: [
        {
          severity: 'info',
          code: 'HARNESS_PERFORMANCE_GH_UNAVAILABLE',
          message: 'Skipped: gh-cli-unavailable',
        },
      ],
      metrics: { run_count: 0 },
    });
    expect(argvOf(0)).toEqual([
      'run',
      'list',
      '--branch',
      'main',
      '--json',
      'conclusion,createdAt,updatedAt',
      '--limit',
      '50',
    ]);
  });

  it('trims the stderr excerpt on a non-zero exit', () => {
    stubCommands({ gh: spawnResult({ status: 1, stderr: '  gh: auth required \n' }) });

    const reading = senseHarnessPerformance({ repoRoot: '/repo', now: NOW });

    expect(message(reading, 'HARNESS_PERFORMANCE_GH_UNAVAILABLE')).toBe(
      'Skipped: gh-cli-nonzero-exit: gh: auth required',
    );
  });

  it('emits unknown when stdout is not JSON', () => {
    stubCommands({ gh: spawnResult({ stdout: 'not json' }) });

    const reading = senseHarnessPerformance({ repoRoot: '/repo', now: NOW });

    expect(reading.status).toBe('unknown');
    expect(message(reading, 'HARNESS_PERFORMANCE_GH_UNAVAILABLE')).toMatch(
      /^Skipped: gh-cli-parse-error: /u,
    );
  });

  it('reports an absent measurement for an empty run list', () => {
    stubCommands({ gh: ghJson([]) });

    const reading = senseHarnessPerformance({ repoRoot: '/repo', now: NOW });

    expect(reading.status).toBe('unknown');
    expect(message(reading, 'HARNESS_PERFORMANCE_NO_SUCCESS_RUNS')).toBe(
      'No successful runs found on branch main (last 0 entries).',
    );
    expect(reading.metrics).toEqual({ run_count: 0, success_count: 0 });
  });

  it('reviews when every run failed but still counts them', () => {
    stubCommands({
      gh: ghJson([
        { conclusion: 'failure', createdAt: START, updatedAt: START },
        { conclusion: 'cancelled', createdAt: START, updatedAt: START },
        { createdAt: START, updatedAt: START },
      ]),
    });

    const reading = senseHarnessPerformance({ repoRoot: '/repo', branch: 'dev', now: NOW });

    expect(reading.status).toBe('review');
    expect(message(reading, 'HARNESS_PERFORMANCE_NO_SUCCESS_RUNS')).toBe(
      'No successful runs found on branch dev (last 3 entries).',
    );
    expect(reading.metrics).toEqual({ run_count: 3, success_count: 0 });
  });

  it('drops successful runs with missing, unparsable or reversed timestamps', () => {
    stubCommands({
      gh: ghJson([
        { conclusion: 'success', updatedAt: START },
        { conclusion: 'success', createdAt: START },
        { conclusion: 'success', createdAt: 'not-a-date', updatedAt: START },
        { conclusion: 'success', createdAt: START, updatedAt: 'not-a-date' },
        {
          conclusion: 'success',
          createdAt: '2026-09-01T00:10:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      ]),
    });

    const reading = senseHarnessPerformance({ repoRoot: '/repo', now: NOW });

    expect(reading.status).toBe('review');
    expect(reading.metrics).toEqual({ run_count: 5, success_count: 0 });
  });

  it('keeps a zero-length successful run', () => {
    stubCommands({ gh: ghJson([successRun(0)]) });

    const reading = senseHarnessPerformance({ repoRoot: '/repo', now: NOW });

    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({
      run_count: 1,
      success_count: 1,
      median_ms: 0,
      p95_ms: 0,
    });
  });

  it('computes nearest-rank median and p95 over sorted durations', () => {
    stubCommands({
      gh: ghJson([
        successRun(400_000),
        successRun(100_000),
        { conclusion: 'failure', createdAt: START, updatedAt: START },
        successRun(300_000),
        successRun(200_000),
      ]),
    });

    const reading = senseHarnessPerformance({ repoRoot: '/repo', now: NOW });

    expect(reading.status).toBe('pass');
    expect(reading.findings).toEqual([]);
    expect(reading.metrics).toEqual({
      run_count: 5,
      success_count: 4,
      median_ms: 200_000,
      p95_ms: 400_000,
      pass_median_ms: 600_000,
      pass_p95_ms: 1_800_000,
    });
  });

  it('does not pass when the median sits exactly on the pass bound', () => {
    stubCommands({ gh: ghJson([successRun(600_000)]) });

    const reading = senseHarnessPerformance({ repoRoot: '/repo', now: NOW });

    expect(reading.status).toBe('review');
    expect(message(reading, 'HARNESS_PERFORMANCE_SLOW')).toBe(
      'median 600s, p95 600s — above pass thresholds.',
    );
  });

  it('does not pass when p95 sits exactly on the pass bound', () => {
    stubCommands({
      gh: ghJson([successRun(1_000), successRun(1_000), successRun(1_000), successRun(1_800_000)]),
    });

    const reading = senseHarnessPerformance({ repoRoot: '/repo', now: NOW });

    expect(reading.status).toBe('review');
    expect(reading.metrics).toMatchObject({ median_ms: 1_000, p95_ms: 1_800_000 });
  });

  it('fails when the median sits exactly on the review bound', () => {
    stubCommands({ gh: ghJson([successRun(1_200_000)]) });

    const reading = senseHarnessPerformance({ repoRoot: '/repo', now: NOW });

    expect(reading.status).toBe('fail');
    expect(reading.findings?.[0]?.severity).toBe('error');
    expect(message(reading, 'HARNESS_PERFORMANCE_TOO_SLOW')).toBe(
      'median 1200s, p95 1200s — above review thresholds.',
    );
  });

  it('fails when p95 sits exactly on the review bound', () => {
    stubCommands({
      gh: ghJson([successRun(1_000), successRun(1_000), successRun(1_000), successRun(3_600_000)]),
    });

    const reading = senseHarnessPerformance({ repoRoot: '/repo', now: NOW });

    expect(reading.status).toBe('fail');
    expect(message(reading, 'HARNESS_PERFORMANCE_TOO_SLOW')).toBe(
      'median 1s, p95 3600s — above review thresholds.',
    );
  });

  it('rounds the reported seconds to the nearest second', () => {
    stubCommands({ gh: ghJson([successRun(600_500)]) });

    expect(
      message(senseHarnessPerformance({ repoRoot: '/repo', now: NOW }), 'HARNESS_PERFORMANCE_SLOW'),
    ).toBe('median 601s, p95 601s — above pass thresholds.');
  });

  it('honours custom branch, limit and thresholds', () => {
    stubCommands({ gh: ghJson([successRun(700_000)]) });

    const reading = senseHarnessPerformance({
      repoRoot: '/repo',
      branch: 'release',
      limit: 5,
      thresholds: {
        passMedianMs: 800_000,
        passP95Ms: 900_000,
        reviewMedianMs: 1_000_000,
        reviewP95Ms: 1_100_000,
      },
      now: NOW,
    });

    expect(argvOf(0)).toEqual([
      'run',
      'list',
      '--branch',
      'release',
      '--json',
      'conclusion,createdAt,updatedAt',
      '--limit',
      '5',
    ]);
    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({ pass_median_ms: 800_000, pass_p95_ms: 900_000 });
  });

  it('stamps the current time when no timestamp is supplied', () => {
    stubCommands({ gh: ghJson([successRun(1_000)]) });

    const reading = senseHarnessPerformance({ repoRoot: '/repo' });

    expect(Number.isFinite(Date.parse(reading.timestamp))).toBe(true);
  });
});
