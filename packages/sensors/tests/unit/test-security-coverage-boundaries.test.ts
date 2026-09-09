import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { senseTestSecurityCoverage } from '../../src/test-security-coverage.js';

const NOW = '2026-09-08T12:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'devai-test-security-coverage-'));
  roots.push(value);
  return value;
}

function testFiles(repo: string, packageName: string, count: number, matched = false): void {
  const dir = join(repo, 'packages', packageName, 'test');
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    writeFileSync(
      join(dir, `case-${index}.test.ts`),
      matched && index === 0
        ? 'describe("auth", () => {});\n'
        : 'describe("ordinary", () => {});\n',
    );
  }
}

describe('test security coverage boundaries', () => {
  it('matches each default security vocabulary entry independently', () => {
    const repo = root();
    const dir = join(repo, 'packages', 'security', 'test');
    mkdirSync(dir, { recursive: true });
    const patterns = [
      'auth',
      'rbac',
      'permission',
      'tenant-isolation',
      'injection',
      'xss',
      'csrf',
      'cve',
      'sql.injection',
    ];
    for (const [index, pattern] of patterns.entries()) {
      writeFileSync(join(dir, `security-${index}.test.ts`), `${pattern}\n`);
    }
    writeFileSync(join(dir, 'ordinary.test.ts'), 'ordinary\n');

    const reading = senseTestSecurityCoverage({ repoRoot: repo, now: NOW });

    expect(reading).toMatchObject({
      status: 'pass',
      timestamp: NOW,
      deterministic: true,
      metrics: {
        test_files: 10,
        security_tests: 9,
        security_pct: 90,
        threshold_pass: 5,
        threshold_review: 2,
      },
      findings: [],
    });
  });

  it('reports an empty configured test population without a false pass', () => {
    const reading = senseTestSecurityCoverage({
      repoRoot: root(),
      testGlobs: ['custom/empty/tests'],
      now: NOW,
    });

    expect(reading).toMatchObject({
      status: 'review',
      metrics: { test_files: 0, security_tests: 0, security_pct: 0 },
      findings: [
        { severity: 'info', code: 'TEST_SECURITY_NO_TESTS', message: 'No test files found.' },
      ],
    });
  });

  it('applies the documented default 5% pass, 2% review, and below-review fail boundaries', () => {
    const repo = root();
    testFiles(repo, 'pass', 20, true);
    testFiles(repo, 'review', 50, true);
    testFiles(repo, 'fail', 100, true);

    const pass = senseTestSecurityCoverage({
      repoRoot: repo,
      testGlobs: ['packages/pass/test'],
      now: NOW,
    });
    const review = senseTestSecurityCoverage({
      repoRoot: repo,
      testGlobs: ['packages/review/test'],
      now: NOW,
    });
    const fail = senseTestSecurityCoverage({
      repoRoot: repo,
      testGlobs: ['packages/fail/test'],
      now: NOW,
    });

    expect(pass).toMatchObject({
      status: 'pass',
      metrics: { test_files: 20, security_tests: 1, security_pct: 5 },
    });
    expect(review).toMatchObject({
      status: 'review',
      metrics: { test_files: 50, security_tests: 1, security_pct: 2 },
      findings: [
        {
          severity: 'warning',
          code: 'TEST_SECURITY_LOW_COVERAGE',
          message: 'Only 2.0% of test files match security patterns (below pass 5%).',
        },
      ],
    });
    expect(fail).toMatchObject({
      status: 'fail',
      metrics: { test_files: 100, security_tests: 1, security_pct: 1 },
      findings: [
        {
          severity: 'error',
          code: 'TEST_SECURITY_BELOW_THRESHOLD',
          message: '1.0% security tests (below review 2%).',
        },
      ],
    });
  });

  it('uses custom patterns, simple globs, and thresholds with exact population metrics', () => {
    const repo = root();
    const dir = join(repo, 'custom', 'suite', 'tests');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'custom.test.ts'), 'custom-threat\n');
    writeFileSync(join(dir, 'ordinary.test.ts'), 'ordinary\n');

    const reading = senseTestSecurityCoverage({
      repoRoot: repo,
      testGlobs: ['custom/suite/tests'],
      extraPatterns: ['custom-threat'],
      thresholds: { pass: 60, review: 40 },
      now: NOW,
    });

    expect(reading).toMatchObject({
      status: 'review',
      metrics: {
        test_files: 2,
        security_tests: 1,
        security_pct: 50,
        threshold_pass: 60,
        threshold_review: 40,
      },
      findings: [
        {
          severity: 'warning',
          code: 'TEST_SECURITY_LOW_COVERAGE',
          message: 'Only 50.0% of test files match security patterns (below pass 60%).',
        },
      ],
    });
  });
});
