// ADR-SCR-0003: the scorecard composer's skipped-reading rule for declared
// plant surfaces. A sensor bound to a surface the repository declared absent
// emits `skipped` with the declaration as its reason. The composer lists a
// skipped reading in its cell but never collapses it; a cell whose readings
// are all skipped is recorded N/A with the declaration reason, never UNKNOWN
// or REVIEW; one measured reading in the cell makes its skipped siblings
// inert; the ledger N/A (ADR-SCR-0002) still wins over everything. One case
// per inspector acceptance item of the record, on the composer's side of it.
import { getValidator } from '@devai-nyx/schemas';
import type { SensorReading } from '@devai-nyx/sensors';
import { describe, expect, it } from 'vitest';
import {
  computeScorecard,
  NA_DECLARATION_NOTE_PREFIX,
  scorecardCellNaSource,
  skippedReadingReason,
  summarizeCells,
  type Scorecard,
  type ScorecardCell,
} from '../src/loop/scorecard.js';

const timestamp = '2026-09-27T12:00:00.000Z';
const head = 'b'.repeat(40);
const validateReading = getValidator('sensor-reading.schema.json');
const validateScorecard = getValidator('scorecard.schema.json');

const HTTP_ABSENT = 'surface http declared absent in .devai/config/sensor-inputs.json';
const RBAC_ABSENT = 'surface rbac declared absent in .devai/config/sensor-inputs.json';
const DATABASE_ABSENT = 'surface database declared absent in .devai/config/sensor-inputs.json';

let counter = 0;
function reading(
  kind: SensorReading['sensor']['kind'],
  status: SensorReading['status'],
  extra: Partial<Pick<SensorReading, 'findings' | 'deterministic' | 'err_head' | 'out_head'>> = {},
): SensorReading {
  counter += 1;
  const value: SensorReading = {
    schemaVersion: '1.0.0',
    id: `SR-${counter.toString(16).padStart(16, '0')}`,
    sensor: { name: `sense:${kind}`, kind, version: '1.0.0' },
    timestamp: '2026-09-27T11:00:00.000Z',
    status,
    deterministic: extra.deterministic ?? true,
    command: `devai sense run ${kind}`,
    command_hash: 'c'.repeat(64),
    tier: 'L0',
    ...(extra.findings !== undefined && { findings: extra.findings }),
    ...(extra.err_head !== undefined && { err_head: extra.err_head }),
    ...(extra.out_head !== undefined && { out_head: extra.out_head }),
  };
  expect(validateReading(value), JSON.stringify(validateReading.errors)).toBe(true);
  return value;
}

/** A skipped reading the way a sensor bound to an absent surface emits it. */
function skipped(kind: SensorReading['sensor']['kind'], reason: string): SensorReading {
  return reading(kind, 'skipped', {
    findings: [{ severity: 'info', code: 'SURFACE_DECLARED_ABSENT', message: reason }],
  });
}

function compose(readings: readonly SensorReading[], naCells?: ReadonlySet<string>): Scorecard {
  const scorecard = computeScorecard({ timestamp, integrationHead: head, readings, naCells });
  expect(validateScorecard(scorecard), JSON.stringify(validateScorecard.errors)).toBe(true);
  return scorecard;
}

function cellOf(scorecard: Scorecard, substrate: string, property: string): ScorecardCell {
  const found = scorecard.cells.find((c) => c.substrate === substrate && c.property === property);
  if (found === undefined) throw new Error(`cell ${substrate}:${property} missing`);
  return found;
}

describe('IA-001: a skipped reading carries the declaration as its reason', () => {
  it('reads the reason from the first finding, then err_head, then out_head, then a generic statement', () => {
    expect(skippedReadingReason(skipped('inventory_rbac', RBAC_ABSENT))).toBe(RBAC_ABSENT);
    expect(
      skippedReadingReason(reading('inventory_rbac', 'skipped', { err_head: 'stderr reason' })),
    ).toBe('stderr reason');
    expect(
      skippedReadingReason(reading('inventory_rbac', 'skipped', { out_head: 'stdout reason' })),
    ).toBe('stdout reason');
    expect(skippedReadingReason(reading('inventory_rbac', 'skipped'))).toBe(
      'skipped by inventory_rbac without a stated reason',
    );
  });

  it('records a cell whose only reading is skipped as N/A carrying that reason, with no review or fail', () => {
    const scorecard = compose([skipped('inventory_rbac', RBAC_ABSENT)]);
    const cell = cellOf(scorecard, 'F4', 'T6');
    expect(cell.verdict).toBe('N/A');
    expect(cell.verdict).not.toBe('REVIEW');
    expect(cell.verdict).not.toBe('UNKNOWN');
    expect(cell.notes).toBe(`${NA_DECLARATION_NOTE_PREFIX} inventory_rbac: ${RBAC_ABSENT}`);
    expect(cell.sensor_readings).toHaveLength(1);
    expect(cell.deterministic).toBe(true);
    expect(summarizeCells(scorecard.cells)).toMatchObject({ fail: 0, review: 0, na: 2 });
  });
});

