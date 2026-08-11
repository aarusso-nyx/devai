// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
// Inspector acceptance: every local read sensor has an executable adapter and
// write/remote adapters fail before execution when required inputs are absent.
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SENSOR_READING_KINDS, type SensorKind } from '@devai-nyx/sensors';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { SENSE_SENSOR_ADAPTERS, sensorAdapter } from '../../src/commands/sense/adapters.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const LOCAL_READ_KINDS = [
  'test_weakening_review',
  'trace_resolution',
  'perf_test',
  'inventory_api',
  'inventory_routes',
  'inventory_data_model',
  'inventory_rbac',
  'inventory_data_handling',
  'inventory_dep_graph',
  'inventory_coverage',
  'spec_depth',
  'spec_idiomaticity',
  'spec_freshness',
  'plant_coverage',
  'test_coverage_depth',
  'test_invariant_alignment',
  'inventory_adherence',
  'inventory_determinism',
  'harness_security',
  'spec_alignment',
  'spec_security_coverage',
  'spec_performance_targets',
  'spec_robustness_targets',
  'plant_depth',
  'plant_coherence',
  'test_coherence',
  'test_idiomaticity',
  'test_security_coverage',
  'test_performance_coverage',
  'test_robustness_coverage',
  'harness_coverage',
  'harness_depth',
  'harness_coherence',
  'harness_invariant_alignment',
  'harness_idiomaticity',
  'inventory_performance',
  'decision_record_integrity',
  'decision_citation_resolution',
  'archive_immutability',
  'round_record_integrity',
  'docs_drift',
  'site_drift',
] as const satisfies readonly SensorKind[];

describe('sense adapter acceptance', () => {
  it('keeps exact adapter parity with the canonical sensor population', () => {
    expect(Object.keys(SENSE_SENSOR_ADAPTERS).sort()).toEqual([...SENSOR_READING_KINDS].sort());
    for (const kind of SENSOR_READING_KINDS) expect(sensorAdapter(kind)).toBeTypeOf('function');
    expect(() => sensorAdapter('not-a-sensor' as SensorKind)).toThrow(
      'SENSE_ADAPTER_MISSING:not-a-sensor',
    );
  });

  it('executes the complete local read-safe adapter population without implicit persistence', async () => {
    const results = [];
    for (const kind of LOCAL_READ_KINDS) {
      results.push(await withAuthorityHostTestScope(() => sensorAdapter(kind)({ repoRoot: ROOT })));
    }
    expect(results).toHaveLength(LOCAL_READ_KINDS.length);
    expect(results.map((reading) => reading.sensor.kind)).toEqual(LOCAL_READ_KINDS);
    expect(results.every((reading) => typeof reading.status === 'string')).toBe(true);
  }, 120_000);

  it('rejects missing or malformed adapter-specific inputs before remote or DB execution', async () => {
    expect(() => sensorAdapter('llm_judge')({ repoRoot: ROOT })).toThrow(
      'SENSE_MODEL_PROVIDER_REQUIRED',
    );
    await expect(sensorAdapter('runtime_probe_api')({ repoRoot: ROOT })).rejects.toThrow(
      'SENSE_INPUT_REQUIRED:charterPath',
    );
    await expect(
      sensorAdapter('runtime_probe_auth')({
        repoRoot: ROOT,
        inputs: { charterPath: 'missing.json', dryRun: 'yes' },
      }),
    ).rejects.toThrow();
    expect(() =>
      sensorAdapter('migration_check')({ repoRoot: ROOT, inputs: { databaseUrl: 1 } }),
    ).toThrow('SENSE_INPUT_REQUIRED:databaseUrl');
    await expect(sensorAdapter('action_effect_inference')({ repoRoot: ROOT })).rejects.toThrow();
  });
});
