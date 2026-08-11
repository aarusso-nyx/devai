import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { ACTION_EFFECT_CONTRACTS } from '@devai-nyx/effects-check';
import {
  buildSensorReading,
  executeRuntimeProbe,
  loadCharter,
  senseActionEffectInference,
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
  senseInventoryAdherence,
  senseInventoryApi,
  senseInventoryCoverage,
  senseInventoryDataHandling,
  senseInventoryDataModel,
  senseInventoryDepGraph,
  senseInventoryDeterminism,
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
  senseSpecIdiomaticity,
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
  type RuntimeProbeCharter,
  type SensorFinding,
  type SensorKind,
  type SensorReading,
} from '@devai-nyx/sensors';
import {
  archiveImmutability,
  computeReverseAdherence,
  createModelBridge,
  decisionCitationResolution,
  decisionRecordIntegrity,
  loadDomains,
  normalizeCoverage,
  regenerateInventory,
  roundRecordIntegrity,
  validateInvariants,
  type GovernanceIntegrityReport,
} from '#runtime-core';
import { validators } from '@devai-nyx/schemas';
import { rebuildSensorReadings } from './readings-rebuild.js';

export interface SenseAdapterRequest {
  readonly repoRoot: string;
  /** Sensor-specific inputs. The adapter validates required values before use. */
  readonly inputs?: Readonly<Record<string, unknown>>;
}

export type SenseSensorAdapter = (
  request: SenseAdapterRequest,
) => SensorReading | Promise<SensorReading>;

function stringInput(
  request: SenseAdapterRequest,
  name: string,
  options: { readonly required?: boolean } = {},
): string | undefined {
  const value = request.inputs?.[name];
  if (value === undefined && options.required !== true) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`SENSE_INPUT_REQUIRED:${name}`);
  }
  return value;
}

function booleanInput(request: SenseAdapterRequest, name: string): boolean | undefined {
  const value = request.inputs?.[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`SENSE_INPUT_INVALID:${name}`);
  return value;
}

function absolute(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

function governanceReading(
  kind:
    | 'archive_immutability'
    | 'decision_citation_resolution'
    | 'decision_record_integrity'
    | 'round_record_integrity',
  report: GovernanceIntegrityReport,
): SensorReading {
  const findings: SensorFinding[] = report.findings.map((finding) => ({
    severity: 'error',
    code: finding.code,
    message: finding.message,
    ...(finding.path === undefined ? {} : { file: finding.path }),
  }));
  return buildSensorReading({
    sensorName: kind,
    sensorKind: kind,
    command: ['devai', 'sense', 'run', kind],
    status: report.ok ? 'pass' : 'fail',
    deterministic: true,
    tier: 'L0',
    findings,
    metrics: { finding_count: findings.length },
  });
}

function unknownReading(kind: SensorKind, code: string, message: string): SensorReading {
  return buildSensorReading({
    sensorName: kind,
    sensorKind: kind,
    command: ['devai', 'sense', 'run', kind],
    status: 'unknown',
    deterministic: true,
    tier: 'L0',
    findings: [{ severity: 'warning', code, message }],
  });
}

async function inventoryAdherence(request: SenseAdapterRequest): Promise<SensorReading> {
  const inventoryPath = absolute(
    request.repoRoot,
    stringInput(request, 'inventoryPath') ?? '.devai/state/inventory/inventory.json',
  );
  const tracePath = absolute(
    request.repoRoot,
    stringInput(request, 'tracePath') ?? 'law/trace.json',
  );
  if (!existsSync(inventoryPath) || !existsSync(tracePath)) {
    return unknownReading(
      'inventory_adherence',
      'INVENTORY_ADHERENCE_INPUT_MISSING',
      `Required input is absent: ${!existsSync(inventoryPath) ? inventoryPath : tracePath}`,
    );
  }
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8')) as Parameters<
    typeof computeReverseAdherence
  >[0]['inventory'];
  const trace = JSON.parse(readFileSync(tracePath, 'utf8')) as Parameters<
    typeof computeReverseAdherence
  >[0]['trace'];
  return senseInventoryAdherence({ report: computeReverseAdherence({ inventory, trace }) });
}

async function inventoryDeterminism(request: SenseAdapterRequest): Promise<SensorReading> {
  const common = {
    repoRoot: request.repoRoot,
    timestamp: '2026-01-01T00:00:00.000Z',
    integrationHead: '0'.repeat(40),
  };
  const [left, right] = await Promise.all([
    regenerateInventory(common),
    regenerateInventory(common),
  ]);
  return senseInventoryDeterminism({
    canonicalA: JSON.stringify(left),
    canonicalB: JSON.stringify(right),
  });
}

function specIdiomaticity(request: SenseAdapterRequest): SensorReading {
  const invariantsDir = absolute(
    request.repoRoot,
    stringInput(request, 'invariantsDir') ?? 'law/invariants',
  );
  const explicitDomains = stringInput(request, 'domainsPath');
  const candidates = [
    ...(explicitDomains === undefined ? [] : [explicitDomains]),
    'law/glossary/domains.json',
    '.devai/config/domains.json',
  ].map((path) => absolute(request.repoRoot, path));
  const domainsPath = candidates.find((path) => existsSync(path));
  if (domainsPath === undefined) {
    return unknownReading(
      'spec_idiomaticity',
      'DOMAINS_FILE_NOT_FOUND',
      `No domains taxonomy file found. Tried: ${candidates.join(', ')}`,
    );
  }
  const domains = loadDomains(domainsPath);
  return senseSpecIdiomaticity({
    validationResult: validateInvariants({
      invariantsDir,
      domains,
      repoRoot: request.repoRoot,
      strictCnl: true,
    }),
  });
}

async function actionEffectInference(request: SenseAdapterRequest): Promise<SensorReading> {
  const registryPath = absolute(
    request.repoRoot,
    stringInput(request, 'subprocessRegistry') ?? 'law/policy/subprocess-effects.json',
  );
  const subprocessRegistry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
    readonly templates: readonly {
      readonly template_id: string;
      readonly executable: string;
      readonly argv_shape: readonly string[];
      readonly effect: 'read' | 'harness-write' | 'local-write' | 'remote-write';
      readonly reason: string;
      readonly capabilities: readonly string[];
    }[];
  };
  const result = await senseActionEffectInference({
    tsconfigPath: absolute(
      request.repoRoot,
      stringInput(request, 'tsconfigPath') ?? 'tsconfig.effects.json',
    ),
    catalog: ACTION_EFFECT_CONTRACTS.map((entry) => entry.action_id),
    contracts: ACTION_EFFECT_CONTRACTS,
    subprocessRegistry,
  });
  return result.reading;
}

