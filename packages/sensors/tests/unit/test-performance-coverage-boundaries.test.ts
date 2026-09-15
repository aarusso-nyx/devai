import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseTestPerformanceCoverage } from '../../src/test-performance-coverage.js';

const NOW = '2026-09-08T12:00:00.000Z';
let root: string;

function file(relative: string, contents = 'describe("ordinary", () => {});\n'): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function testFile(index: number, contents?: string): void {
  file(`packages/fixture/test/case-${index}.test.ts`, contents);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-test-performance-coverage-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('test performance coverage boundaries', () => {
  it('reviews an empty test population with zero metrics', () => {
    const reading = senseTestPerformanceCoverage({ repoRoot: root, now: NOW });

    expect(reading).toMatchObject({
      status: 'review',
      timestamp: NOW,
      sensor: { name: 'test-performance-coverage', kind: 'test_performance_coverage' },
      command: 'devai sense-test-performance-coverage',
      deterministic: true,
      tier: 'L0',
      metrics: { test_files: 0, perf_tests: 0, perf_pct: 0 },
      findings: [
        { severity: 'info', code: 'TEST_PERFORMANCE_NO_TESTS', message: 'No test files found.' },
      ],
    });
  });

  it('fails when test files exist but none match the default performance patterns', () => {
    testFile(1);
    testFile(2);

    const reading = senseTestPerformanceCoverage({ repoRoot: root, now: NOW });

    expect(reading).toMatchObject({
      status: 'fail',
      metrics: { test_files: 2, perf_tests: 0, perf_pct: 0 },
      findings: [
        {
          severity: 'error',
          code: 'TEST_PERFORMANCE_NO_PERF_TESTS',
          message: 'No test files matched perf patterns.',
        },
      ],
    });
  });

  it('passes at the exact one percent matched-file boundary', () => {
    for (let index = 1; index <= 100; index += 1) {
      testFile(index, index === 1 ? 'describe("perf", () => {});\n' : undefined);
    }

    const reading = senseTestPerformanceCoverage({ repoRoot: root, now: NOW });

    expect(reading).toMatchObject({
      status: 'pass',
      timestamp: NOW,
      findings: [],
      metrics: { test_files: 100, perf_tests: 1, perf_pct: 1 },
    });
  });

  it('reviews a nonzero match below one percent and honors custom roots and patterns', () => {
    for (let index = 1; index <= 101; index += 1) {
      file(
        `custom/group/case-${index}.test.ts`,
        index === 1 ? 'describe("custom-marker", () => {});\n' : undefined,
      );
    }

    const reading = senseTestPerformanceCoverage({
      repoRoot: root,
      testGlobs: ['custom/*'],
      extraPatterns: ['custom-marker'],
      now: NOW,
    });

    expect(reading).toMatchObject({
      status: 'review',
      timestamp: NOW,
      metrics: { test_files: 101, perf_tests: 1, perf_pct: 0.99 },
      findings: [
        {
          severity: 'warning',
          code: 'TEST_PERFORMANCE_LOW_COVERAGE',
          message: '1 perf tests across 101 total — below 1% threshold.',
        },
      ],
    });
  });
});
