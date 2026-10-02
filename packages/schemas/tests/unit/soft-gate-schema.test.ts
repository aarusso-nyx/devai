// Invariants: INV-HARNESS-006, INV-DATA-002
// ADR-MDL-0004 IA-001/002: score shape is separate from legacy review/triage.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROSTER, getValidator, extractStructuredReply } from '../../src/index.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const DIMENSIONS = [
  'spec_coherence',
  'plant_idiomaticity',
  'test_depth',
  'traceability_quality',
] as const;
const score = () => ({
  schemaVersion: '1.0.0',
  verdict: 'pass',
  confidence: 1,
  rationale: 'Offline schema fixture; no live observation.',
  scores: Object.fromEntries(DIMENSIONS.map((d) => [d, 3])),
  citations: Object.fromEntries(
    DIMENSIONS.map((d) => [
      d,
      [{ path: 'law/constitution.md', location: 'L1', source_sha256: 'a'.repeat(64) }],
    ]),
  ),
});

describe('separate scored reply schemas (offline)', () => {
  it('registers all five new schemas through the real package catalogue', () => {
    for (const name of [
      'soft-gate-score',
      'soft-gate-rubric',
      'soft-gate-evidence',
      'soft-gate-trust',
      'thresholds',
    ]) {
      expect(ROSTER).toContain(`${name}.schema.json`);
      expect(typeof getValidator(`${name}.schema.json`)).toBe('function');
    }
  });
  it('accepts exact integer score shape and refuses it as a generic review', () => {
    expect(getValidator('soft-gate-score.schema.json')(score())).toBe(true);
    expect(getValidator('review-verdict.schema.json')(score())).toBe(false);
    expect(getValidator('triage-breaker.schema.json')(score())).toBe(false);
  });
  it.each(DIMENSIONS)('rejects missing, fractional, nonfinite and unknown %s', (dimension) => {
    for (const value of [undefined, -1, 5, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '3']) {
      const document = score();
      document.scores[dimension] = value as number;
      expect(getValidator('soft-gate-score.schema.json')(document), String(value)).toBe(false);
    }
    const document = score();
    Reflect.deleteProperty(document.scores, dimension);
    expect(getValidator('soft-gate-score.schema.json')(document)).toBe(false);
  });
  it.each(DIMENSIONS)('requires a structured citation for %s', (dimension) => {
    for (const citation of [
      [],
      [{ path: '../law/constitution.md', location: 'L1', source_sha256: 'a'.repeat(64) }],
      [{ path: 'law/constitution.md', location: 'L0', source_sha256: 'a'.repeat(64) }],
      [{ path: 'law/constitution.md', location: 'L1', source_sha256: 'A'.repeat(64) }],
    ]) {
      const document = score();
      document.citations[dimension] = citation;
      expect(getValidator('soft-gate-score.schema.json')(document)).toBe(false);
    }
  });
  it('validates canonical policy sources without changing original hard thresholds', () => {
    for (const name of ['soft-gate-rubric', 'thresholds'])
      expect(
        getValidator(`${name}.schema.json`)(
          JSON.parse(readFileSync(resolve(ROOT, `law/policy/${name}.json`), 'utf8')),
        ),
      ).toBe(true);
    const thresholds = JSON.parse(
      readFileSync(resolve(ROOT, 'law/policy/thresholds.json'), 'utf8'),
    ) as { soft_gate: { minimum_scores: Record<string, number>; aggregation: string } };
    expect(thresholds.soft_gate.minimum_scores).toEqual(
      Object.fromEntries(DIMENSIONS.map((d) => [d, 3])),
    );
    expect(thresholds.soft_gate.aggregation).toBe('all-dimensions');
  });
  it('preserves legacy review extraction and retains exact fenced scored reply bytes', () => {
    const legacy = { verdict: 'pass', confidence: 0.9, rationale: 'Legacy generic reply.' };
    expect(
      extractStructuredReply(
        { text: JSON.stringify(legacy), finish_reason: 'stop' },
        'review-verdict.schema.json',
      ),
    ).toEqual({ ok: true, document: legacy });
    const text = 'Observed offline fixture.\n```json\n' + JSON.stringify(score()) + '\n```';
    expect(
      extractStructuredReply(
        { text, finish_reason: 'stop' },
        'soft-gate-score.schema.json' as never,
      ),
    ).toEqual({ ok: true, document: score() });
  });
});
