import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SensorKind } from '@devai-nyx/sensors';

const sensors = vi.hoisted(() => ({
  executeRuntimeProbe: vi.fn(),
  loadCharter: vi.fn(),
  senseActionEffectInference: vi.fn(),
  senseInventoryAdherence: vi.fn(),
  senseInventoryDeterminism: vi.fn(),
  senseJudge: vi.fn(),
  senseMigrateCheck: vi.fn(),
  senseSpecIdiomaticity: vi.fn(),
  senseTest: vi.fn(),
  senseTestCoverageDepth: vi.fn(),
  senseTypeCheck: vi.fn(),
}));

const runtime = vi.hoisted(() => ({
  archiveImmutability: vi.fn(),
  computeReverseAdherence: vi.fn(),
  createModelBridge: vi.fn(),
  decisionCitationResolution: vi.fn(),
  decisionRecordIntegrity: vi.fn(),
  loadDomains: vi.fn(),
  normalizeCoverage: vi.fn(),
  regenerateInventory: vi.fn(),
  roundRecordIntegrity: vi.fn(),
  validateInvariants: vi.fn(),
}));

const schemas = vi.hoisted(() => ({ runtimeCharter: vi.fn() }));
const local = vi.hoisted(() => ({ rebuildSensorReadings: vi.fn() }));

const simpleSensors = vi.hoisted(() =>
  Object.fromEntries(
    [
      'senseBuild',
      'senseDocsDrift',
      'senseHarnessCoherence',
      'senseHarnessCoverage',
      'senseHarnessDepth',
      'senseHarnessGreenMain',
      'senseHarnessIdiomaticity',
      'senseHarnessInvariantAlignment',
      'senseHarnessPerformance',
      'senseHarnessRobustness',
      'senseHarnessSecurity',
      'senseInventoryApi',
      'senseInventoryCoverage',
      'senseInventoryDataHandling',
      'senseInventoryDataModel',
      'senseInventoryDepGraph',
      'senseInventoryPerformance',
      'senseInventoryRbac',
      'senseInventoryRoutes',
      'senseLint',
      'sensePerfTest',
      'sensePlantCoherence',
      'sensePlantCoverage',
      'sensePlantDepth',
      'senseSecurityScan',
      'senseSiteDrift',
      'senseSpecAlignment',
      'senseSpecDepth',
      'senseSpecFreshness',
      'senseSpecPerformanceTargets',
      'senseSpecRobustnessTargets',
      'senseSpecSecurityCoverage',
      'senseTestCoherence',
      'senseTestCoverageDepth',
      'senseTestIdiomaticity',
      'senseTestInvariantAlignment',
      'senseTestPerformanceCoverage',
      'senseTestRobustnessCoverage',
      'senseTestSecurityCoverage',
      'senseTestWeakening',
      'senseTraceResolve',
    ].map((name) => [
      name,
      vi.fn((input: unknown) => ({ marker: name, input, reading: { marker: name } })),
    ]),
  ),
);

vi.mock('@devai-nyx/sensors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/sensors')>()),
  ...simpleSensors,
  ...sensors,
}));

vi.mock('#runtime-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#runtime-core')>()),
  ...runtime,
}));

vi.mock('@devai-nyx/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/schemas')>();
  return {
    ...actual,
    validators: { ...actual.validators, runtimeCharter: schemas.runtimeCharter },
  };
});

vi.mock('../../src/commands/sense/readings-rebuild.js', () => local);

import { SENSOR_READING_KINDS } from '@devai-nyx/sensors';
import { SENSE_SENSOR_ADAPTERS, sensorAdapter } from '../../src/commands/sense/adapters.js';

const roots: string[] = [];
const originalBackend = process.env['DEVAI_LLM_BACKEND'];
const originalModel = process.env['DEVAI_LLM_MODEL'];

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-sense-adapters-'));
  roots.push(root);
  return root;
}

