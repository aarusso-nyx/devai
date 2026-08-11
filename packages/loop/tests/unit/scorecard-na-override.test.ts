import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeScorecard } from '../../src/loop/scorecard.js';
import {
  loadScorecardNaConfig,
  resolveScorecardNaPath,
  scorecardNaCellSet,
} from '../../src/loop/scorecard-na.js';
import type { SensorReading } from '@devai-nyx/sensors';

/**
 * Phase 34.C (D-91): per-repo N/A override mechanism for the F×T
 * scorecard. Tests cover:
 *
 *   - Schema validation: well-formed config loads; invalid cell
 *     coordinates rejected; missing reason rejected; malformed
 *     JSON rejected.
 *   - Absent file: no-op (returns null).
 *   - Override timing: a cell listed as N/A stays N/A even when a
 *     PASS or FAIL SR maps to it.
 *   - resolveScorecardNaPath: default path computation.
 */

function buildReading(
  kind: SensorReading['sensor']['kind'],
  status: SensorReading['status'],
  id: string,
): SensorReading {
  return {
    schemaVersion: '1.0.0',
    id,
    sensor: { name: `inventory:${kind}`, kind },
    timestamp: '2026-05-18T12:00:00.000Z',
    status,
    deterministic: true,
    command: 'fixture',
    command_hash: '0'.repeat(64),
    tier: 'L0',
  };
}

describe('scorecard N/A override loader (Phase 34.B, closes D-91)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'devai-34c-na-'));
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('returns null when the config file is absent (no-op contract)', () => {
    const path = join(tmp, '.devai/config/scorecard-na.json');
    expect(loadScorecardNaConfig(path)).toBeNull();
  });

  it('loads a well-formed config and returns the typed object', () => {
    const path = join(tmp, 'scorecard-na.json');
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: '1.0.0',
        cells: [
          {
            cell: 'F2:T4',
            reason: 'no DB-of-record in framework',
            constitution_anchor: 'Article 5',
          },
          { cell: 'F4:T6', reason: 'no PII registry / RBAC inventory' },
        ],
      }),
    );
    const config = loadScorecardNaConfig(path);
    expect(config?.cells).toHaveLength(2);
    const firstCell = config?.cells[0];
    expect(firstCell?.cell).toBe('F2:T4');
    expect(firstCell?.constitution_anchor).toBe('Article 5');
  });

  it('rejects malformed JSON with a clear error', () => {
    const path = join(tmp, 'bad.json');
    writeFileSync(path, '{not json');
    expect(() => loadScorecardNaConfig(path)).toThrow(/not valid JSON/);
  });

  it('rejects a config with an invalid cell coordinate (Fx:Ty pattern)', () => {
    const path = join(tmp, 'invalid-cell.json');
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: '1.0.0',
        cells: [{ cell: 'F6:T1', reason: 'outside the 5x9 grid' }],
      }),
    );
    expect(() => loadScorecardNaConfig(path)).toThrow(/scorecard-na-config\.schema\.json/);
  });

  it('rejects a config missing the required reason field', () => {
    const path = join(tmp, 'no-reason.json');
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: '1.0.0',
        cells: [{ cell: 'F2:T4' }],
      }),
    );
    expect(() => loadScorecardNaConfig(path)).toThrow(/scorecard-na-config\.schema\.json/);
  });

  it('rejects a config with a reason shorter than the minimum length', () => {
    const path = join(tmp, 'short-reason.json');
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: '1.0.0',
        cells: [{ cell: 'F2:T4', reason: 'short' }],
      }),
    );
    expect(() => loadScorecardNaConfig(path)).toThrow(/scorecard-na-config\.schema\.json/);
  });

  it('accepts an empty cells array (a vestigial / pre-curated config)', () => {
    const path = join(tmp, 'empty.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: '1.0.0', cells: [] }));
    const config = loadScorecardNaConfig(path);
    expect(config?.cells).toEqual([]);
    expect(scorecardNaCellSet(config).size).toBe(0);
  });

  it('resolveScorecardNaPath returns <repoRoot>/.devai/config/scorecard-na.json', () => {
    expect(resolveScorecardNaPath('/abs/repo')).toBe('/abs/repo/.devai/config/scorecard-na.json');
  });
});