async function runtimeProbe(
  request: SenseAdapterRequest,
  kind: RuntimeProbeCharter['kind'],
): Promise<SensorReading> {
  const charterPath = absolute(
    request.repoRoot,
    stringInput(request, 'charterPath', { required: true }) ?? '',
  );
  const charter = loadCharter(charterPath);
  if (!validators.runtimeCharter(charter)) throw new Error('SENSE_RUNTIME_CHARTER_INVALID');
  if (charter.kind !== kind) throw new Error(`SENSE_RUNTIME_CHARTER_KIND_MISMATCH:${kind}`);
  return (
    await executeRuntimeProbe({
      charter,
      ...(booleanInput(request, 'dryRun') === true ? { dryRun: true } : {}),
    })
  ).reading;
}

const ADAPTERS: Readonly<Record<SensorKind, SenseSensorAdapter>> = Object.freeze({
  type_check: (request) => senseTypeCheck({ cwd: request.repoRoot }).aggregate,
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
  perf_test: (request) => sensePerfTest({ repoRoot: request.repoRoot }),
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
    senseInventoryApi({ repoRoot: request.repoRoot, persistBody: false }).reading,
  inventory_routes: (request) =>
    senseInventoryRoutes({ repoRoot: request.repoRoot, persistBody: false }).reading,
  inventory_data_model: (request) =>
    senseInventoryDataModel({ repoRoot: request.repoRoot, persistBody: false }).reading,
  inventory_rbac: (request) =>
    senseInventoryRbac({ repoRoot: request.repoRoot, persistBody: false }).reading,
  inventory_data_handling: (request) =>
    senseInventoryDataHandling({ repoRoot: request.repoRoot, persistBody: false }).reading,
  inventory_dep_graph: (request) =>
    senseInventoryDepGraph({ repoRoot: request.repoRoot, persistBody: false }).reading,
  inventory_coverage: (request) =>
    senseInventoryCoverage({ repoRoot: request.repoRoot, persistBody: false }).reading,
  spec_depth: (request) => senseSpecDepth({ repoRoot: request.repoRoot }).reading,
  spec_idiomaticity: specIdiomaticity,
  spec_freshness: (request) => senseSpecFreshness({ repoRoot: request.repoRoot }).reading,
  plant_coverage: (request) => sensePlantCoverage({ repoRoot: request.repoRoot }),
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
  test_idiomaticity: (request) => senseTestIdiomaticity({ repoRoot: request.repoRoot }),
  test_security_coverage: (request) => senseTestSecurityCoverage({ repoRoot: request.repoRoot }),
  test_performance_coverage: (request) =>
    senseTestPerformanceCoverage({ repoRoot: request.repoRoot }),
  test_robustness_coverage: (request) =>
    senseTestRobustnessCoverage({ repoRoot: request.repoRoot }),
  harness_coverage: (request) => senseHarnessCoverage({ repoRoot: request.repoRoot }),
  harness_depth: (request) => senseHarnessDepth({ repoRoot: request.repoRoot }),
  harness_coherence: (request) => senseHarnessCoherence({ repoRoot: request.repoRoot }),
  harness_invariant_alignment: (request) =>
    senseHarnessInvariantAlignment({ repoRoot: request.repoRoot }),
  harness_idiomaticity: (request) => senseHarnessIdiomaticity({ repoRoot: request.repoRoot }),
  harness_performance: (request) => senseHarnessPerformance({ repoRoot: request.repoRoot }),
  harness_robustness: (request) => senseHarnessRobustness({ repoRoot: request.repoRoot }),
  inventory_performance: (request) => senseInventoryPerformance({ repoRoot: request.repoRoot }),
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
