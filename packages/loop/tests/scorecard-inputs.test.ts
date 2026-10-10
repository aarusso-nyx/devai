import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getValidator } from '@devai-nyx/schemas';
import type { SensorReading } from '@devai-nyx/sensors';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeScorecard, summarizeCells, type Scorecard } from '../src/loop/scorecard.js';
import { loadScorecardNaConfig, scorecardNaCellSet } from '../src/loop/scorecard-na.js';
import { recordBoundScorecardReading } from './helpers/scorecard-custody-fixture.js';
import { resolveScorecardInputs, resolveScorecardNaCells } from '../src/scorecard/inputs.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const LAW_LEDGER = join(REPO_ROOT, 'law/policy/scorecard-na.json');
const MATERIALIZED_LEDGER = join(REPO_ROOT, '.devai/config/scorecard-na.json');
const ADOPTER_DEFAULT_LEDGER = join(REPO_ROOT, 'law/policy/adopter-defaults/scorecard-na.json');

const timestamp = '2026-09-26T12:00:00.000Z';
const head = 'a'.repeat(40);
const validateReading = getValidator('sensor-reading.schema.json');

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-scorecard-inputs-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function reading(
  kind: SensorReading['sensor']['kind'],
  status: SensorReading['status'],
  id: string,
): SensorReading {
  const value: SensorReading = {
    schemaVersion: '1.0.0',
    id,
    sensor: { name: `sense:${kind}`, kind, version: '1.0.0' },
    timestamp: '2026-09-26T11:00:00.000Z',
    status,
    deterministic: true,
    command: `devai sense run ${kind}`,
    command_hash: 'a'.repeat(64),
    tier: 'L0',
  };
  expect(validateReading(value), JSON.stringify(validateReading.errors)).toBe(true);
  return value;
}

