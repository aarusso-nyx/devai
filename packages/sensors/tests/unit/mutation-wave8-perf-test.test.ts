import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ runCommand: vi.fn() }));

vi.mock('../../src/run-command.js', () => ({ runCommand: mocks.runCommand }));

import { sensePerfTest } from '../../src/perf-test.js';

const NOW = '2026-09-08T12:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  mocks.runCommand.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(packageJson?: object): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-wave8-perf-'));
  roots.push(root);
  if (packageJson !== undefined)
    writeFileSync(join(root, 'package.json'), JSON.stringify(packageJson));
  return root;
}

function command(stdout: string, exit_code = 0, stderr = '') {
  return {
    command: ['pnpm', 'test:perf'],
    exit_code,
    signal: null,
    stdout,
    stderr,
    duration_ms: 12,
    killed: false,
  };
}

describe('wave8 perf-test graceful states and failure evidence', () => {
  it('reports missing package metadata without invoking the command', () => {
    const root = fixtureRoot();

    const reading = sensePerfTest({ repoRoot: root, now: NOW });
    expect(mocks.runCommand).not.toHaveBeenCalled();
    expect(reading).toMatchObject({
      status: 'unknown',
      deterministic: false,
      timestamp: NOW,
      command: 'pnpm test:perf',
      metrics: { script_name: 'test:perf' },
    });
    expect(reading.findings?.[0]?.code).toBe('PERF_TEST_NO_PACKAGE_JSON');
  });

  it('reports a missing perf script without invoking the command', () => {
    const root = fixtureRoot({ scripts: {} });

    const reading = sensePerfTest({ repoRoot: root, now: NOW });
    expect(mocks.runCommand).not.toHaveBeenCalled();
    expect(reading).toMatchObject({
      status: 'unknown',
      deterministic: false,
      timestamp: NOW,
      metrics: { script_name: 'test:perf', script_present: false },
    });
    expect(reading.findings?.[0]?.code).toBe('PERF_TEST_NO_PERF_SCRIPT');
  });

  it('retains the first stderr line when the perf script fails', () => {
    const root = fixtureRoot({ scripts: { 'test:perf': 'fixture' } });
    mocks.runCommand.mockReturnValueOnce(
      command('{"p50_ms":1}', 9, 'runner failed\nsecondary detail'),
    );

    const reading = sensePerfTest({ repoRoot: root, now: NOW });
    expect(reading).toMatchObject({ status: 'fail', exit_code: 9, metrics: { exit_code: 9 } });
    expect(reading.findings?.[0]).toMatchObject({
      code: 'PERF_TEST_SCRIPT_FAILED',
      message: 'test:perf exited 9: runner failed',
    });
  });
});

describe('wave8 perf-test threshold equality', () => {
  it('keeps p50 equal to reviewMax in review rather than fail', () => {
    const root = fixtureRoot({ scripts: { 'test:perf': 'fixture' } });
    mocks.runCommand.mockReturnValueOnce(command('{"p50_ms":20}'));

    const reading = sensePerfTest({
      repoRoot: root,
      now: NOW,
      thresholds: { pass_p50_ms: 10, review_p50_ms: 20 },
    });
    expect(reading.status).toBe('review');
    expect(reading.findings?.map((finding) => finding.code)).toEqual([
      'PERF_TEST_METRIC_OVER_PASS',
    ]);
  });

  it('keeps throughput equal to reviewMin in review via the pass threshold', () => {
    const root = fixtureRoot({ scripts: { 'test:perf': 'fixture' } });
    mocks.runCommand.mockReturnValueOnce(command('{"throughput_rps":70}'));

    const reading = sensePerfTest({
      repoRoot: root,
      now: NOW,
      thresholds: { pass_throughput_rps: 100, review_throughput_rps: 70 },
    });
    expect(reading.status).toBe('review');
    expect(reading.findings?.map((finding) => finding.code)).toEqual([
      'PERF_TEST_METRIC_UNDER_PASS',
    ]);
  });
});
