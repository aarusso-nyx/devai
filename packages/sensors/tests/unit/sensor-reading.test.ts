import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import './inventory-sensor-cases.js';
import { buildSensorReading } from '../../src/sensor-reading.js';
import { parseVitestSummary } from '../../src/test.js';

describe('buildSensorReading', () => {
  it('produces a record that validates against sensor-reading.schema.json', () => {
    const reading = buildSensorReading({
      sensorName: 'tsc',
      sensorKind: 'type_check',
      command: ['pnpm', 'run', 'typecheck'],
      status: 'pass',
      deterministic: true,
      exit_code: 0,
      duration_ms: 1234,
    });
    expect(reading.schemaVersion).toBe('1.0.0');
    expect(reading.id).toMatch(/^SR-[a-f0-9]{16}$/);
    expect(reading.command_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(reading.sensor.kind).toBe('type_check');
  });

  it('throws when a malformed reading would be produced', () => {
    // Force an invalid SensorReading by claiming a sensorKind not in the
    // schema enum. buildSensorReading must reject it rather than emit
    // silently-bad data.
    expect(() =>
      buildSensorReading({
        sensorName: 'tsc',
        sensorKind: 'bogus_kind',
        command: ['true'],
        status: 'pass',
        deterministic: true,
      }),
    ).toThrow(/sensor-reading\.schema\.json/);
  });

  it('rejects a finding with an invalid line number', () => {
    expect(() =>
      buildSensorReading({
        sensorName: 'eslint',
        sensorKind: 'lint',
        command: ['eslint', '.'],
        status: 'fail',
        deterministic: true,
        findings: [
          {
            severity: 'error',
            code: 'no-unused-vars',
            message: 'x is defined but never used',
            file: 'src/foo.ts',
            line: 0, // schema: minimum 1
          },
        ],
      }),
    ).toThrow(/sensor-reading\.schema\.json/);
  });
});

const SCHEMA_FILE_KINDS = (
  JSON.parse(
    readFileSync(
      new URL('../../../../law/schemas/sensor-reading.schema.json', import.meta.url),
      'utf8',
    ),
  ) as { properties: { sensor: { properties: { kind: { enum: string[] } } } } }
).properties.sensor.properties.kind.enum;

describe('buildSensorReading admits the kind set of the packaged schema file (ADR-SCR-0011)', () => {
  it.each([
    'decision_record_integrity',
    'decision_citation_resolution',
    'archive_immutability',
    'round_record_integrity',
  ])('builds a schema-valid %s reading', (kind) => {
    const reading = buildSensorReading({
      sensorName: kind,
      sensorKind: kind,
      command: ['devai', 'sense', 'run', kind],
      status: 'pass',
      deterministic: true,
    });
    expect(reading.sensor.kind).toBe(kind);
    expect(reading.command_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(['api_test', 'contract_validation', 'db_test', 'journey_test', 'mutation_test'])(
    'keeps the schema-only legacy value %s valid in the runtime validator',
    (kind) => {
      expect(SCHEMA_FILE_KINDS).toContain(kind);
      expect(
        buildSensorReading({
          sensorName: kind,
          sensorKind: kind,
          command: ['devai', 'legacy', kind],
          status: 'fail',
          deterministic: true,
        }).status,
      ).toBe('fail');
    },
  );

  it('admits every value of the schema file enum and nothing beyond it', () => {
    const rejected = SCHEMA_FILE_KINDS.filter((kind) => {
      try {
        buildSensorReading({
          sensorName: kind,
          sensorKind: kind,
          command: ['true'],
          status: 'pass',
          deterministic: true,
        });
        return false;
      } catch {
        return true;
      }
    });
    expect(rejected).toEqual([]);
    expect(() =>
      buildSensorReading({
        sensorName: 'unknown',
        sensorKind: 'not_in_the_schema_enum',
        command: ['true'],
        status: 'pass',
        deterministic: true,
      }),
    ).toThrow(/sensor-reading\.schema\.json/);
  });
});

describe('parseVitestSummary', () => {
  it('extracts identical metrics from plain and ANSI-colored Vitest summaries', () => {
    const plain = '      Tests  1 passed | 2 failed (3)';
    const colored =
      '\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m1 passed\u001b[39m\u001b[22m | \u001b[1m\u001b[31m2 failed\u001b[39m\u001b[22m \u001b[90m(3)\u001b[39m';

    expect(parseVitestSummary(plain)).toEqual({ passed: 1, failed: 2 });
    expect(parseVitestSummary(colored)).toEqual({ passed: 1, failed: 2 });
  });
});
// Invariants: INV-DEVAI-002, INV-DEVAI-012, INV-INVENTORY-002, INV-INVENTORY-003, INV-INVENTORY-004