describe('IA-002: all-skipped cells are N/A by declaration; one measured reading ignores its skipped siblings', () => {
  it('records a cell whose readings are all skipped as N/A with every declaration reason listed', () => {
    const rbac = skipped('inventory_rbac', RBAC_ABSENT);
    const handling = skipped('inventory_data_handling', RBAC_ABSENT);
    const scorecard = compose([rbac, handling]);
    const cell = cellOf(scorecard, 'F4', 'T6');
    expect(cell.verdict).toBe('N/A');
    expect(scorecardCellNaSource(cell)).toBe('declaration');
    expect(cell.sensor_readings).toEqual([handling.id, rbac.id]);
    expect(cell.notes).toBe(
      `${NA_DECLARATION_NOTE_PREFIX} inventory_data_handling: ${RBAC_ABSENT}; inventory_rbac: ${RBAC_ABSENT}`,
    );
  });

  it('keeps a measured PASS beside skipped readings and lists the skipped ids in the cell', () => {
    const api = skipped('inventory_api', HTTP_ABSENT);
    const routes = skipped('inventory_routes', HTTP_ABSENT);
    const model = skipped('inventory_data_model', DATABASE_ABSENT);
    const coverage = reading('inventory_coverage', 'pass');
    const scorecard = compose([api, routes, model, coverage]);
    const depth = cellOf(scorecard, 'F4', 'T2');
    expect(depth.verdict).toBe('PASS');
    expect(scorecardCellNaSource(depth)).toBeNull();
    expect(depth.notes).toBeUndefined();
    expect(depth.sensor_readings).toEqual([api.id, coverage.id, model.id, routes.id]);
  });

  it('applies the measured verdict whether the skipped readings land before or after it', () => {
    const before = compose([
      skipped('inventory_rbac', RBAC_ABSENT),
      reading('inventory_data_handling', 'review', {
        findings: [{ severity: 'warning', code: 'PII_COLUMN_UNLISTED', message: 'one column' }],
      }),
    ]);
    expect(cellOf(before, 'F4', 'T6').verdict).toBe('REVIEW');
    const after = compose([
      reading('inventory_data_handling', 'review', {
        findings: [{ severity: 'warning', code: 'PII_COLUMN_UNLISTED', message: 'one column' }],
      }),
      skipped('inventory_rbac', RBAC_ABSENT),
    ]);
    expect(cellOf(after, 'F4', 'T6').verdict).toBe('REVIEW');
  });

  it('never lets a skipped reading move a measured verdict or taint determinism', () => {
    const measured = reading('inventory_data_handling', 'pass');
    const scorecard = compose([
      skipped('inventory_rbac', RBAC_ABSENT),
      measured,
      reading('inventory_api', 'skipped', { deterministic: false }),
    ]);
    const security = cellOf(scorecard, 'F4', 'T6');
    expect(security.verdict).toBe('PASS');
    expect(security.deterministic).toBe(true);
    const presence = cellOf(scorecard, 'F4', 'T1');
    expect(presence.verdict).toBe('PASS');
    expect(presence.deterministic).toBe(true);
  });

  it('keeps the worst-of collapse for measured readings unchanged', () => {
    const scorecard = compose([
      reading('inventory_api', 'pass'),
      reading('inventory_routes', 'fail'),
      reading('inventory_data_model', 'unknown'),
      reading('inventory_coverage', 'review'),
      skipped('inventory_rbac', RBAC_ABSENT),
    ]);
    expect(cellOf(scorecard, 'F4', 'T2').verdict).toBe('FAIL');
    expect(cellOf(scorecard, 'F4', 'T1').verdict).toBe('FAIL');
    const unknownBesidesPass = compose([
      reading('inventory_api', 'pass'),
      reading('inventory_routes', 'unknown'),
    ]);
    expect(cellOf(unknownBesidesPass, 'F4', 'T2').verdict).toBe('UNKNOWN');
  });

  it('the ledger N/A wins over skipped and measured readings alike and lists no reading', () => {
    const scorecard = compose(
      [skipped('inventory_rbac', RBAC_ABSENT), reading('inventory_data_handling', 'fail')],
      new Set(['F4:T6']),
    );
    const cell = cellOf(scorecard, 'F4', 'T6');
    expect(cell.verdict).toBe('N/A');
    expect(scorecardCellNaSource(cell)).toBe('ledger');
    expect(cell.sensor_readings).toBeUndefined();
    expect(cell.notes).toBeUndefined();
  });

  it('a declaration N/A is left out of the substrate aggregate like a ledger N/A', () => {
    const measured = [
      reading('inventory_dep_graph', 'pass'),
      reading('inventory_coverage', 'pass'),
    ];
    const declared = compose([
      skipped('inventory_rbac', RBAC_ABSENT),
      skipped('inventory_data_handling', RBAC_ABSENT),
      ...measured,
    ]);
    const listed = compose(measured, new Set(['F4:T6']));
    expect(scorecardCellNaSource(cellOf(declared, 'F4', 'T6'))).toBe('declaration');
    expect(scorecardCellNaSource(cellOf(listed, 'F4', 'T6'))).toBe('ledger');
    expect(declared.substrate_aggregates).toEqual(listed.substrate_aggregates);
    expect(declared.overall.verdict).toBe(listed.overall.verdict);
    // A substrate observed only through a declaration N/A stays UNKNOWN, as with the ledger.
    const onlyDeclared = compose([skipped('plant_coverage', HTTP_ABSENT)]);
    expect(onlyDeclared.substrate_aggregates.F2?.verdict).toBe('UNKNOWN');
  });
});