function put(root: string, path: string, value: unknown): string {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value)}\n`);
  return absolute;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env['DEVAI_LLM_BACKEND'];
  delete process.env['DEVAI_LLM_MODEL'];
});

afterEach(() => {
  if (originalBackend === undefined) delete process.env['DEVAI_LLM_BACKEND'];
  else process.env['DEVAI_LLM_BACKEND'] = originalBackend;
  if (originalModel === undefined) delete process.env['DEVAI_LLM_MODEL'];
  else process.env['DEVAI_LLM_MODEL'] = originalModel;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('sense adapter deterministic boundaries', () => {
  it('retains exact adapter population and refuses an unregistered kind', () => {
    expect(Object.keys(SENSE_SENSOR_ADAPTERS).sort()).toEqual([...SENSOR_READING_KINDS].sort());
    expect(() => sensorAdapter('absent' as SensorKind)).toThrow('SENSE_ADAPTER_MISSING:absent');
  });

  it('binds type, test, and migration inputs without widening persistence', async () => {
    const typeReading = { id: 'type-reading' };
    sensors.senseTypeCheck.mockReturnValue({ aggregate: typeReading });
    expect(await sensorAdapter('type_check')({ repoRoot: '/repo' })).toBe(typeReading);
    expect(sensors.senseTypeCheck).toHaveBeenCalledWith({ cwd: '/repo' });

    for (const [kind, suite] of [
      ['unit_test', 'unit'],
      ['integration_test', 'integration'],
      ['e2e_test', 'e2e'],
    ] as const) {
      const marker = { kind };
      sensors.senseTest.mockReturnValueOnce(marker);
      expect(await sensorAdapter(kind)({ repoRoot: '/repo' })).toBe(marker);
      expect(sensors.senseTest).toHaveBeenLastCalledWith({ cwd: '/repo', suite });
    }

    sensors.senseMigrateCheck.mockReturnValue({ id: 'migration' });
    await sensorAdapter('migration_check')({ repoRoot: '/repo' });
    expect(sensors.senseMigrateCheck).toHaveBeenLastCalledWith({
      cwd: '/repo',
      persistBody: false,
    });
    await sensorAdapter('migration_check')({
      repoRoot: '/repo',
      inputs: { databaseUrl: 'postgres://fixture' },
    });
    expect(sensors.senseMigrateCheck).toHaveBeenLastCalledWith({
      cwd: '/repo',
      persistBody: false,
      databaseUrl: 'postgres://fixture',
    });
    expect(() =>
      sensorAdapter('migration_check')({ repoRoot: '/repo', inputs: { databaseUrl: 1 } }),
    ).toThrow('SENSE_INPUT_REQUIRED:databaseUrl');
  });

  it('delegates the complete simple read-sensor surface with exact repository inputs', async () => {
    const cases = [
      ['lint', 'senseLint', { cwd: '/repo' }, false],
      ['build', 'senseBuild', { cwd: '/repo' }, false],
      ['test_weakening_review', 'senseTestWeakening', { cwd: '/repo' }, false],
      ['trace_resolution', 'senseTraceResolve', { repoRoot: '/repo' }, false],
      ['security_scan', 'senseSecurityScan', { repoRoot: '/repo' }, false],
      ['perf_test', 'sensePerfTest', { repoRoot: '/repo' }, false],
      ['inventory_api', 'senseInventoryApi', { repoRoot: '/repo', persistBody: false }, true],
      ['inventory_routes', 'senseInventoryRoutes', { repoRoot: '/repo', persistBody: false }, true],
      [
        'inventory_data_model',
        'senseInventoryDataModel',
        { repoRoot: '/repo', persistBody: false },
        true,
      ],
      ['inventory_rbac', 'senseInventoryRbac', { repoRoot: '/repo', persistBody: false }, true],
      [
        'inventory_data_handling',
        'senseInventoryDataHandling',
        { repoRoot: '/repo', persistBody: false },
        true,
      ],
      [
        'inventory_dep_graph',
        'senseInventoryDepGraph',
        { repoRoot: '/repo', persistBody: false },
        true,
      ],
      [
        'inventory_coverage',
        'senseInventoryCoverage',
        { repoRoot: '/repo', persistBody: false },
        true,
      ],
      ['spec_depth', 'senseSpecDepth', { repoRoot: '/repo' }, true],
      ['spec_freshness', 'senseSpecFreshness', { repoRoot: '/repo' }, true],
      ['plant_coverage', 'sensePlantCoverage', { repoRoot: '/repo' }, false],
      ['test_invariant_alignment', 'senseTestInvariantAlignment', { repoRoot: '/repo' }, false],
      ['harness_security', 'senseHarnessSecurity', { repoRoot: '/repo' }, true],
      ['harness_green_main', 'senseHarnessGreenMain', { repoRoot: '/repo' }, false],
      ['spec_alignment', 'senseSpecAlignment', { repoRoot: '/repo' }, false],
      ['spec_security_coverage', 'senseSpecSecurityCoverage', { repoRoot: '/repo' }, false],
      ['spec_performance_targets', 'senseSpecPerformanceTargets', { repoRoot: '/repo' }, false],
      ['spec_robustness_targets', 'senseSpecRobustnessTargets', { repoRoot: '/repo' }, false],
      ['plant_depth', 'sensePlantDepth', { repoRoot: '/repo' }, false],
      ['plant_coherence', 'sensePlantCoherence', { repoRoot: '/repo' }, false],
      ['test_coherence', 'senseTestCoherence', { repoRoot: '/repo' }, false],
      ['test_idiomaticity', 'senseTestIdiomaticity', { repoRoot: '/repo' }, false],
      ['test_security_coverage', 'senseTestSecurityCoverage', { repoRoot: '/repo' }, false],
      ['test_performance_coverage', 'senseTestPerformanceCoverage', { repoRoot: '/repo' }, false],
      ['test_robustness_coverage', 'senseTestRobustnessCoverage', { repoRoot: '/repo' }, false],
      ['harness_coverage', 'senseHarnessCoverage', { repoRoot: '/repo' }, false],
      ['harness_depth', 'senseHarnessDepth', { repoRoot: '/repo' }, false],
      ['harness_coherence', 'senseHarnessCoherence', { repoRoot: '/repo' }, false],
      [
        'harness_invariant_alignment',
        'senseHarnessInvariantAlignment',
        { repoRoot: '/repo' },
        false,
      ],
      ['harness_idiomaticity', 'senseHarnessIdiomaticity', { repoRoot: '/repo' }, false],
      ['harness_performance', 'senseHarnessPerformance', { repoRoot: '/repo' }, false],
      ['harness_robustness', 'senseHarnessRobustness', { repoRoot: '/repo' }, false],
      ['inventory_performance', 'senseInventoryPerformance', { repoRoot: '/repo' }, false],
      ['docs_drift', 'senseDocsDrift', { repoRoot: '/repo' }, false],
      ['site_drift', 'senseSiteDrift', { repoRoot: '/repo' }, false],
    ] as const;

    for (const [kind, delegateName, expectedInput, returnsReading] of cases) {
      const delegate = simpleSensors[delegateName];
      if (delegate === undefined) throw new Error(`missing test delegate: ${delegateName}`);
      const result = await sensorAdapter(kind)({ repoRoot: '/repo' });
      expect(delegate).toHaveBeenCalledWith(expectedInput);
      expect(result).toEqual(
        returnsReading
          ? { marker: delegateName }
          : { marker: delegateName, input: expectedInput, reading: { marker: delegateName } },
      );
    }
  });

  it('reports the precise missing inventory input and computes adherence when complete', async () => {
    const root = repository();
    const missingInventory = await sensorAdapter('inventory_adherence')({ repoRoot: root });
    expect(missingInventory).toMatchObject({
      status: 'unknown',
      findings: [
        {
          code: 'INVENTORY_ADHERENCE_INPUT_MISSING',
          message: expect.stringContaining(join(root, '.devai/state/inventory/inventory.json')),
        },
      ],
    });

    put(root, '.devai/state/inventory/inventory.json', { modules: [] });
    const missingTrace = await sensorAdapter('inventory_adherence')({ repoRoot: root });
    expect(missingTrace.findings[0]?.message).toContain(join(root, 'law/trace.json'));

    put(root, 'law/trace.json', { links: [] });
    const report = { ok: true, matches: [] };
    const reading = { id: 'adherence-reading' };
    runtime.computeReverseAdherence.mockReturnValue(report);
    sensors.senseInventoryAdherence.mockReturnValue(reading);
    expect(await sensorAdapter('inventory_adherence')({ repoRoot: root })).toBe(reading);
    expect(runtime.computeReverseAdherence).toHaveBeenCalledWith({
      inventory: { modules: [] },
      trace: { links: [] },
    });
    expect(sensors.senseInventoryAdherence).toHaveBeenCalledWith({ report });
  });

  it('runs deterministic inventory generation twice with identical fixed identity inputs', async () => {
    runtime.regenerateInventory
      .mockResolvedValueOnce({ order: 1 })
      .mockResolvedValueOnce({ order: 1 });
    sensors.senseInventoryDeterminism.mockReturnValue({ id: 'determinism' });
    expect(await sensorAdapter('inventory_determinism')({ repoRoot: '/repo' })).toEqual({
      id: 'determinism',
    });
    expect(runtime.regenerateInventory).toHaveBeenCalledTimes(2);
    expect(runtime.regenerateInventory).toHaveBeenNthCalledWith(1, {
      repoRoot: '/repo',
      timestamp: '2026-01-01T00:00:00.000Z',
      integrationHead: '0'.repeat(40),
    });
    expect(sensors.senseInventoryDeterminism).toHaveBeenCalledWith({
      canonicalA: '{"order":1}',
      canonicalB: '{"order":1}',
    });
  });

  it('returns the persisted reading from inventory regeneration', async () => {
    const reading = { id: 'regenerated-reading' };
    local.rebuildSensorReadings.mockResolvedValue({ reading });
    expect(await sensorAdapter('inventory_regeneration')({ repoRoot: '/repo' })).toBe(reading);
    expect(local.rebuildSensorReadings).toHaveBeenCalledWith('/repo');
  });

  it('uses an explicit domains path and reports all attempted defaults when absent', async () => {
    const root = repository();
    const absent = await sensorAdapter('spec_idiomaticity')({ repoRoot: root });
    expect(absent).toMatchObject({
      status: 'unknown',
      findings: [
        { code: 'DOMAINS_FILE_NOT_FOUND', message: expect.stringContaining('domains.json') },
      ],
    });

    const domainsPath = put(root, 'custom/domains.json', { domains: ['core'] });
    runtime.loadDomains.mockReturnValue({ core: true });
    runtime.validateInvariants.mockReturnValue({ ok: true });
    sensors.senseSpecIdiomaticity.mockReturnValue({ id: 'idiomaticity' });
    expect(
      await sensorAdapter('spec_idiomaticity')({
        repoRoot: root,
        inputs: { domainsPath, invariantsDir: 'custom/invariants' },
      }),
    ).toEqual({ id: 'idiomaticity' });
    expect(runtime.loadDomains).toHaveBeenCalledWith(domainsPath);
    expect(runtime.validateInvariants).toHaveBeenCalledWith({
      invariantsDir: join(root, 'custom/invariants'),
      domains: { core: true },
      repoRoot: root,
      strictCnl: true,
    });
  });

  it('validates runtime-probe charter identity and forwards only boolean dry-run consent', async () => {
    const root = repository();
    const charterPath = put(root, 'charter.json', { kind: 'api' });
    sensors.loadCharter.mockReturnValue({ kind: 'api', id: 'charter' });
    schemas.runtimeCharter.mockReturnValue(false);
    await expect(
      sensorAdapter('runtime_probe_api')({ repoRoot: root, inputs: { charterPath } }),
    ).rejects.toThrow('SENSE_RUNTIME_CHARTER_INVALID');

    schemas.runtimeCharter.mockReturnValue(true);
    await expect(
      sensorAdapter('runtime_probe_auth')({ repoRoot: root, inputs: { charterPath } }),
    ).rejects.toThrow('SENSE_RUNTIME_CHARTER_KIND_MISMATCH:auth');

    const probeReading = { id: 'probe-reading' };
    sensors.executeRuntimeProbe.mockResolvedValue({ reading: probeReading });
    expect(
      await sensorAdapter('runtime_probe_api')({
        repoRoot: root,
        inputs: { charterPath: 'charter.json', dryRun: true },
      }),
    ).toBe(probeReading);
    expect(sensors.executeRuntimeProbe).toHaveBeenCalledWith({
      charter: { kind: 'api', id: 'charter' },
      dryRun: true,
    });
    await expect(
      sensorAdapter('runtime_probe_api')({
        repoRoot: root,
        inputs: { charterPath, dryRun: 'yes' },
      }),
    ).rejects.toThrow('SENSE_INPUT_INVALID:dryRun');

    sensors.loadCharter.mockReturnValue({ kind: 'data', id: 'data-charter' });
    expect(
      await sensorAdapter('runtime_probe_data')({ repoRoot: root, inputs: { charterPath } }),
    ).toBe(probeReading);
    expect(sensors.executeRuntimeProbe).toHaveBeenLastCalledWith({
      charter: { kind: 'data', id: 'data-charter' },
    });
  });

  it('normalizes governance reports into exact pass/fail readings and file findings', async () => {
    runtime.decisionRecordIntegrity.mockReturnValue({
      ok: false,
      findings: [
        { code: 'DECISION_INVALID', message: 'invalid decision', path: 'law/decisions/D-1.md' },
        { code: 'DECISION_MISSING', message: 'missing decision' },
      ],
    });
    const failed = await sensorAdapter('decision_record_integrity')({ repoRoot: '/repo' });
    expect(failed).toMatchObject({
      status: 'fail',
      metrics: { finding_count: 2 },
      findings: [
        { severity: 'error', code: 'DECISION_INVALID', file: 'law/decisions/D-1.md' },
        { severity: 'error', code: 'DECISION_MISSING' },
      ],
    });

    runtime.archiveImmutability.mockReturnValue({ ok: true, findings: [] });
    const passed = await sensorAdapter('archive_immutability')({ repoRoot: '/repo' });
    expect(passed).toMatchObject({ status: 'pass', metrics: { finding_count: 0 }, findings: [] });

    runtime.decisionCitationResolution.mockReturnValue({ ok: true, findings: [] });
    expect(
      await sensorAdapter('decision_citation_resolution')({ repoRoot: '/repo' }),
    ).toMatchObject({ status: 'pass', sensor: { kind: 'decision_citation_resolution' } });
    runtime.roundRecordIntegrity.mockReturnValue({ ok: true, findings: [] });
    expect(await sensorAdapter('round_record_integrity')({ repoRoot: '/repo' })).toMatchObject({
      status: 'pass',
      sensor: { kind: 'round_record_integrity' },
    });
  });

  it('binds LLM judge inputs to the selected model bridge and rejects incomplete selection', async () => {
    expect(() => sensorAdapter('llm_judge')({ repoRoot: '/repo' })).toThrow(
      'SENSE_MODEL_PROVIDER_REQUIRED',
    );
    expect(() =>
      sensorAdapter('llm_judge')({ repoRoot: '/repo', inputs: { family: 'claude' } }),
    ).toThrow('SENSE_MODEL_NAME_REQUIRED');

    const bridge = { id: 'bridge' };
    const reading = { id: 'judge-reading' };
    runtime.createModelBridge.mockReturnValue(bridge);
    sensors.senseJudge.mockReturnValue(reading);
    expect(
      await sensorAdapter('llm_judge')({
        repoRoot: '/repo',
        inputs: {
          family: 'codex-cli',
          model: 'gpt-test',
          aspect: 'correctness',
          rubric: 'exact',
          evidence: 'E-1',
        },
      }),
    ).toBe(reading);
    expect(runtime.createModelBridge).toHaveBeenCalledWith({
      provider: 'codex-cli',
      model: 'gpt-test',
    });
    expect(sensors.senseJudge).toHaveBeenCalledWith(
      { aspect: 'correctness', rubric: 'exact', evidence: 'E-1' },
      bridge,
    );
    expect(() =>
      sensorAdapter('llm_judge')({
        repoRoot: '/repo',
        inputs: { family: 'codex', model: 'm', rubric: 'r', evidence: 'e' },
      }),
    ).toThrow('SENSE_INPUT_REQUIRED:aspect');
  });

  it('loads action-effect and coverage inputs from exact resolved paths', async () => {
    const root = repository();
    put(root, 'policy/subprocess.json', { templates: [] });
    const effectReading = { id: 'effect-reading' };
    sensors.senseActionEffectInference.mockResolvedValue({ reading: effectReading });
    expect(
      await sensorAdapter('action_effect_inference')({
        repoRoot: root,
        inputs: { subprocessRegistry: 'policy/subprocess.json', tsconfigPath: 'tsconfig.x.json' },
      }),
    ).toBe(effectReading);
    expect(sensors.senseActionEffectInference).toHaveBeenCalledWith(
      expect.objectContaining({
        tsconfigPath: join(root, 'tsconfig.x.json'),
        subprocessRegistry: { templates: [] },
      }),
    );

    runtime.normalizeCoverage.mockReturnValue({
      summary: { lines_total: 10, lines_covered: 8, branches_total: 2 },
    });
    sensors.senseTestCoverageDepth.mockReturnValue({ id: 'coverage-reading' });
    expect(
      await sensorAdapter('test_coverage_depth')({
        repoRoot: root,
        inputs: { coveragePath: '/absolute/coverage.json' },
      }),
    ).toEqual({ id: 'coverage-reading' });
    expect(runtime.normalizeCoverage).toHaveBeenCalledWith({
      coveragePath: '/absolute/coverage.json',
    });
    expect(sensors.senseTestCoverageDepth).toHaveBeenCalledWith({
      summary: { lines_total: 10, lines_covered: 8 },
      coveragePath: '/absolute/coverage.json',
    });
  });
});
