// Invariants: INV-DEVAI-018
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as core from '../../src/services/dependency-security/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures/r21/dependencies');
const expectedLockfileSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

type Result = {
  readonly status: 'pass' | 'review' | 'fail' | 'unknown';
  readonly findings?: readonly { readonly code: string }[];
};

type Evaluator = (
  scannerOutput: unknown,
  options: {
    readonly expectedScanner: { readonly name: string; readonly version: string };
    readonly expectedLockfileSha256: string;
    readonly now: string;
    readonly maxDatabaseAgeHours: number;
  },
) => Result;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

function evaluate(name: string): Result {
  const fn = (core as unknown as { evaluateDependencySecurityResult?: Evaluator })
    .evaluateDependencySecurityResult;
  expect(fn, 'core must export the deterministic dependency-security evaluator').toBeTypeOf(
    'function',
  );
  if (fn === undefined) throw new Error('evaluateDependencySecurityResult is not implemented');
  return fn(fixture(name), {
    expectedScanner: { name: 'devai-scanner', version: '1.2.3' },
    expectedLockfileSha256: expectedLockfileSha,
    now: '2026-07-17T02:00:00.000Z',
    maxDatabaseAgeHours: 168,
  });
}

function evaluateValue(value: unknown): Result {
  const fn = (core as unknown as { evaluateDependencySecurityResult?: Evaluator })
    .evaluateDependencySecurityResult;
  expect(fn).toBeTypeOf('function');
  if (fn === undefined) throw new Error('evaluateDependencySecurityResult is not implemented');
  return fn(value, {
    expectedScanner: { name: 'devai-scanner', version: '1.2.3' },
    expectedLockfileSha256: expectedLockfileSha,
    now: '2026-07-17T02:00:00.000Z',
    maxDatabaseAgeHours: 168,
  });
}

describe('dependency-security provenance evaluator', () => {
  it('returns REVIEW for low/moderate-only findings', () => {
    expect(evaluate('low-moderate.json')).toMatchObject({ status: 'review' });
  });

  it('returns UNKNOWN when scanner name or pinned version differs', () => {
    expect(evaluate('wrong-scanner.json')).toMatchObject({ status: 'unknown' });
  });

  it('returns UNKNOWN when the exact lockfile digest differs', () => {
    expect(evaluate('wrong-lockfile.json')).toMatchObject({ status: 'unknown' });
  });

  it('returns UNKNOWN when the advisory database is stale', () => {
    expect(evaluate('stale-database.json')).toMatchObject({ status: 'unknown' });
  });

  it('accepts only an exact, reasoned, owned, non-expired waiver', () => {
    const value = fixture('low-moderate.json') as Record<string, unknown>;
    const advisories = value.advisories as Array<Record<string, unknown>>;
    const advisory = advisories[0];
    expect(advisory).toBeDefined();
    if (advisory === undefined) throw new Error('fixture advisory is required');
    const high: Record<string, unknown> = { ...advisory, severity: 'high' };
    expect(
      evaluateValue({
        ...value,
        advisories: [high],
        waivers: [
          {
            advisory_id: high['id'],
            package: high['package'],
            reason: 'Owner accepted the bounded exposure for this fixture.',
            approved_by: 'owner',
            expires_at: '2026-07-18T00:00:00.000Z',
          },
        ],
      }),
    ).toMatchObject({ status: 'pass', applied_waivers: [{ approved_by: 'owner' }] });
  });

  it('fails a package-mismatched waiver rather than applying it by advisory id alone', () => {
    const value = fixture('low-moderate.json') as Record<string, unknown>;
    const advisories = value.advisories as Array<Record<string, unknown>>;
    expect(
      evaluateValue({
        ...value,
        waivers: [
          {
            advisory_id: advisories[0]?.id,
            package: 'different-package',
            reason: 'invalid mismatch fixture',
            approved_by: 'owner',
            expires_at: '2026-07-18T00:00:00.000Z',
          },
        ],
      }),
    ).toMatchObject({
      status: 'fail',
      findings: [{ code: 'DEPENDENCY_WAIVER_PACKAGE_MISMATCH' }],
    });
  });

  it('fails a malformed waiver before it can suppress an advisory', () => {
    const value = fixture('low-moderate.json') as Record<string, unknown>;
    const advisories = value.advisories as Array<Record<string, unknown>>;
    expect(
      evaluateValue({
        ...value,
        waivers: [
          {
            advisory_id: advisories[0]?.id,
            package: advisories[0]?.package,
            reason: '',
            approved_by: 'owner',
            expires_at: '2026-07-18T00:00:00.000Z',
          },
        ],
      }),
    ).toMatchObject({ status: 'fail', findings: [{ code: 'DEPENDENCY_WAIVER_INVALID' }] });
  });
});
