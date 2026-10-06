// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
// Inspector acceptance: every local read sensor has an executable adapter and
// write/remote adapters fail before execution when required inputs are absent.
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SENSOR_READING_KINDS, type SensorKind } from '@devai-nyx/sensors';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { SENSE_SENSOR_ADAPTERS, sensorAdapter } from '../../src/commands/sense/adapters.js';
import { resolveDeclaredSensorInputs } from '../../src/commands/sense/shared.js';

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

  // One case per local read sensor, each bounded on its own (#246). As a single 42-sensor
  // loop over the real repository the sweep cost 107 s at load average 65 against a 120 s
  // bound, and a timeout named no sensor. Every adapter still runs in the same order with the
  // inputs the repository declares, and each case keeps the loop's assertions for its own
  // reading. The shared bound is sized for the costliest member, decision_record_integrity,
  // whose history scan measures 30 s alone and 83 s at load average 200.
  it.each(LOCAL_READ_KINDS)(
    'executes the local read-safe adapter %s without implicit persistence',
    async (kind) => {
      // Read-safe under the inputs the repository declares, as `sense run` calls the adapters.
      const inputs = resolveDeclaredSensorInputs({ repoRoot: ROOT, sensorKind: kind });
      const reading = await withAuthorityHostTestScope(() =>
        sensorAdapter(kind)({ repoRoot: ROOT, inputs }),
      );
      expect(reading.sensor.kind).toBe(kind);
      expect(typeof reading.status).toBe('string');
    },
    240_000,
  );

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
    await expect(
      sensorAdapter('action_effect_inference')({
        repoRoot: ROOT,
        inputs: { subprocessRegistry: 'missing.json' },
      }),
    ).resolves.toMatchObject({ status: 'unknown' });
  });
});
