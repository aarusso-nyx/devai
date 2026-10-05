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
  measureTestCoverageDepth,
  SENSOR_READING_KINDS,
  type HarnessRobustnessOptions,
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

import { regenerateInventoryReadings } from './readings-rebuild.js';
import {
  type SenseAdapterRequest,
  type SenseSensorAdapter,
  optional,
  stringArrayInput,
  stringInput,
  integerInput,
  runtimeProbe,
  surfacesInput,
  specIdiomaticity,
  absolute,
  inventoryAdherence,
  inventoryDeterminism,
  governanceReading,
  actionEffectInference,
  observeExactHeadScorecard,
} from './adapter-readers.js';
export type { SenseAdapterRequest, SenseSensorAdapter } from './adapter-readers.js';

/**
 * The declared CI population of a harness sensor (ADR-SCR-0010), forwarded from
 * .devai/config/sensor-inputs.json. The schema requires workflow, event, and minimumSample;
 * a run without them is refused here as a missing input, never defaulted.
 */
export function harnessPopulationInput(
  request: SenseAdapterRequest,
): Omit<HarnessRobustnessOptions, 'thresholds'> {
  const attemptsInput = stringInput(request, 'attempts');
  if (attemptsInput !== undefined && attemptsInput !== 'last' && attemptsInput !== 'all') {
    throw new Error('SENSE_INPUT_INVALID:attempts');
  }
  const attempts: 'last' | 'all' | undefined = attemptsInput;
  const includeCancelled = request.inputs?.['includeCancelled'];
  if (includeCancelled !== undefined && typeof includeCancelled !== 'boolean') {
    throw new Error('SENSE_INPUT_INVALID:includeCancelled');
  }
  const minimumSample = integerInput(request, 'minimumSample');
  if (minimumSample === undefined) throw new Error('SENSE_INPUT_REQUIRED:minimumSample');
  const excluded = request.inputs?.['excludedJobs'];
  if (excluded !== undefined && !Array.isArray(excluded)) {
    throw new Error('SENSE_INPUT_INVALID:excludedJobs');
  }
  const excludedJobs = ((excluded ?? []) as unknown[]).map((pair) => {
    const record = pair as Record<string, unknown> | null;
    if (typeof record?.['workflow'] !== 'string' || typeof record['job'] !== 'string') {
      throw new Error('SENSE_INPUT_INVALID:excludedJobs');
    }
    return { workflow: record['workflow'], job: record['job'] };
  });
  return {
    repoRoot: request.repoRoot,
    workflow: stringInput(request, 'workflow', { required: true }) as string,
    event: stringInput(request, 'event', { required: true }) as string,
    minimumSample,
    excludedJobs,
    ...optional('headBranch', stringInput(request, 'headBranch')),
    ...optional('baseBranch', stringInput(request, 'baseBranch')),
    ...optional('attempts', attempts),
    ...optional('includeCancelled', includeCancelled),
    ...optional('lookbackDays', integerInput(request, 'lookbackDays')),
  };
}

const ADAPTERS: Readonly<Record<SensorKind, SenseSensorAdapter>> = Object.freeze({
  type_check: (request) =>
    senseTypeCheck({
      cwd: request.repoRoot,
      ...optional('argv', stringArrayInput(request, 'argv')),
    }).aggregate,
  lint: (request) => senseLint({ cwd: request.repoRoot }),
  // ADR-AUT-0002: the declared build argv and cwd; build.ts applies the descriptor-first
  // precedence and reads BUILD_ARGV_CONFLICT for a declaration that differs from it.
  build: (request) =>
    senseBuild({
      cwd: request.repoRoot,
      ...optional('argv', stringArrayInput(request, 'argv')),
      ...optional('buildCwd', stringInput(request, 'cwd')),
    }),
  unit_test: (request) =>
    senseTest({
      cwd: request.repoRoot,
      suite: 'unit',
      ...optional('argv', stringArrayInput(request, 'argv')),
    }),
  integration_test: (request) =>
    senseTest({
      cwd: request.repoRoot,
      suite: 'integration',
      ...optional('argv', stringArrayInput(request, 'argv')),
    }),
  e2e_test: (request) =>
    senseTest({
      cwd: request.repoRoot,
      suite: 'e2e',
      ...optional('argv', stringArrayInput(request, 'argv')),
    }),
  migration_check: (request) =>
    senseMigrateCheck({
      cwd: request.repoRoot,
      persistBody: false,
      ...(stringInput(request, 'databaseUrl') === undefined
        ? {}
        : { databaseUrl: stringInput(request, 'databaseUrl') }),
    }),
  // #237: regenerate the inventory bodies from source under the declared surfaces.
  inventory_regeneration: async (request) =>
    (
      await regenerateInventoryReadings(request.repoRoot, {
        ...optional('surfaces', surfacesInput(request)),
      })
    ).reading,
  test_weakening_review: (request) => senseTestWeakening({ cwd: request.repoRoot }),
  trace_resolution: (request) => senseTraceResolve({ repoRoot: request.repoRoot }),
  security_scan: (request) => senseSecurityScan({ repoRoot: request.repoRoot }),
  perf_test: (request) =>
    sensePerfTest({
      repoRoot: request.repoRoot,
      ...optional('argv', stringArrayInput(request, 'argv')),
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
    // ADR-SCR-0007: a declared population routes to the producer-running measurement,
    // which reads the population sidecar and states the population in its reading.
    const population = stringInput(request, 'population');
    if (population !== undefined) {
      return measureTestCoverageDepth({
        repoRoot: request.repoRoot,
        coveragePath: stringInput(request, 'coveragePath', { required: true }) ?? '',
        population,
        exclusions: stringArrayInput(request, 'exclusions') ?? [],
      });
    }
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
  harness_green_main: (request) =>
    senseHarnessGreenMain({
      ...harnessPopulationInput(request),
      ...optional('since', stringInput(request, 'since')),
    }),
  spec_alignment: (request) => senseSpecAlignment({ repoRoot: request.repoRoot }),
  spec_security_coverage: (request) => senseSpecSecurityCoverage({ repoRoot: request.repoRoot }),
  spec_performance_targets: (request) =>
    senseSpecPerformanceTargets({ repoRoot: request.repoRoot }),
  spec_robustness_targets: (request) => senseSpecRobustnessTargets({ repoRoot: request.repoRoot }),
  plant_depth: (request) =>
    sensePlantDepth({
      repoRoot: request.repoRoot,
      ...optional('excludeGlobs', stringArrayInput(request, 'excludeGlobs')),
    }),
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
    senseHarnessInvariantAlignment({
      repoRoot: request.repoRoot,
      observations: observeExactHeadScorecard(request.repoRoot),
    }),
  harness_idiomaticity: (request) =>
    senseHarnessIdiomaticity({
      repoRoot: request.repoRoot,
      ...optional(
        'minWorkflowsForReusableCheck',
        integerInput(request, 'minWorkflowsForReusableCheck'),
      ),
    }),
  harness_performance: (request) => senseHarnessPerformance(harnessPopulationInput(request)),
  harness_robustness: (request) => senseHarnessRobustness(harnessPopulationInput(request)),
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