function write(relative: string, body: string): string {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

/** Persist exactly as `sense record` does: `<kind>/<id>.json`, pretty-printed, newline-terminated. */
function record(value: SensorReading): string {
  return recordBoundScorecardReading(root, value, head);
}

function ledger(cells: readonly { cell: string; reason: string }[]): void {
  write(
    '.devai/config/scorecard-na.json',
    `${JSON.stringify({ schemaVersion: '1.0.0', cells }, null, 2)}\n`,
  );
}

function verdictOf(scorecard: Scorecard, substrate: string, property: string) {
  const found = scorecard.cells.find((c) => c.substrate === substrate && c.property === property);
  if (found === undefined) throw new Error(`cell ${substrate}:${property} missing`);
  return found;
}

function naCells(scorecard: Scorecard): string[] {
  return scorecard.cells
    .filter((c) => c.verdict === 'N/A')
    .map((c) => `${c.substrate}:${c.property}`)
    .sort();
}

const F4T5 = { cell: 'F4:T5', reason: 'Inventory is derived, never authored (Article 5).' };
const F1T1 = { cell: 'F1:T1', reason: 'No contract-validation emitter on this repository.' };

describe('the N/A ledger is the sole source of N/A cells (ADR-SCR-0002)', () => {
  it('the classifier holds no degenerate list: without a ledger every one of the 45 cells is scoreable', () => {
    const scorecard = computeScorecard({ timestamp, integrationHead: head });
    expect(scorecard.cells).toHaveLength(45);
    expect(naCells(scorecard)).toEqual([]);
    expect(verdictOf(scorecard, 'F4', 'T5').verdict).toBe('UNKNOWN');
    expect(resolveScorecardNaCells(root).size).toBe(0);
  });

  it('a cell is N/A only while the ledger lists it; removing the entry scores the cell again (IA-002)', () => {
    ledger([F4T5]);
    const listed = resolveScorecardInputs({ repoRoot: root, inputs: undefined, timestamp });
    expect(naCells(listed.scorecard)).toEqual(['F4:T5']);

    ledger([]);
    const emptied = resolveScorecardInputs({ repoRoot: root, inputs: undefined, timestamp });
    expect(naCells(emptied.scorecard)).toEqual([]);
    expect(verdictOf(emptied.scorecard, 'F4', 'T5').verdict).toBe('UNKNOWN');

    rmSync(join(root, '.devai/config/scorecard-na.json'));
    const absent = resolveScorecardInputs({ repoRoot: root, inputs: undefined, timestamp });
    expect(naCells(absent.scorecard)).toEqual([]);
  });

  it('applies the ledger equally to caller-supplied readings and beats a reading that maps to a listed cell', () => {
    ledger([{ cell: 'F4:T1', reason: 'This fixture repository has no inventory surface.' }]);
    const supplied = reading('inventory_api', 'pass', 'SR-0123456789abcdef');
    const result = resolveScorecardInputs({
      repoRoot: root,
      inputs: { readings: [supplied] },
      timestamp,
      integrationHead: head,
    });
    expect(result.source).toBe('inputs');
    const presence = verdictOf(result.scorecard, 'F4', 'T1');
    expect(presence.verdict).toBe('N/A');
    expect(presence.sensor_readings).toBeUndefined();
  });

  it('rejects a ledger entry outside the declared grid or without a reason (IA-003)', () => {
    const outside = write(
      'outside.json',
      JSON.stringify({ schemaVersion: '1.0.0', cells: [{ cell: 'F6:T1', reason: 'not a cell' }] }),
    );
    expect(() => loadScorecardNaConfig(outside)).toThrow(/scorecard-na-config\.schema\.json/);
    const unreasoned = write(
      'unreasoned.json',
      JSON.stringify({ schemaVersion: '1.0.0', cells: [{ cell: 'F4:T5' }] }),
    );
    expect(() => loadScorecardNaConfig(unreasoned)).toThrow(/scorecard-na-config\.schema\.json/);
  });
});

describe('one readings store: the resolver walks .devai/state/sensor-readings (ADR-SCR-0002)', () => {
  it('scores a reading persisted in the sense record layout under the ledger, and ignores the retired store', () => {
    ledger([F1T1, F4T5]);
    const recorded = reading('inventory_api', 'pass', 'SR-0123456789abcdef');
    const path = record(recorded);
    expect(path).toBe(
      join(root, '.devai/state/sensor-readings/inventory_api/SR-0123456789abcdef.json'),
    );
    write(
      'record/proofs/freshness/readings/inventory_routes/SR-fedcba9876543210.json',
      JSON.stringify(reading('inventory_routes', 'fail', 'SR-fedcba9876543210')),
    );

    const result = resolveScorecardInputs({
      repoRoot: root,
      inputs: undefined,
      timestamp,
      integrationHead: head,
    });

    expect(result.source).toBe('disk');
    expect(result.readings).toEqual([recorded]);
    const presence = verdictOf(result.scorecard, 'F4', 'T1');
    expect(presence.verdict).toBe('PASS');
    expect(presence.sensor_readings).toEqual(['SR-0123456789abcdef']);
    expect(naCells(result.scorecard)).toEqual(['F1:T1', 'F4:T5']);
    expect(result.scorecard).toEqual(
      computeScorecard({
        timestamp,
        integrationHead: head,
        readings: [recorded],
        naCells: new Set(['F1:T1', 'F4:T5']),
      }),
    );
  });
});

describe('the framework ledger (IA-004 and the documented count)', () => {
  it('lists F1:T1 and F4:T5 with Article 5 anchors and is materialized byte-for-byte', () => {
    const law = readFileSync(LAW_LEDGER, 'utf8');
    expect(readFileSync(MATERIALIZED_LEDGER, 'utf8')).toBe(law);
    const config = loadScorecardNaConfig(LAW_LEDGER);
    expect(config?.cells.map((c) => c.cell)).toEqual(['F1:T1', 'F4:T5']);
    expect(config?.cells.every((c) => c.constitution_anchor === 'Article 5')).toBe(true);
    expect(config?.cells.every((c) => c.reason.length >= 8)).toBe(true);
    expect([...scorecardNaCellSet(config)].sort()).toEqual([...resolveScorecardNaCells(REPO_ROOT)]);
  });

  it('ships F4:T5 with its Article 5 reason in the adopter default', () => {
    const adopterDefault = loadScorecardNaConfig(ADOPTER_DEFAULT_LEDGER);
    const lawEntry = loadScorecardNaConfig(LAW_LEDGER)?.cells.find((c) => c.cell === 'F4:T5');
    expect(adopterDefault?.cells.map((c) => c.cell)).toEqual(['F4:T5']);
    expect(adopterDefault?.cells[0]).toEqual(lawEntry);
  });

  it('scores DEVAI as 45 cells, 2 N/A, 43 scoreable', () => {
    const scorecard = computeScorecard({
      timestamp,
      integrationHead: head,
      naCells: resolveScorecardNaCells(REPO_ROOT),
    });
    const summary = summarizeCells(scorecard.cells);
    expect(summary.total).toBe(45);
    expect(summary.na).toBe(2);
    expect(summary.total - summary.na).toBe(43);
    expect(naCells(scorecard)).toEqual(['F1:T1', 'F4:T5']);
  });
});
// Invariants: INV-DEVAI-006
