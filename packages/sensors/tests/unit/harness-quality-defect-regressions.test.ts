import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: mocks.spawnSync,
}));

import { senseHarnessCoverage } from '../../src/harness-coverage.js';
import { senseHarnessGreenMain } from '../../src/harness-green-main.js';
import { senseHarnessPerformance } from '../../src/harness-performance.js';

const NOW = '2026-09-08T12:00:00.000Z';
const roots: string[] = [];

beforeEach(() => {
  mocks.spawnSync.mockReset();
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-harness-quality-red-'));
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

function stubCommands(handlers: Readonly<Record<string, unknown>>): void {
  mocks.spawnSync.mockImplementation((command: string) => {
    const handler = handlers[command];
    if (handler === undefined) throw new Error(`unexpected spawnSync call: ${command}`);
    return handler;
  });
}

function ghJson(value: unknown) {
  return { status: 0, signal: null, stdout: JSON.stringify(value), stderr: '', error: undefined };
}

function gitFiles(files: readonly string[]) {
  return {
    status: 0,
    signal: null,
    stdout: files.map((f) => `${f}\n`).join(''),
    stderr: '',
    error: undefined,
  };
}

describe('round24 D1 — harness_performance reports "no runs found" as review, not unknown', () => {
  it('emits unknown when gh returns an empty run list', () => {
    stubCommands({ gh: ghJson([]) });

    const reading = senseHarnessPerformance({ repoRoot: '/repo', now: NOW });

    // Design note "PASS / REVIEW / FAIL boundaries": UNKNOWN covers both
    // "gh unavailable" and "no runs found". The emitter only honours the first
    // half and reviews the second, so an empty history reads as a soft verdict
    // rather than an absent measurement.
    expect(reading.status).toBe('unknown');
  });
});

describe('round24 D2 — a paths-ignore-only workflow is scored as full coverage', () => {
  it('does not count ignored files as covered when the only workflow ignores them', () => {
    const root = fixtureRoot();
    write(
      root,
      '.github/workflows/ci.yml',
      [
        'name: ci',
        'on:',
        '  push:',
        '    paths-ignore:',
        "      - 'docs/**'",
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo hi',
        '',
      ].join('\n'),
    );
    stubCommands({ git: gitFiles(['src/a.ts', 'docs/b.md']) });

    const reading = senseHarnessCoverage({ repoRoot: root, now: NOW });

    // The workflow never runs for docs/**, so docs/b.md is not covered by the
    // note's AND-clause. The emitter tests only `onPaths.length === 0` and
    // short-circuits to pass with coverage_pct = 100.
    expect(reading.metrics?.coverage_pct).toBe(50);
    expect(reading.metrics?.covered_files).toBe(1);
    expect(reading.status).toBe('review');
    expect(reading.metrics).not.toHaveProperty('covered_by_unfiltered_workflow');
  });
});

describe('round24 D3 — the since window compares ISO strings lexicographically', () => {
  it('excludes a run created before an offset-bearing since instant', () => {
    // 2026-09-01T18:00:00-06:00 is 2026-09-02T00:00:00Z, one hour AFTER the run.
    stubCommands({
      gh: ghJson([{ conclusion: 'success', createdAt: '2026-09-01T23:00:00Z' }]),
    });

    const reading = senseHarnessGreenMain({
      repoRoot: '/repo',
      since: '2026-09-01T18:00:00-06:00',
      now: NOW,
    });

    // String order puts '...T23' after '...T18', so the out-of-window run is
    // retained and the sensor reports a one-run sample instead of an empty one.
    expect((reading.findings ?? []).map((finding) => finding.code)).toEqual([
      'HARNESS_GREEN_MAIN_NO_RUNS',
    ]);
  });
});

it('includes equal ISO instants and excludes earlier or invalid run timestamps', () => {
  stubCommands({
    gh: ghJson([
      { conclusion: 'success', createdAt: '2026-09-02T00:00:00Z' },
      { conclusion: 'success', createdAt: '2026-09-02T03:00:00+03:00' },
      { conclusion: 'failure', createdAt: '2026-09-01T23:59:59Z' },
      { conclusion: 'failure', createdAt: 'invalid' },
      { conclusion: 'failure' },
    ]),
  });
  const reading = senseHarnessGreenMain({
    repoRoot: '/repo',
    since: '2026-09-01T18:00:00-06:00',
    minSampleSize: 2,
    now: NOW,
  });
  expect(reading.status).toBe('pass');
  expect(reading.metrics).toMatchObject({
    run_count: 2,
    success_count: 2,
    success_pct: 100,
    since_filter_applied: 1,
  });
});
