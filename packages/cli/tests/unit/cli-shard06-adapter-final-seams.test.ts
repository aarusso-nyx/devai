import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boundaries = vi.hoisted(() => ({
  executeRoutineExecutor: vi.fn(),
  spawnSync: vi.fn(),
  senseBuild: vi.fn(),
  loadDomains: vi.fn(),
  validateInvariants: vi.fn(),
  validateJourneys: vi.fn(),
  loadBlueprint: vi.fn(),
  validateBlueprint: vi.fn(),
  validateAdrs: vi.fn(),
  scanInvOverrides: vi.fn(),
  regenerateInventory: vi.fn(),
  loadReadingsFromDir: vi.fn(),
  detectRelabeledSensors: vi.fn(),
  evaluateGlobGuards: vi.fn(),
  checkMutationReport: vi.fn(),
  checkDependencies: vi.fn(),
  executeTranslationValidation: vi.fn(),
  validators: {
    inventory: vi.fn(),
    scorecard: Object.assign(vi.fn(), { errors: undefined as unknown }),
  },
  securityReadings: [] as Array<{ status: string }>,
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: boundaries.spawnSync,
}));

vi.mock('@devai-nyx/loop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/loop')>()),
  executeRoutineExecutor: boundaries.executeRoutineExecutor,
}));

vi.mock('#runtime-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/runtime-core.js')>()),
  loadDomains: boundaries.loadDomains,
  validateInvariants: boundaries.validateInvariants,
  validateJourneys: boundaries.validateJourneys,
  loadBlueprint: boundaries.loadBlueprint,
  validateBlueprint: boundaries.validateBlueprint,
  validateAdrs: boundaries.validateAdrs,
  scanInvOverrides: boundaries.scanInvOverrides,
  regenerateInventory: boundaries.regenerateInventory,
  loadReadingsFromDir: boundaries.loadReadingsFromDir,
  detectRelabeledSensors: boundaries.detectRelabeledSensors,
  evaluateGlobGuards: boundaries.evaluateGlobGuards,
}));

vi.mock('@devai-nyx/schemas', async (importOriginal) => {
  const original = await importOriginal<typeof import('@devai-nyx/schemas')>();
  return {
    ...original,
    validators: {
      ...original.validators,
      inventory: boundaries.validators.inventory,
      scorecard: boundaries.validators.scorecard,
    },
  };
});

vi.mock('@devai-nyx/sensors', async (importOriginal) => {
  const original = await importOriginal<typeof import('@devai-nyx/sensors')>();
  const nextReading = () => boundaries.securityReadings.shift() ?? { status: 'pass' };
  return {
    ...original,
    senseBuild: boundaries.senseBuild,
    senseSecurityScan: vi.fn(nextReading),
    senseSpecSecurityCoverage: vi.fn(nextReading),
    senseSpecPerformanceTargets: vi.fn(nextReading),
    senseTestSecurityCoverage: vi.fn(nextReading),
    senseTestPerformanceCoverage: vi.fn(nextReading),
    senseInventoryPerformance: vi.fn(nextReading),
    senseHarnessPerformance: vi.fn(nextReading),
    senseHarnessSecurity: vi.fn(() => ({ reading: nextReading() })),
  };
});

vi.mock('../../src/commands/mutation/report-check.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/commands/mutation/report-check.js')>()),
  checkMutationReport: boundaries.checkMutationReport,
}));

vi.mock('../../src/commands/check/dependencies.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/commands/check/dependencies.js')>()),
  checkDependencies: boundaries.checkDependencies,
}));

vi.mock('../../src/commands/verify/translation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/commands/verify/translation.js')>()),
  executeTranslationValidation: boundaries.executeTranslationValidation,
}));

