import {
  senseBuild,
  senseDocsDrift,
  senseHarnessCoherence,
  senseHarnessCoverage,
  senseHarnessDepth,
  senseHarnessGreenMain,
  senseHarnessIdiomaticity,
  senseHarnessInvariantAlignment,
  senseHarnessPerformance,
  senseHarnessRobustness,
  senseHarnessSecurity,
  senseInventoryApi,
  senseInventoryCoverage,
  senseInventoryDataHandling,
  senseInventoryDataModel,
  senseInventoryDepGraph,
  senseInventoryPerformance,
  senseInventoryRbac,
  senseInventoryRoutes,
  senseJudge,
  senseLint,
  senseMigrateCheck,
  sensePerfTest,
  sensePlantCoherence,
  sensePlantCoverage,
  sensePlantDepth,
  senseSecurityScan,
  senseSiteDrift,
  senseSpecAlignment,
  senseSpecDepth,
  senseSpecFreshness,
  senseSpecPerformanceTargets,
  senseSpecRobustnessTargets,
  senseSpecSecurityCoverage,
  senseTest,
  senseTestCoherence,
  senseTestCoverageDepth,
  senseTestIdiomaticity,
  senseTestInvariantAlignment,
  senseTestPerformanceCoverage,
  senseTestRobustnessCoverage,
  senseTestSecurityCoverage,
  senseTestWeakening,
  senseTraceResolve,
  senseTypeCheck,
  SENSOR_READING_KINDS,
  type SensorKind,
} from '@devai-nyx/sensors';
import {
  archiveImmutability,
  createModelBridge,
  decisionCitationResolution,
  decisionRecordIntegrity,
  normalizeCoverage,
  roundRecordIntegrity,
} from '#runtime-core';

import { rebuildSensorReadings } from './readings-rebuild.js';
import {
  type SenseSensorAdapter,
  optional,
  stringArrayInput,
  stringInput,
  runtimeProbe,
  surfacesInput,
  specIdiomaticity,
  absolute,
  inventoryAdherence,
  inventoryDeterminism,
  governanceReading,
  actionEffectInference,
} from './adapter-readers.js';
export type { SenseAdapterRequest, SenseSensorAdapter } from './adapter-readers.js';

