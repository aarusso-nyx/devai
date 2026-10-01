// ADR-SCR-0008 IA-005 (schema half): law/schemas/observation-backlog.schema.json is the
// contract of the backlog.json that `audit observe` writes. The schema rejects an
// unknown top-level key and an observation without its cell; the cross-reference a
// JSON Schema cannot express (a delta naming a cell absent from the current
// observations) is rejected by the skills validator. Every committed backlog.json
// written after the contract validates; the one bundle that predates it is excluded
// by name and never rewritten.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getValidator } from '@devai-nyx/schemas';
import { describe, expect, it } from 'vitest';
import { validateObservationBacklog } from '../../src/operations/backlog.js';

type Json = Record<string, unknown>;

const WORKSPACE = resolve(import.meta.dirname, '../../../..');
const SCHEMA = 'observation-backlog.schema.json';

/**
 * Bundles committed before ADR-SCR-0008's backlog contract existed. They are
 * evidence and are never rewritten, so they are excluded by exact path rather than
 * by any pattern a new bundle could match.
 */
const PRE_CONTRACT_BACKLOGS = [
  'record/proofs/compliance/scorecards/SC-20260927T205906-001.backlog.json',
] as const;

function valid(): Json {
  return {
    schemaVersion: '1.0.0',
    merge_sha: 'a'.repeat(40),
    previous_merge_sha: 'b'.repeat(40),
    generated_at: '2026-10-01T12:00:00.000Z',
    observations: [
      { cell: 'F1:T1', verdict: 'N/A', reading_ids: [] },
      { cell: 'F3:T1', verdict: 'FAIL', reading_ids: ['SR-89f7974460e256a3'] },
      { cell: 'F4:T7', verdict: 'PASS', reading_ids: ['SR-0123456789abcdef'] },
    ],
    deltas: {
      additions: [{ cell: 'F3:T1', verdict: 'FAIL' }],
      completions: [{ cell: 'F4:T7', verdict: 'REVIEW' }],
    },
  };
}

function schemaValidator() {
  return getValidator(SCHEMA);
}

function committedBacklogs(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: WORKSPACE, encoding: 'utf8' })
    .split('\0')
    .filter((path) => /(?:^|[/.])backlog\.json$/u.test(path))
    .filter((path) => !path.startsWith('law/schemas/'));
}

describe('ADR-SCR-0008 IA-005 the observation backlog contract', () => {
  it('accepts a complete bundle backlog and the schema example', () => {
    const validate = schemaValidator();
    expect(validate(valid()), JSON.stringify(validate.errors)).toBe(true);
    expect(validateObservationBacklog(valid())).toEqual({ ok: true, errors: [] });

    const schema = JSON.parse(readFileSync(join(WORKSPACE, 'law/schemas', SCHEMA), 'utf8')) as {
      readonly examples: readonly unknown[];
    };
    for (const example of schema.examples) {
      expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
      expect(validateObservationBacklog(example).ok).toBe(true);
    }
  });

  it('rejects an unknown top-level key', () => {
    const corrupted = { ...valid(), current: { count: 0, items: [] } };
    expect(schemaValidator()(corrupted)).toBe(false);
    const result = validateObservationBacklog(corrupted);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects an observation without its cell', () => {
    const base = valid();
    const corrupted = {
      ...base,
      observations: [{ verdict: 'FAIL', reading_ids: ['SR-89f7974460e256a3'] }],
    };
    expect(schemaValidator()(corrupted)).toBe(false);
    expect(validateObservationBacklog(corrupted).ok).toBe(false);
  });

  it.each(['additions', 'completions'] as const)(
    'rejects a delta in %s naming a cell absent from the current observations',
    (side) => {
      const base = valid();
      const deltas = base['deltas'] as Record<string, unknown[]>;
      const corrupted = {
        ...base,
        deltas: {
          ...deltas,
          [side]: [...(deltas[side] ?? []), { cell: 'F5:T9', verdict: 'FAIL' }],
        },
      };
      // The schema alone cannot see the cross-reference ...
      expect(schemaValidator()(corrupted)).toBe(true);
      // ... so the validator the skills suites use must.
      expect(validateObservationBacklog(corrupted)).toEqual({
        ok: false,
        errors: ['OBSERVATION_BACKLOG_DELTA_CELL_UNKNOWN:F5:T9'],
      });
    },
  );

  it('validates every committed backlog.json written under the contract', () => {
    const committed = committedBacklogs();
    for (const path of PRE_CONTRACT_BACKLOGS) expect(committed).toContain(path);
    const governed = committed.filter(
      (path) => !(PRE_CONTRACT_BACKLOGS as readonly string[]).includes(path),
    );
    for (const path of governed) {
      const value: unknown = JSON.parse(readFileSync(join(WORKSPACE, path), 'utf8'));
      expect(validateObservationBacklog(value), path).toEqual({ ok: true, errors: [] });
    }
  });
});