describe('IA-003: a surface found despite an absent declaration reviews, never skips', () => {
  it('a review reading in a cell records REVIEW even beside skipped readings, never N/A', () => {
    const contradiction = reading('inventory_routes', 'review', {
      findings: [
        {
          severity: 'warning',
          code: 'SURFACE_DECLARED_ABSENT_BUT_FOUND',
          message: 'http declared absent but 3 routes were found',
        },
      ],
    });
    const scorecard = compose([
      skipped('inventory_api', HTTP_ABSENT),
      contradiction,
      skipped('inventory_data_model', DATABASE_ABSENT),
    ]);
    const depth = cellOf(scorecard, 'F4', 'T2');
    expect(depth.verdict).toBe('REVIEW');
    expect(scorecardCellNaSource(depth)).toBeNull();
    expect(depth.sensor_readings).toContain(contradiction.id);
  });
});

describe('IA-004: a present actions surface is measured, not skipped', () => {
  it('scores F2:T1 and F4:T2 from plant_coverage and inventory_coverage measuring the action registry', () => {
    const scorecard = compose([
      reading('plant_coverage', 'pass'),
      reading('inventory_coverage', 'pass'),
      skipped('inventory_api', HTTP_ABSENT),
      skipped('inventory_routes', HTTP_ABSENT),
      skipped('inventory_data_model', DATABASE_ABSENT),
    ]);
    expect(cellOf(scorecard, 'F2', 'T1').verdict).toBe('PASS');
    expect(cellOf(scorecard, 'F4', 'T2').verdict).toBe('PASS');
    expect(cellOf(scorecard, 'F4', 'T1').verdict).toBe('PASS');
  });

  it('records the DEVAI grid: ledger N/A for F1:T1 and F4:T5, declaration N/A for F4:T6, the rest measured', () => {
    const scorecard = compose(
      [
        reading('plant_coverage', 'pass'),
        reading('inventory_coverage', 'pass'),
        reading('inventory_dep_graph', 'pass'),
        skipped('inventory_api', HTTP_ABSENT),
        skipped('inventory_routes', HTTP_ABSENT),
        skipped('inventory_data_model', DATABASE_ABSENT),
        skipped('inventory_rbac', RBAC_ABSENT),
        skipped('inventory_data_handling', RBAC_ABSENT),
      ],
      new Set(['F1:T1', 'F4:T5']),
    );
    const na = scorecard.cells
      .filter((c) => c.verdict === 'N/A')
      .map((c) => `${c.substrate}:${c.property}=${scorecardCellNaSource(c) ?? ''}`)
      .sort();
    expect(na).toEqual(['F1:T1=ledger', 'F4:T5=ledger', 'F4:T6=declaration']);
    expect(cellOf(scorecard, 'F2', 'T1').verdict).toBe('PASS');
    expect(cellOf(scorecard, 'F4', 'T1').verdict).toBe('PASS');
    expect(cellOf(scorecard, 'F4', 'T2').verdict).toBe('PASS');
    expect(cellOf(scorecard, 'F4', 'T3').verdict).toBe('PASS');
    expect(summarizeCells(scorecard.cells)).toMatchObject({ total: 45, na: 3, review: 0, fail: 0 });
  });
});
