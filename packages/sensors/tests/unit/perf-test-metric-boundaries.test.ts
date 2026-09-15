import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ runCommand: vi.fn() }));

vi.mock('../../src/run-command.js', () => ({ runCommand: mocks.runCommand }));

import { sensePerfTest } from '../../src/perf-test.js';

const NOW = '2026-09-09T00:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  mocks.runCommand.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.runCommand.mockReset();
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-wave52-perf-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { 'test:perf': 'fixture' } }),
  );
  return root;
}

function command(stdout: string) {
  return {
    command: ['pnpm', 'test:perf'],
    exit_code: 0,
    signal: null,
    stdout,
    stderr: '',
    duration_ms: 17,
    killed: false,
  };
}

describe('perf-test metric parsing boundaries', () => {
  it('requires numeric values for every supported metric field', () => {
    const root = fixtureRoot();
    for (const field of ['p50_ms', 'p95_ms', 'throughput_rps'] as const) {
      mocks.runCommand.mockReturnValueOnce(command(JSON.stringify({ [field]: 'not-a-number' })));

      const reading = sensePerfTest({ repoRoot: root, now: NOW });
      expect(reading).toMatchObject({
        status: 'pass',
        command: 'pnpm test:perf',
        exit_code: 0,
        duration_ms: 17,
        metrics: { script_name: 'test:perf', exit_code: 0, duration_ms: 17 },
      });
      expect(reading.metrics).not.toHaveProperty(field);
      expect(reading.findings).toEqual([
        {
          severity: 'info',
          code: 'PERF_TEST_NO_METRICS_PARSED',
          message: 'test:perf exited 0 but emitted no parseable JSON metrics line.',
        },
      ]);
    }
  });

  it('accepts indented metric JSON and ignores a later JSON object without metrics', () => {
    const root = fixtureRoot();
    mocks.runCommand.mockReturnValueOnce(command('  {"p50_ms":7}  \n{"log":"done"}\n'));

    const reading = sensePerfTest({ repoRoot: root, now: NOW });
    expect(reading).toMatchObject({
      status: 'pass',
      findings: [],
      metrics: { p50_ms: 7 },
    });
  });

  it('keeps a p95-only result when selecting the parseable metrics line', () => {
    const root = fixtureRoot();
    mocks.runCommand.mockReturnValueOnce(command('{"p95_ms":7}'));

    const reading = sensePerfTest({ repoRoot: root, now: NOW });
    expect(reading).toMatchObject({
      status: 'pass',
      findings: [],
      metrics: { p95_ms: 7 },
    });
  });
});

describe('perf-test threshold equality and status precedence', () => {
  it('keeps an upper-bound value equal to PASS at pass', () => {
    const root = fixtureRoot();
    mocks.runCommand.mockReturnValueOnce(command('{"p50_ms":10}'));

    const reading = sensePerfTest({
      repoRoot: root,
      now: NOW,
      thresholds: { pass_p50_ms: 10, review_p50_ms: 20 },
    });
    expect(reading).toMatchObject({ status: 'pass', metrics: { p50_ms: 10 } });
    expect(reading.findings).toEqual([]);
  });

  it('keeps a lower-bound value equal to PASS at pass', () => {
    const root = fixtureRoot();
    mocks.runCommand.mockReturnValueOnce(command('{"throughput_rps":100}'));

    const reading = sensePerfTest({
      repoRoot: root,
      now: NOW,
      thresholds: { pass_throughput_rps: 100, review_throughput_rps: 70 },
    });
    expect(reading).toMatchObject({ status: 'pass', metrics: { throughput_rps: 100 } });
    expect(reading.findings).toEqual([]);
  });

  it('retains FAIL when a later metric is only over its PASS threshold', () => {
    const root = fixtureRoot();
    mocks.runCommand.mockReturnValueOnce(command('{"p50_ms":21,"p95_ms":15}'));

    const reading = sensePerfTest({
      repoRoot: root,
      now: NOW,
      thresholds: {
        pass_p50_ms: 10,
        review_p50_ms: 20,
        pass_p95_ms: 10,
        review_p95_ms: 20,
      },
    });
    expect(reading.status).toBe('fail');
    expect(reading.findings?.map((finding) => finding.code)).toEqual([
      'PERF_TEST_METRIC_OVER_REVIEW',
      'PERF_TEST_METRIC_OVER_PASS',
    ]);
  });
});