import { executeCheckMember } from '../../src/commands/check/adapters.js';
import type { CheckCost, ResolvedCheckMember } from '../../src/commands/check/contracts.js';
import { checkGlobGuardsCmd } from '../../src/commands/check/glob-guards.js';
import { checkSensorIntegrityCmd } from '../../src/commands/check/sensor-integrity.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const roots: string[] = [];
const originalExitCode = process.exitCode;
const originalStdout = process.stdout.write;

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function put(root: string, relativePath: string, value: unknown): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`, 'utf8');
}

function member(serviceId: string, cost: CheckCost = 'low'): ResolvedCheckMember {
  return {
    id: `member-${serviceId}`,
    source: 'current-selector',
    service_id: serviceId,
    binding: { kind: 'runtime-gate', gate_id: `check-${serviceId}` },
    effect: 'read',
    cost,
    output: `action-envelope-plus-${serviceId}-report`,
  };
}

async function execute(
  serviceId: string,
  options: Parameters<typeof executeCheckMember>[1] = { repoRoot: ROOT },
  cost: CheckCost = 'low',
) {
  return executeCheckMember(member(serviceId, cost), options);
}

interface RegisteredCommand {
  readonly command: readonly [string, string];
  readonly options: readonly (readonly [string, string])[];
  readonly invoke: (options: Record<string, unknown>) => void;
}

function registered(command: { readonly register: (cli: CAC) => void }): RegisteredCommand {
  let callback: ((options: Record<string, unknown>) => void) | undefined;
  let commandCall: readonly [string, string] | undefined;
  const optionCalls: Array<readonly [string, string]> = [];
  const chain = {
    option(flag: string, description: string) {
      optionCalls.push([flag, description]);
      return chain;
    },
    action(value: (options: Record<string, unknown>) => void) {
      callback = value;
      return chain;
    },
  };
  command.register({
    command(name: string, description: string) {
      commandCall = [name, description];
      return chain;
    },
  } as unknown as CAC);
  if (callback === undefined || commandCall === undefined)
    throw new Error('registration incomplete');
  return { command: commandCall, options: optionCalls, invoke: callback };
}

function captureStdout(): () => string {
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.exitCode = undefined;
  return () => output;
}

beforeEach(() => {
  vi.clearAllMocks();
  boundaries.securityReadings.splice(0);
  boundaries.senseBuild.mockReset();
  boundaries.validators.inventory.mockReturnValue(true);
  boundaries.validators.scorecard.mockReturnValue(true);
  boundaries.loadReadingsFromDir.mockReturnValue([]);
  boundaries.detectRelabeledSensors.mockReturnValue([]);
  boundaries.evaluateGlobGuards.mockReturnValue([]);
  boundaries.executeRoutineExecutor.mockImplementation(async (input: Record<string, unknown>) => {
    const executor = input['executor'] as {
      argv: readonly string[];
      cwd: string;
      timeout_ms: number;
    };
    const runArgv = input['runArgv'] as (
      argv: readonly string[],
      options: { cwd: string; timeout: number },
    ) => unknown;
    runArgv(executor.argv, { cwd: executor.cwd, timeout: executor.timeout_ms });
    return { ok: true };
  });
  boundaries.spawnSync.mockReturnValue({ status: 0, stdout: '{}', stderr: '' });
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.stdout.write = originalStdout;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe('S06-A final command identity seams', () => {
  it('retains the exact glob-guard command identity and description', () => {
    expect(checkGlobGuardsCmd).toMatchObject({
      name: 'check glob-guards',
      description:
        'Evaluate .devai/config/glob-guards.json: every registered pattern must still match at least min_matches files. Catches a CI trigger path, generator input dir, or validation-loop target silently degrading to zero matches after a rename or format migration.',
    });
    const command = registered(checkGlobGuardsCmd);
    expect(command.command).toEqual([
      'check-glob-guards',
      'Evaluate the glob-guards registry against the real tree',
    ]);
    captureStdout();
    command.invoke({});
    expect(boundaries.evaluateGlobGuards).toHaveBeenCalledWith(
      '.',
      '.devai/config/glob-guards.json',
    );
  });

  it('retains the exact sensor command identity and its JSON branch', () => {
    const root = temporaryRoot('devai-s06-final-sensor-');
    boundaries.loadReadingsFromDir.mockReturnValue([{}]);
    expect(checkSensorIntegrityCmd).toMatchObject({
      name: 'check sensor-integrity',
      description:
        'Flag SensorReadings that share a command_hash across distinct sensor.kind values (relabeled, not independently measured). Advisory: exits REVIEW on findings, never FAIL.',
    });
    const command = registered(checkSensorIntegrityCmd);
    expect(command.command).toEqual([
      'check-sensor-integrity',
      'Flag relabeled SensorReadings (shared command_hash, distinct kinds)',
    ]);
    const stdout = captureStdout();
    command.invoke({ repoRoot: root });
    expect(stdout()).toBe('{"verdict":"pass","readings_scanned":1,"groups":[]}\n');
    expect(boundaries.loadReadingsFromDir).toHaveBeenCalledWith(
      `${root}/.devai/state/sensor-readings`,
    );

    captureStdout();
    command.invoke({});
    expect(boundaries.loadReadingsFromDir).toHaveBeenLastCalledWith(
      './.devai/state/sensor-readings',
    );
  });
});

describe('S06-A final value and process seams', () => {
  it.each([
    ['unknown', 'unknown'],
    ['na', 'na'],
    ['killed', 'error'],
    ['crash', 'error'],
  ] as const)(
    'preserves the %s status rather than accepting an empty label',
    async (status, expected) => {
      boundaries.senseBuild.mockReturnValueOnce({ status });
      await expect(execute('build')).resolves.toMatchObject({
        status: expected,
        value: { status },
      });
    },
  );

  it('keeps a missing process exit terminal even when stdout claims pass', async () => {
    boundaries.spawnSync.mockReturnValue({
      status: null,
      stdout: '{"status":"pass"}',
      stderr: 'terminated',
    });
    await expect(execute('full-tests')).resolves.toMatchObject({
      status: 'error',
      code: 'CHECK_PROCESS_NO_EXIT',
      exit_code: null,
      stdout: '{"status":"pass"}',
      stderr: 'terminated',
    });
  });

  it('binds empty inputs and a write-only non-publishing authority to argv execution', async () => {
    await execute('full-tests', { repoRoot: ROOT }, 'medium');
    expect(boundaries.executeRoutineExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        executor: expect.objectContaining({
          argv: ['pnpm', 'vitest', 'run'],
          inputs: [],
          timeout_ms: 600_000,
        }),
        authority: expect.objectContaining({ write: true, allow_publish: false }),
      }),
    );
  });

  it('reports the exact missing-capture code and diagnostic', async () => {
    boundaries.executeRoutineExecutor.mockResolvedValueOnce({ ok: true });
    await expect(execute('full-tests')).resolves.toMatchObject({
      status: 'error',
      code: 'CHECK_PROCESS_RESULT_MISSING',
      message: 'routine executor returned no process result',
    });
  });
});

describe('S06-A final direct-service seams', () => {
  it('routes journey-validation through its exact context and journey validator', async () => {
    const domains = { domains: ['one'] };
    const invariants = { invariants: [{ id: 'INV-ONE' }] };
    const report = { status: 'review', journeys: 2 };
    boundaries.loadDomains.mockReturnValue(domains);
    boundaries.validateInvariants.mockReturnValue(invariants);
    boundaries.validateJourneys.mockReturnValue(report);
    await expect(execute('journey-validation')).resolves.toMatchObject({
      status: 'review',
      value: report,
    });
    expect(boundaries.loadDomains).toHaveBeenCalledWith(join(ROOT, '.devai/config/domains.json'));
    expect(boundaries.validateJourneys).toHaveBeenCalledWith({
      journeysDir: join(ROOT, 'product/journeys'),
      invariantIds: new Set(['INV-ONE']),
    });
    expect(boundaries.validateInvariants).toHaveBeenCalledWith({
      invariantsDir: join(ROOT, 'law/invariants'),
      domains,
      repoRoot: ROOT,
    });
  });

  it('routes the inventory service and detects two individually valid unequal generations', async () => {
    const inventory = { schemaVersion: '1.0.0', marker: 'same' };
    boundaries.regenerateInventory.mockResolvedValue(inventory);
    boundaries.validators.inventory.mockReturnValueOnce(false).mockReturnValueOnce(true);
    await expect(execute('inventory-integrity')).resolves.toMatchObject({
      status: 'fail',
      value: { ok: false, schema_valid: false, deterministic: true },
    });
    expect(boundaries.regenerateInventory).toHaveBeenCalledTimes(2);
  });

  it('routes mutation policy through the report verifier after proving applicability', async () => {
    const root = temporaryRoot('devai-s06-final-mutation-');
    put(root, 'law/policy/mutation-strength.json', {
      schemaVersion: '1.0.0',
      id: 'mutation-strength',
      status: 'active',
    });
    put(root, 'law/invariants/INV-MUTATION.json', {
      verification: { strategy: 'mutation' },
    });
    boundaries.checkMutationReport.mockReturnValue({ ok: true, marker: 'verified' });
    await expect(
      execute('mutation', {
        repoRoot: root,
        mutationBaseline: 'must-not-reach-policy-baseline.json',
        mutationCurrent: 'must-not-reach-policy-current.json',
        mutationThresholds: 'must-not-reach-policy-thresholds.json',
      }),
    ).resolves.toMatchObject({
      status: 'pass',
      value: { ok: true, marker: 'verified' },
    });
    expect(boundaries.checkMutationReport).toHaveBeenCalledWith({ repoRoot: root });
  });

  it('returns the exact not-applicable mutation result without invoking evidence validation', async () => {
    const root = temporaryRoot('devai-s06-final-mutation-na-');
    put(root, 'law/policy/mutation-strength.json', {
      schemaVersion: '1.0.0',
      id: 'mutation-strength',
      status: 'active',
    });
    put(root, 'law/invariants/INV-NO-MUTATION.json', { verification: { strategy: 'tests' } });
    await expect(execute('mutation', { repoRoot: root })).resolves.toMatchObject({
      status: 'na',
      value: {
        status: 'na',
        applicable: false,
        reason: 'no invariant verification strategy declares mutation',
        policy: join(root, 'law/policy/mutation-strength.json'),
      },
    });
    expect(boundaries.checkMutationReport).not.toHaveBeenCalled();
  });

  it('routes security-performance and retains the complete eight-reading population', async () => {
    boundaries.securityReadings.push(
      { status: 'pass' },
      { status: 'pass' },
      { status: 'pass' },
      { status: 'pass' },
      { status: 'pass' },
      { status: 'pass' },
      { status: 'pass' },
      { status: 'pass' },
    );
    const result = await execute('security-performance');
    expect(result).toMatchObject({
      status: 'pass',
      value: { status: 'pass', readings: expect.any(Array) },
    });
    expect((result.value as { readings: unknown[] }).readings).toHaveLength(8);
  });

  it('routes release-scorecard and dependencies through their distinct services', async () => {
    const root = temporaryRoot('devai-s06-final-scorecard-');
    const scorecard = { schemaVersion: '1.0.0', overall_state: 'green' };
    put(root, '.devai/state/scorecards/latest.json', scorecard);
    boundaries.checkDependencies.mockReturnValue({ status: 'review', marker: 'dependencies' });
    await expect(execute('release-scorecard', { repoRoot: root })).resolves.toMatchObject({
      status: 'pass',
      value: { status: 'green', scorecard },
    });
    await expect(execute('dependencies', { repoRoot: root })).resolves.toMatchObject({
      status: 'review',
      value: { status: 'review', marker: 'dependencies' },
    });
    expect(boundaries.checkDependencies).toHaveBeenCalledWith({ repoRoot: root });
  });

  it('accepts a supplied translation witness and invokes the translation boundary', async () => {
    boundaries.executeTranslationValidation.mockResolvedValue({ ok: true, marker: 'translation' });
    await expect(
      execute('translation', { repoRoot: ROOT, witness: 'scratch/witness.json' }),
    ).resolves.toMatchObject({ status: 'pass', value: { ok: true, marker: 'translation' } });
    expect(boundaries.executeTranslationValidation).toHaveBeenCalledWith({
      witness: 'scratch/witness.json',
      repoRoot: ROOT,
    });
    expect(Object.keys(boundaries.executeTranslationValidation.mock.calls[0]?.[0] ?? {})).toEqual([
      'witness',
      'repoRoot',
    ]);
  });
});

describe('S06-A final report population seams', () => {
  it('keeps only JSON invariants in overrides and forwards their exact catalog', async () => {
    const root = temporaryRoot('devai-s06-final-overrides-');
    put(root, 'law/invariants/INV-ONE.json', { id: 'INV-ONE', severity: 'must' });
    put(root, 'law/invariants/.json-hidden', { id: 'HIDDEN', severity: 'must' });
    put(root, 'law/invariants/notes.txt', { id: 'TEXT', severity: 'must' });
    boundaries.scanInvOverrides.mockReturnValue({ findings: [], scanned: 3 });
    await expect(execute('overrides', { repoRoot: root })).resolves.toMatchObject({
      status: 'pass',
      value: { ok: true, findings: [], scanned: 3 },
    });
    const call = boundaries.scanInvOverrides.mock.calls[0]?.[0] as {
      invariants: Map<string, { severity: string }>;
    };
    expect([...call.invariants]).toEqual([['INV-ONE', { severity: 'must' }]]);
  });

  it('retains the ADR directory, invalid-blueprint schema errors, and empty violations', async () => {
    const root = temporaryRoot('devai-s06-final-reports-');
    boundaries.validateAdrs.mockReturnValue({ status: 'pass', marker: 'adrs' });
    boundaries.loadBlueprint.mockReturnValue({ ok: false, errors: ['invalid blueprint'] });
    await expect(execute('adrs', { repoRoot: root })).resolves.toMatchObject({
      status: 'pass',
      value: { status: 'pass', marker: 'adrs' },
    });
    expect(boundaries.validateAdrs).toHaveBeenCalledWith({ adrsDir: join(root, 'law/adr') });
    await expect(
      execute('blueprint', { repoRoot: root, file: 'blueprint.json' }),
    ).resolves.toMatchObject({
      status: 'fail',
      value: { ok: false, schema_errors: ['invalid blueprint'], violations: [] },
    });

    const blueprint = { id: 'BP-ONE', module: { version: '1.0.0' } };
    boundaries.loadBlueprint.mockReturnValue({ ok: true, blueprint });
    boundaries.validateBlueprint.mockReturnValue({ ok: true, violations: [] });
    await expect(
      execute('blueprint', { repoRoot: root, file: 'blueprint.json' }),
    ).resolves.toMatchObject({
      status: 'pass',
      value: {
        ok: true,
        blueprint_id: 'BP-ONE',
        blueprint_version: '1.0.0',
        schema_errors: [],
        violations: [],
      },
    });
  });

  it('retains an empty schema error population for a valid instance', async () => {
    const root = temporaryRoot('devai-s06-final-schema-');
    put(root, 'schema.json', { type: 'object', required: ['value'] });
    put(root, 'instance.json', { value: 1 });
    await expect(
      execute('schema', { repoRoot: root, schema: 'schema.json', instance: 'instance.json' }),
    ).resolves.toMatchObject({ status: 'pass', value: { ok: true, errors: [] } });
  });

  it('forwards every explicit mutation-verification path', async () => {
    boundaries.checkMutationReport.mockReturnValue({ ok: true, marker: 'current' });
    const options = {
      repoRoot: ROOT,
      mutationBaseline: 'baseline.json',
      mutationCurrent: 'current.json',
      mutationThresholds: 'thresholds.json',
    };
    await expect(execute('mutation-verification', options)).resolves.toMatchObject({
      status: 'pass',
      value: { ok: true, marker: 'current' },
    });
    expect(boundaries.checkMutationReport).toHaveBeenCalledWith({
      repoRoot: ROOT,
      baseline: 'baseline.json',
      current: 'current.json',
      thresholds: 'thresholds.json',
    });
  });

  it('measures elapsed adapter time with subtraction and a nonnegative clamp', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(125);
    boundaries.senseBuild.mockReturnValue({ ok: true });
    await expect(execute('build')).resolves.toMatchObject({ duration_ms: 25 });
    expect(clock).toHaveBeenCalledTimes(2);
  });
});
