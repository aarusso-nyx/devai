// Invariants: INV-HARNESS-006
// ADR-MDL-0004 IA-002/003/004. Pure offline input validation is not live custody.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const ROOT = resolve(import.meta.dirname, '../..');
const { validateScoredSoftGate } =
  (await import('../../packages/sensors/src/ci-invariant-gate.js')) as {
    validateScoredSoftGate: (input: unknown) => {
      status: string;
    };
  };
const dimensions = [
  'spec_coherence',
  'plant_idiomaticity',
  'test_depth',
  'traceability_quality',
] as const;
const source = Buffer.from('# Frozen reference\nAdequate observed criterion.\n');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function input() {
  return {
    score: {
      schemaVersion: '1.0.0',
      verdict: 'pass',
      confidence: 1,
      rationale: 'Offline criteria fixture.',
      scores: Object.fromEntries(dimensions.map((d) => [d, 3])),
      citations: Object.fromEntries(
        dimensions.map((d) => [
          d,
          [{ path: 'law/reference.md', location: 'L2', source_sha256: digest(source) }],
        ]),
      ),
    },
    thresholds: JSON.parse(readFileSync(resolve(ROOT, 'law/policy/thresholds.json'), 'utf8')),
    rubric: JSON.parse(readFileSync(resolve(ROOT, 'law/policy/soft-gate-rubric.json'), 'utf8')),
    sourceFiles: new Map([['law/reference.md', source]]),
  };
}
describe('every scored dimension is independently binding (offline)', () => {
  it('accepts exact four3 boundary for the score component only', () =>
    expect(validateScoredSoftGate(input()).status).toBe('pass'));
  it.each(dimensions)(
    'blocks a single below-floor %s despite all other scores4/confidence1',
    (dimension) => {
      const value = input();
      for (const d of dimensions) value.score.scores[d] = 4;
      value.score.scores[dimension] = 2;
      expect(validateScoredSoftGate(value).status).toBe('fail');
    },
  );
  it.each(['review', 'fail'])('blocks high scores with %s verdict', (verdict) => {
    const value = input();
    value.score.verdict = verdict;
    for (const d of dimensions) value.score.scores[d] = 4;
    expect(validateScoredSoftGate(value).status).not.toBe('pass');
  });
  it('classifies unknown verdict and malformed observations as evidence errors', () => {
    const value = input();
    value.score.verdict = 'unknown';
    expect(validateScoredSoftGate(value).status).toBe('error');
    for (const invalid of [undefined, null, {}, { ...input(), sourceFiles: new Map() }])
      expect(validateScoredSoftGate(invalid).status).toBe('error');
  });
  it.each(dimensions)('refuses fractional, out-of-range and absent %s', (dimension) => {
    for (const bad of [2.5, -1, 5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const value = input();
      value.score.scores[dimension] = bad as number;
      expect(validateScoredSoftGate(value).status).toBe('error');
    }
  });
  it.each(['L0', 'L99', 'L2-L1', '#missing'])(
    'resolves actual source locations rather than citation syntax alone: %s',
    (location) => {
      const value = input();
      required(required(value.score.citations.spec_coherence)[0]).location = location;
      expect(validateScoredSoftGate(value).status).toBe('error');
    },
  );
  it('refuses source digest substitution and incomplete citation populations', () => {
    const value = input();
    required(required(value.score.citations.test_depth)[0]).source_sha256 = 'f'.repeat(64);
    expect(validateScoredSoftGate(value).status).toBe('error');
    const absent = input();
    absent.score.citations.traceability_quality = [];
    expect(validateScoredSoftGate(absent).status).toBe('error');
  });
  it('refuses changed/missing thresholds rather than defaulting or averaging', () => {
    const value = input();
    value.thresholds.soft_gate.minimum_scores.test_depth = 2;
    expect(validateScoredSoftGate(value).status).toBe('error');
    Reflect.deleteProperty(value.thresholds, 'soft_gate');
    expect(validateScoredSoftGate(value).status).toBe('error');
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('OFFLINE_FIXTURE_REQUIRED_VALUE_MISSING');
  return value;
}
