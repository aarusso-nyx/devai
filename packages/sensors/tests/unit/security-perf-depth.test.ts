// Invariants: INV-DEVAI-001, INV-DEVAI-012, INV-DEVAI-017
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  runCommand: vi.fn(),
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: mocks.spawnSync,
}));
vi.mock('../../src/run-command.js', () => ({ runCommand: mocks.runCommand }));

import { sensePerfTest } from '../../src/perf-test.js';
import { senseSecurityScan } from '../../src/security-scan.js';

const root = mkdtempSync(join(tmpdir(), 'devai-sensor-depth-'));
const now = '2026-07-27T00:00:00.000Z';

function audit(data: unknown, status = 0) {
  return { status, signal: null, stdout: JSON.stringify(data), stderr: '', error: undefined };
}

function command(stdout: string, exitCode = 0) {
  return {
    command: ['pnpm', 'test:perf'],
    exit_code: exitCode,
    signal: null,
    stdout,
    stderr: exitCode === 0 ? '' : 'failed\nmore',
    duration_ms: 12,
    killed: false,
  };
}

beforeEach(() => {
  mocks.spawnSync.mockReset();
  mocks.runCommand.mockReset();
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { 'test:perf': 'fixture' } }),
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('security scan depth', () => {
  it('grades clean, review, high-fail, and critical metadata summaries', () => {
    for (const [vulnerabilities, status, code] of [
      [{ critical: 0, high: 0, moderate: 1, low: 2, info: 3 }, 'pass', undefined],
      [{ critical: 0, high: 1 }, 'review', 'SECURITY_SCAN_HIGH_PRESENT'],
      [{ critical: 0, high: 6 }, 'fail', 'SECURITY_SCAN_HIGH_OVER_THRESHOLD'],
      [{ critical: 1, high: 0 }, 'fail', 'SECURITY_SCAN_CRITICAL_VULN'],
    ] as const) {
      mocks.spawnSync.mockReturnValueOnce(audit({ metadata: { vulnerabilities } }));
      const reading = senseSecurityScan({ repoRoot: root, now });
      expect(reading.status).toBe(status);
      expect(reading.findings?.[0]?.code).toBe(code);
    }
  });

  it('uses npm-shape advisories and the configured alternate tool', () => {
    mocks.spawnSync.mockReturnValueOnce(
      audit({
        vulnerabilities: {
          a: { severity: 'critical' },
          b: { severity: 'high' },
          c: { severity: 'moderate' },
          d: { severity: 'low' },
          e: { severity: 'info' },
          ignored: null,
          unknown: { severity: 'other' },
        },
      }),
    );
    const reading = senseSecurityScan({ repoRoot: root, preferredTool: 'npm', now });
    expect(reading).toMatchObject({ status: 'fail', metrics: { total_vulnerabilities: 5 } });
    expect(mocks.spawnSync).toHaveBeenCalledWith('npm', ['audit', '--json'], expect.any(Object));
  });

  it('falls back after missing, empty, invalid, and generic tool failures', () => {
    for (const first of [
      {
        status: null,
        signal: null,
        stdout: '',
        stderr: '',
        error: Object.assign(new Error('x'), { code: 'ENOENT' }),
      },
      { status: 0, signal: null, stdout: '', stderr: '', error: undefined },
      { status: 0, signal: null, stdout: '{', stderr: '', error: undefined },
      { status: null, signal: null, stdout: '', stderr: '', error: new Error('boom') },
    ]) {
      mocks.spawnSync
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(audit({ metadata: { vulnerabilities: {} } }));
      expect(senseSecurityScan({ repoRoot: root, now }).status).toBe('pass');
    }
    expect(mocks.spawnSync).toHaveBeenCalledTimes(8);
  });

  it('returns UNKNOWN when both audit tools are unavailable', () => {
    mocks.spawnSync.mockReturnValue({
      status: 0,
      signal: null,
      stdout: '',
      stderr: '',
      error: undefined,
    });
    const reading = senseSecurityScan({ repoRoot: root, now });
    expect(reading).toMatchObject({ status: 'unknown', metrics: { tools_tried: 2 } });
    expect(reading.findings?.[0]?.code).toBe('SECURITY_SCAN_NO_AUDIT_TOOL');
  });
});

describe('performance sensor depth', () => {
  it('reports unreadable package and absent script as UNKNOWN', () => {
    expect(sensePerfTest({ repoRoot: join(root, 'missing'), now }).findings?.[0]?.code).toBe(
      'PERF_TEST_NO_PACKAGE_JSON',
    );
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
    expect(sensePerfTest({ repoRoot: root, now }).findings?.[0]?.code).toBe(
      'PERF_TEST_NO_PERF_SCRIPT',
    );
  });

  it('reports command failure before evaluating metrics', () => {
    mocks.runCommand.mockReturnValueOnce(command('{"p50_ms":1}', 9));
    const reading = sensePerfTest({ repoRoot: root, timeoutMs: 123, now });
    expect(reading).toMatchObject({ status: 'fail', exit_code: 9, metrics: { exit_code: 9 } });
    expect(reading.findings?.[0]?.code).toBe('PERF_TEST_SCRIPT_FAILED');
    expect(mocks.runCommand).toHaveBeenCalledWith(['pnpm', 'test:perf'], {
      cwd: root,
      timeoutMs: 123,
    });
  });

  it('parses the last metrics line and grades upper and lower thresholds', () => {
    mocks.runCommand.mockReturnValueOnce(
      command('noise\n{bad}\n{"p50_ms":11,"p95_ms":25,"throughput_rps":80}\n'),
    );
    const review = sensePerfTest({
      repoRoot: root,
      now,
      thresholds: {
        pass_p50_ms: 10,
        review_p50_ms: 20,
        pass_p95_ms: 20,
        review_p95_ms: 30,
        pass_throughput_rps: 100,
        review_throughput_rps: 70,
      },
    });
    expect(review.status).toBe('review');
    expect(review.findings?.map((finding) => finding.code)).toEqual([
      'PERF_TEST_METRIC_OVER_PASS',
      'PERF_TEST_METRIC_OVER_PASS',
      'PERF_TEST_METRIC_UNDER_PASS',
    ]);

    mocks.runCommand.mockReturnValueOnce(command('{"p50_ms":21,"p95_ms":31,"throughput_rps":60}'));
    const failed = sensePerfTest({
      repoRoot: root,
      now,
      thresholds: {
        pass_p50_ms: 10,
        review_p50_ms: 20,
        pass_p95_ms: 20,
        review_p95_ms: 30,
        pass_throughput_rps: 100,
        review_throughput_rps: 70,
      },
    });
    expect(failed.status).toBe('fail');
    expect(failed.findings).toHaveLength(3);
  });

  it('passes partial metrics and notes successful output without parseable metrics', () => {
    mocks.runCommand.mockReturnValueOnce(command('{"p50_ms":1}\n'));
    expect(sensePerfTest({ repoRoot: root, now }).status).toBe('pass');
    mocks.runCommand.mockReturnValueOnce(command('log\n{}\n[not-json]\n'));
    const empty = sensePerfTest({ repoRoot: root, scriptName: 'test:perf', now });
    expect(empty.status).toBe('pass');
    expect(empty.findings?.[0]?.code).toBe('PERF_TEST_NO_METRICS_PARSED');
  });
});