describe('computeScorecard respects N/A overlay (Phase 34.B, closes D-91)', () => {
  it('cells listed in naCells start as N/A even without DEGENERATE_CELLS coverage', () => {
    const sc = computeScorecard({
      timestamp: '2026-05-18T12:00:00.000Z',
      integrationHead: 'x'.repeat(40),
      naCells: new Set(['F2:T4', 'F4:T6']),
    });
    const f2t4 = sc.cells.find((c) => c.substrate === 'F2' && c.property === 'T4');
    const f4t6 = sc.cells.find((c) => c.substrate === 'F4' && c.property === 'T6');
    expect(f2t4?.verdict).toBe('N/A');
    expect(f4t6?.verdict).toBe('N/A');
  });

  it('an N/A overlay sticks even when a PASS reading maps to the cell', () => {
    // inventory_data_handling maps to F4×T6 per Phase 21.E semantic
    // mapping; without an overlay, a PASS reading would flip the
    // cell to PASS. With the overlay, the SR is silently dropped
    // (the existing N/A skip in the cells loop).
    const reading = buildReading('inventory_data_handling', 'pass', 'SR-test-na-overlay-1');
    const sc = computeScorecard({
      timestamp: '2026-05-18T12:00:00.000Z',
      integrationHead: 'x'.repeat(40),
      readings: [reading],
      naCells: new Set(['F4:T6']),
    });
    const f4t6 = sc.cells.find((c) => c.substrate === 'F4' && c.property === 'T6');
    expect(f4t6?.verdict).toBe('N/A');
    // The SR is dropped from the cell's sensor_readings list.
    expect(f4t6?.sensor_readings).toBeUndefined();
  });

  it('an N/A overlay also masks a FAIL reading (override beats SR)', () => {
    // The conservative direction: a repo's explicit "this doesn't
    // apply to us" beats sensor noise. A misconfigured sensor that
    // FAILs on a cell the repo has declared N/A must not move the
    // cell to FAIL — otherwise the override mechanism would be
    // moot under sensor-error conditions.
    const reading = buildReading('inventory_data_handling', 'fail', 'SR-test-na-overlay-2');
    const sc = computeScorecard({
      timestamp: '2026-05-18T12:00:00.000Z',
      integrationHead: 'x'.repeat(40),
      readings: [reading],
      naCells: new Set(['F4:T6']),
    });
    const f4t6 = sc.cells.find((c) => c.substrate === 'F4' && c.property === 'T6');
    expect(f4t6?.verdict).toBe('N/A');
  });

  it('absent naCells is a no-op (back-compat with pre-34.B callers)', () => {
    const reading = buildReading('inventory_data_handling', 'pass', 'SR-test-na-overlay-3');
    const sc = computeScorecard({
      timestamp: '2026-05-18T12:00:00.000Z',
      integrationHead: 'x'.repeat(40),
      readings: [reading],
    });
    const f4t6 = sc.cells.find((c) => c.substrate === 'F4' && c.property === 'T6');
    expect(f4t6?.verdict).toBe('PASS');
  });

  it('global DEGENERATE_CELLS still wins over reading-driven verdicts (no regression)', () => {
    // F4×T5 (Inventory × Idiomaticity) is in the global
    // DEGENERATE_CELLS set per Article 5 (derived inventory
    // artifacts are mechanically generated; idiomaticity applies
    // to authored code). Without ANY naCells overlay, the cell
    // stays N/A. This guards against the 34.B overlay timing
    // accidentally regressing the pre-existing global path.
    const sc = computeScorecard({
      timestamp: '2026-05-18T12:00:00.000Z',
      integrationHead: 'x'.repeat(40),
    });
    const f4t5 = sc.cells.find((c) => c.substrate === 'F4' && c.property === 'T5');
    expect(f4t5?.verdict).toBe('N/A');
  });

  it('naCells overlay composes with DEGENERATE_CELLS (cell in both stays N/A)', () => {
    // A repo can redundantly declare F4×T5 in its overlay; the
    // global N/A already wins, but the overlay path doesn't cause
    // a regression — both lead to N/A.
    const sc = computeScorecard({
      timestamp: '2026-05-18T12:00:00.000Z',
      integrationHead: 'x'.repeat(40),
      naCells: new Set(['F4:T5', 'F2:T4']),
    });
    const f4t5 = sc.cells.find((c) => c.substrate === 'F4' && c.property === 'T5');
    const f2t4 = sc.cells.find((c) => c.substrate === 'F2' && c.property === 'T4');
    expect(f4t5?.verdict).toBe('N/A');
    expect(f2t4?.verdict).toBe('N/A');
  });
});

describe('scorecardNaCellSet projection (Phase 34.B, closes D-91)', () => {
  it('projects a config into a Set<Fx:Ty> for computeScorecard', () => {
    const set = scorecardNaCellSet({
      schemaVersion: '1.0.0',
      cells: [
        { cell: 'F2:T4', reason: 'no DB' },
        { cell: 'F4:T6', reason: 'no PII' },
      ],
    });
    expect(set.has('F2:T4')).toBe(true);
    expect(set.has('F4:T6')).toBe(true);
    expect(set.has('F1:T1')).toBe(false);
    expect(set.size).toBe(2);
  });

  it('returns an empty set for null (no config file)', () => {
    expect(scorecardNaCellSet(null).size).toBe(0);
  });
});
// Invariants: INV-DEVAI-006