const ADAPTERS: Readonly<Record<SensorKind, SenseSensorAdapter>> = Object.freeze({
  type_check: (request) =>
    senseTypeCheck({
      cwd: request.repoRoot,
      ...optional('argv', stringArrayInput(request, 'argv')),
    }).aggregate,
  lint: (request) => senseLint({ cwd: request.repoRoot }),
  build: (request) => senseBuild({ cwd: request.repoRoot }),
  unit_test: (request) => senseTest({ cwd: request.repoRoot, suite: 'unit' }),
  integration_test: (request) => senseTest({ cwd: request.repoRoot, suite: 'integration' }),
  e2e_test: (request) => senseTest({ cwd: request.repoRoot, suite: 'e2e' }),
  migration_check: (request) =>
    senseMigrateCheck({
      cwd: request.repoRoot,
      persistBody: false,
      ...(stringInput(request, 'databaseUrl') === undefined
        ? {}
        : { databaseUrl: stringInput(request, 'databaseUrl') }),
    }),
  inventory_regeneration: async (request) =>
    (await rebuildSensorReadings(request.repoRoot)).reading,
  test_weakening_review: (request) => senseTestWeakening({ cwd: request.repoRoot }),
  trace_resolution: (request) => senseTraceResolve({ repoRoot: request.repoRoot }),
  security_scan: (request) => senseSecurityScan({ repoRoot: request.repoRoot }),
  perf_test: (request) =>
    sensePerfTest({
      repoRoot: request.repoRoot,
      ...optional('scriptName', stringInput(request, 'scriptName')),
    }),
  llm_judge: (request) => {
    const provider = stringInput(request, 'family') ?? process.env.DEVAI_LLM_BACKEND;
    const model = stringInput(request, 'model') ?? process.env.DEVAI_LLM_MODEL;
    if (!['claude', 'codex', 'claude-cli', 'codex-cli'].includes(provider ?? '')) {
      throw new Error('SENSE_MODEL_PROVIDER_REQUIRED');
    }
    if (model === undefined) throw new Error('SENSE_MODEL_NAME_REQUIRED');
    return senseJudge(
      {
        aspect: stringInput(request, 'aspect', { required: true }) ?? '',
        rubric: stringInput(request, 'rubric', { required: true }) ?? '',
        evidence: stringInput(request, 'evidence', { required: true }) ?? '',
      },
      createModelBridge({
        provider: provider as 'claude' | 'codex' | 'claude-cli' | 'codex-cli',
        model,
      }),
    );
  },
  runtime_probe_api: (request) => runtimeProbe(request, 'api'),
  runtime_probe_auth: (request) => runtimeProbe(request, 'auth'),
  runtime_probe_data: (request) => runtimeProbe(request, 'data'),
  inventory_api: (request) =>
    senseInventoryApi({
      repoRoot: request.repoRoot,
      persistBody: false,
      ...optional('surfaces', surfacesInput(request)),
    }).reading,
  inventory_routes: (request) =>
    senseInventoryRoutes({
      repoRoot: request.repoRoot,
      persistBody: false,
      ...optional('surfaces', surfacesInput(request)),
    }).reading,
  inventory_data_model: (request) =>
    senseInventoryDataModel({
      repoRoot: request.repoRoot,
      persistBody: false,
      ...optional('surfaces', surfacesInput(request)),
    }).reading,
  inventory_rbac: (request) =>
    senseInventoryRbac({
      repoRoot: request.repoRoot,
      persistBody: false,
      ...optional('surfaces', surfacesInput(request)),
    }).reading,
  inventory_data_handling: (request) =>
    senseInventoryDataHandling({
      repoRoot: request.repoRoot,
      persistBody: false,
      ...optional('surfaces', surfacesInput(request)),
    }).reading,
  inventory_dep_graph: (request) =>
    senseInventoryDepGraph({ repoRoot: request.repoRoot, persistBody: false }).reading,
  inventory_coverage: (request) =>
    senseInventoryCoverage({
      repoRoot: request.repoRoot,
      persistBody: false,
      ...optional('surfaces', surfacesInput(request)),
    }).reading,
  spec_depth: (request) =>
    senseSpecDepth({
      repoRoot: request.repoRoot,
      ...optional('adrDir', stringInput(request, 'adrDir')),
      ...optional('invariantsDir', stringInput(request, 'invariantsDir')),
    }).reading,
  spec_idiomaticity: specIdiomaticity,
  spec_freshness: (request) => senseSpecFreshness({ repoRoot: request.repoRoot }).reading,
  plant_coverage: (request) =>
    sensePlantCoverage({
      repoRoot: request.repoRoot,
      ...optional('surfaces', surfacesInput(request)),
    }),
  test_coverage_depth: (request) => {
    const coveragePath = absolute(
      request.repoRoot,
      stringInput(request, 'coveragePath') ?? 'coverage/coverage-final.json',
    );
    const result = normalizeCoverage({ coveragePath });
    return senseTestCoverageDepth({
      summary:
        result.summary === null
          ? null
          : {
              lines_total: result.summary.lines_total,
              lines_covered: result.summary.lines_covered,
            },
      coveragePath,
    });
  },
  test_invariant_alignment: (request) =>
    senseTestInvariantAlignment({ repoRoot: request.repoRoot }),
  inventory_adherence: inventoryAdherence,
  inventory_determinism: inventoryDeterminism,
  harness_security: (request) => senseHarnessSecurity({ repoRoot: request.repoRoot }).reading,
  harness_green_main: (request) => senseHarnessGreenMain({ repoRoot: request.repoRoot }),
  spec_alignment: (request) => senseSpecAlignment({ repoRoot: request.repoRoot }),
  spec_security_coverage: (request) => senseSpecSecurityCoverage({ repoRoot: request.repoRoot }),
  spec_performance_targets: (request) =>
    senseSpecPerformanceTargets({ repoRoot: request.repoRoot }),
  spec_robustness_targets: (request) => senseSpecRobustnessTargets({ repoRoot: request.repoRoot }),
  plant_depth: (request) => sensePlantDepth({ repoRoot: request.repoRoot }),
  plant_coherence: (request) => sensePlantCoherence({ repoRoot: request.repoRoot }),
  test_coherence: (request) => senseTestCoherence({ repoRoot: request.repoRoot }),
  test_idiomaticity: (request) =>
    senseTestIdiomaticity({
      repoRoot: request.repoRoot,
      ...optional('testGlobs', stringArrayInput(request, 'testGlobs')),
    }),
  test_security_coverage: (request) =>
    senseTestSecurityCoverage({
      repoRoot: request.repoRoot,
      ...optional('testGlobs', stringArrayInput(request, 'testGlobs')),
    }),
  test_performance_coverage: (request) =>
    senseTestPerformanceCoverage({
      repoRoot: request.repoRoot,
      ...optional('testGlobs', stringArrayInput(request, 'testGlobs')),
    }),
  test_robustness_coverage: (request) =>
    senseTestRobustnessCoverage({
      repoRoot: request.repoRoot,
      ...optional('testGlobs', stringArrayInput(request, 'testGlobs')),
    }),
  harness_coverage: (request) => senseHarnessCoverage({ repoRoot: request.repoRoot }),
  harness_depth: (request) => senseHarnessDepth({ repoRoot: request.repoRoot }),
  harness_coherence: (request) => senseHarnessCoherence({ repoRoot: request.repoRoot }),
  harness_invariant_alignment: (request) =>
    senseHarnessInvariantAlignment({ repoRoot: request.repoRoot }),
  harness_idiomaticity: (request) => senseHarnessIdiomaticity({ repoRoot: request.repoRoot }),
  harness_performance: (request) => senseHarnessPerformance({ repoRoot: request.repoRoot }),
  harness_robustness: (request) => senseHarnessRobustness({ repoRoot: request.repoRoot }),
  inventory_performance: (request) =>
    senseInventoryPerformance({
      repoRoot: request.repoRoot,
      ...optional('surfaces', surfacesInput(request)),
    }),
  decision_record_integrity: (request) =>
    governanceReading(
      'decision_record_integrity',
      decisionRecordIntegrity({ repoRoot: request.repoRoot }),
    ),
  decision_citation_resolution: (request) =>
    governanceReading(
      'decision_citation_resolution',
      decisionCitationResolution({ repoRoot: request.repoRoot }),
    ),
  archive_immutability: (request) =>
    governanceReading('archive_immutability', archiveImmutability({ repoRoot: request.repoRoot })),
  round_record_integrity: (request) =>
    governanceReading(
      'round_record_integrity',
      roundRecordIntegrity({ repoRoot: request.repoRoot }),
    ),
  docs_drift: (request) => senseDocsDrift({ repoRoot: request.repoRoot }),
  site_drift: (request) => senseSiteDrift({ repoRoot: request.repoRoot }),
  action_effect_inference: actionEffectInference,
});

const adapterKinds = Object.keys(ADAPTERS).sort();
const registeredKinds = [...SENSOR_READING_KINDS].sort();
if (JSON.stringify(adapterKinds) !== JSON.stringify(registeredKinds)) {
  throw new Error('SENSE_ADAPTER_POPULATION_DIVERGENCE');
}

export const SENSE_SENSOR_ADAPTERS = ADAPTERS;

export function sensorAdapter(kind: SensorKind): SenseSensorAdapter {
  const adapter = ADAPTERS[kind];
  if (adapter === undefined) throw new Error(`SENSE_ADAPTER_MISSING:${kind}`);
  return adapter;
}
