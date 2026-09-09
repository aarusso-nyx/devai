import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseTestRobustnessCoverage } from '../../src/test-robustness-coverage.js';

const NOW = '2026-09-08T12:00:00.000Z';
let root: string;

function write(relative: string, contents: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function testFile(index: number, contents = 'describe("ordinary", () => {});\n'): void {
  write(`packages/fixture/test/case-${index}.test.ts`, contents);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-test-robustness-coverage-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('test robustness coverage boundaries', () => {
  it('reviews an empty test population with exact metadata and zero metrics', () => {
    const reading = senseTestRobustnessCoverage({ repoRoot: root, now: NOW });

    expect(reading).toMatchObject({
      status: 'review',
      timestamp: NOW,
      sensor: { name: 'test-robustness-coverage', kind: 'test_robustness_coverage' },
      command: 'devai sense-test-robustness-coverage',
      deterministic: true,
      tier: 'L0',
      metrics: {
        test_files: 0,
        robust_tests: 0,
        robust_pct: 0,
        threshold_pass: 10,
        threshold_review: 5,
      },
      findings: [
        { severity: 'info', code: 'TEST_ROBUSTNESS_NO_TESTS', message: 'No test files found.' },
      ],
    });
  });

  it('passes at the exact ten percent default pass boundary', () => {
    for (let index = 1; index <= 10; index += 1) {
      testFile(index, index === 1 ? 'it("throws on invalid input", () => {});\n' : undefined);
    }

    const reading = senseTestRobustnessCoverage({ repoRoot: root, now: NOW });

    expect(reading).toMatchObject({
      status: 'pass',
      timestamp: NOW,
      findings: [],
      metrics: {
        test_files: 10,
        robust_tests: 1,
        robust_pct: 10,
        threshold_pass: 10,
        threshold_review: 5,
      },
    });
  });

  it('reviews at the exact five percent default review boundary', () => {
    for (let index = 1; index <= 20; index += 1) {
      testFile(index, index === 1 ? 'it("reject invalid input", () => {});\n' : undefined);
    }

    const reading = senseTestRobustnessCoverage({ repoRoot: root, now: NOW });

    expect(reading).toMatchObject({
      status: 'review',
      metrics: {
        test_files: 20,
        robust_tests: 1,
        robust_pct: 5,
        threshold_pass: 10,
        threshold_review: 5,
      },
      findings: [
        {
          severity: 'warning',
          code: 'TEST_ROBUSTNESS_LOW_COVERAGE',
          message: '5.0% error-path tests (below pass 10%).',
        },
      ],
    });
  });

  it('fails below the review threshold and honors a custom root, pattern, and thresholds', () => {
    for (let index = 1; index <= 21; index += 1) {
      write(
        `alternate/suite/tests/case-${index}.test.ts`,
        index === 1 ? 'it("handles bespoke-token", () => {});\n' : 'it("ordinary", () => {});\n',
      );
    }

    const reading = senseTestRobustnessCoverage({
      repoRoot: root,
      testGlobs: ['alternate/suite/tests'],
      extraPatterns: ['bespoke-token'],
      thresholds: { pass: 11, review: 6 },
      now: NOW,
    });

    expect(reading).toMatchObject({
      status: 'fail',
      timestamp: NOW,
      metrics: {
        test_files: 21,
        robust_tests: 1,
        robust_pct: 4.76,
        threshold_pass: 11,
        threshold_review: 6,
      },
      findings: [
        {
          severity: 'error',
          code: 'TEST_ROBUSTNESS_BELOW_THRESHOLD',
          message: '4.8% error-path tests (below review 6%).',
        },
      ],
    });
  });
});
