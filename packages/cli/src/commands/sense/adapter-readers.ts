import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { execFileSync } from '@devai-nyx/authority';
import { ACTION_EFFECT_CONTRACTS } from '@devai-nyx/effects-check';
import {
  buildSensorReading,
  executeRuntimeProbe,
  loadCharter,
  senseActionEffectInference,
  senseInventoryAdherence,
  senseInventoryDeterminism,
  senseSpecIdiomaticity,
  type PlantCoverageOptions,
  type RuntimeProbeCharter,
  type SensorFinding,
  type SensorKind,
  type SensorReading,
} from '@devai-nyx/sensors';
import type { AlignmentObservation, ScopedProducer } from '@devai-nyx/sensors';
import {
  computeReverseAdherence,
  loadBlueprint,
  loadDomains,
  regenerateInventory,
  validateBlueprint,
  validateInvariants,
  type GovernanceIntegrityReport,
} from '#runtime-core';
import { validators } from '@devai-nyx/schemas';
import { composeExactHeadScorecard, scorecardHead } from '../audit/scorecard.js';
import { executeInventorySlice } from './inventory.js';

const FULL_SHA = /^[0-9a-f]{40}$/u;

/**
 * ADR-SCR-0013: `audit scorecard` persists nothing, so no recorded reading can carry
 * its candidate evidence. The F5:T4 adapter observes the same read-only exact-HEAD
 * composition in process at the candidate head instead; the observation binds the
 * head it ran at and reads `fail` when the composition throws. Without a readable
 * full head there is nothing to bind, so nothing is observed.
 */
export function observeExactHeadScorecard(repoRoot: string): readonly AlignmentObservation[] {
  const root = resolve(repoRoot);
  let head: string;
  try {
    head = scorecardHead(root);
  } catch {
    return [];
  }
  if (!FULL_SHA.test(head)) return [];
  let status: AlignmentObservation['status'] = 'pass';
  try {
    composeExactHeadScorecard(root, head);
  } catch {
    status = 'fail';
  }
  return [
    {
      command: `devai audit scorecard --repo-root . --at ${head}`,
      status,
      candidate_sha: head,
      completed_at: new Date().toISOString(),
    },
  ];
}

/**
 * The committed subjects of the INV-DEVAI-010 and INV-HARNESS-010 gate producers in the
 * pull request preflight step. The CI lines run `check --only blueprint` and
 * `sense inventory --slice pack` on exactly these paths, and the F5:T4 adapter observes the
 * same read-only compositions on the same paths, so both sides measure one subject.
 */
export const GATE_BLUEPRINT_FIXTURE = 'packages/skills/tests/operations/fixtures/blueprint.json';
export const GATE_PACK_FIXTURE = 'packages/skills/tests/fixtures/pack-resolution';

function observedHead(root: string): string | undefined {
  try {
    const head = scorecardHead(root);
    return FULL_SHA.test(head) ? head : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The two scoped producers (#235): the exact CI invocations, output format aside, whose
 * passing in-process observation alone aligns their invariant.
 */
export const GATE_SCOPED_PRODUCERS: readonly ScopedProducer[] = Object.freeze([
  {
    invariant_id: 'INV-DEVAI-010',
    action: 'check',
    arguments: ['check', '--only', 'blueprint', '--file', GATE_BLUEPRINT_FIXTURE],
  },
  {
    invariant_id: 'INV-HARNESS-010',
    action: 'sense inventory',
    arguments: [
      'sense',
      'inventory',
      '--slice',
      'pack',
      '--packs-root',
      GATE_PACK_FIXTURE,
      '--adopter-root',
      GATE_PACK_FIXTURE,
    ],
  },
]);

/**
 * The observation reads the fixture from the working tree, so it may only be labelled with
 * `head` when the tree holds exactly the committed bytes there: HEAD is `head`, and the
 * path has no modified, staged, untracked, or ignored entry. Otherwise the reading would
 * describe bytes the candidate does not contain.
 */
export function fixtureMatchesHead(repoRoot: string, head: string, path: string): boolean {
  if (headCommit(repoRoot) !== head) return false;
  try {
    const status = execFileSync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '--', path],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return status.trim() === '';
  } catch {
    return false;
  }
}

function producerObservation(
  producer: ScopedProducer,
  head: string,
  status: AlignmentObservation['status'],
): AlignmentObservation {
  return {
    command: `devai ${producer.arguments.join(' ')}`,
    status,
    candidate_sha: head,
    completed_at: new Date().toISOString(),
    invariant_ids: [producer.invariant_id],
  };
}

/**
 * INV-DEVAI-010: `check --only blueprint` persists nothing. The observation runs the
 * blueprint load and validation the check member runs, on the committed gate fixture, and
 * reads `fail` when the fixture differs from the head, is unreadable or schema-invalid, or
 * violates a rule.
 */
export function observeBlueprintCheck(
  repoRoot: string,
  head: string,
): readonly AlignmentObservation[] {
  if (!FULL_SHA.test(head)) return [];
  const [producer] = GATE_SCOPED_PRODUCERS;
  if (producer === undefined) return [];
  let status: AlignmentObservation['status'] = 'fail';
  try {
    if (fixtureMatchesHead(repoRoot, head, GATE_BLUEPRINT_FIXTURE)) {
      const loaded = loadBlueprint(resolve(repoRoot, GATE_BLUEPRINT_FIXTURE));
      if (loaded.ok && loaded.blueprint !== undefined && validateBlueprint(loaded.blueprint).ok) {
        status = 'pass';
      }
    }
  } catch {
    status = 'fail';
  }
  return [producerObservation(producer, head, status)];
}

/**
 * INV-HARNESS-010: `sense inventory` persists nothing. The observation runs the `pack`
 * slice against the committed packs root and adopter fixture and passes only when the
 * fixture matches the head and one pack resolves without ambiguity, the outcome the CI
 * line needs to exit zero.
 */
export async function observePackResolution(
  repoRoot: string,
  head: string,
): Promise<readonly AlignmentObservation[]> {
  if (!FULL_SHA.test(head)) return [];
  const producer = GATE_SCOPED_PRODUCERS[1];
  if (producer === undefined) return [];
  const fixture = resolve(repoRoot, GATE_PACK_FIXTURE);
  let status: AlignmentObservation['status'] = 'fail';
  try {
    if (fixtureMatchesHead(repoRoot, head, GATE_PACK_FIXTURE)) {
      const output = await executeInventorySlice('pack', {
        repoRoot,
        packsRoot: fixture,
        adopterRoot: fixture,
      });
      if (output.status === 'pass') status = 'pass';
    }
  } catch {
    status = 'fail';
  }
  return [producerObservation(producer, head, status)];
}

/**
 * Every in-process observation the F5:T4 adapter hands the alignment sensor: the exact-head
 * scorecard (ADR-SCR-0013) and the two fixture-bound producers above, all at one head.
 */
export async function observeGateProducers(
  repoRoot: string,
): Promise<readonly AlignmentObservation[]> {
  const root = resolve(repoRoot);
  const head = observedHead(root);
  if (head === undefined) return [];
  return [
    ...observeExactHeadScorecard(root),
    ...observeBlueprintCheck(root, head),
    ...(await observePackResolution(root, head)),
  ];
}

export interface SenseAdapterRequest {
  readonly repoRoot: string;
  /** Sensor-specific inputs. The adapter validates required values before use. */
  readonly inputs?: Readonly<Record<string, unknown>>;
}

export type SenseSensorAdapter = (
  request: SenseAdapterRequest,
) => SensorReading | Promise<SensorReading>;

export function stringInput(
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

export function stringArrayInput(request: SenseAdapterRequest, name: string): string[] | undefined {
  const value = request.inputs?.[name];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw new Error(`SENSE_INPUT_INVALID:${name}`);
  }
  return [...(value as string[])];
}

/** Spread helper: `{ [name]: value }` when the input is present, `{}` otherwise. */
export function optional<K extends string, V>(name: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [name]: value }) as { [P in K]?: V };
}

export function integerInput(request: SenseAdapterRequest, name: string): number | undefined {
  const value = request.inputs?.[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`SENSE_INPUT_INVALID:${name}`);
  }
  return value;
}

function booleanInput(request: SenseAdapterRequest, name: string): boolean | undefined {
  const value = request.inputs?.[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`SENSE_INPUT_INVALID:${name}`);
  return value;
}

type DeclaredSurfaces = NonNullable<PlantCoverageOptions['surfaces']>;

const SURFACE_NAMES = ['http', 'database', 'rbac', 'actions'] as const;

/** The declared plant surfaces (ADR-SCR-0003); absent means every surface is presumed. */
export function surfacesInput(request: SenseAdapterRequest): DeclaredSurfaces | undefined {
  const value = request.inputs?.['surfaces'];
  if (value === undefined) return undefined;
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== SURFACE_NAMES.length ||
    SURFACE_NAMES.some((name) => typeof (value as Record<string, unknown>)[name] !== 'boolean')
  ) {
    throw new Error('SENSE_INPUT_INVALID:surfaces');
  }
  const surfaces = value as Record<(typeof SURFACE_NAMES)[number], boolean>;
  return {
    http: surfaces.http,
    database: surfaces.database,
    rbac: surfaces.rbac,
    actions: surfaces.actions,
  };
}

export function absolute(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

export function governanceReading(
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

/** The commit at HEAD, or undefined when none resolves. */
function headCommit(repoRoot: string): string | undefined {
  try {
    const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{40}$/u.test(head) ? head : undefined;
  } catch {
    return undefined;
  }
}

export async function inventoryAdherence(request: SenseAdapterRequest): Promise<SensorReading> {
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
  // ADR-SCR-0012 IA-006: a body that is malformed or describes another commit is a
  // diagnostic, never a measurement.
  let body: unknown;
  try {
    body = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  } catch (error) {
    return unknownReading(
      'inventory_adherence',
      'INVENTORY_ADHERENCE_INPUT_INVALID',
      `${inventoryPath} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!validators.inventory(body)) {
    return unknownReading(
      'inventory_adherence',
      'INVENTORY_ADHERENCE_INPUT_INVALID',
      `${inventoryPath} fails inventory.schema.json: ${JSON.stringify(validators.inventory.errors)}`,
    );
  }
  // The schema requires the string, so the validated body carries it.
  const integrationHead = (body as { readonly integration_head: string }).integration_head;
  const head = headCommit(request.repoRoot);
  if (integrationHead !== head) {
    return unknownReading(
      'inventory_adherence',
      'INVENTORY_ADHERENCE_INPUT_STALE',
      `${inventoryPath} describes ${integrationHead}, not HEAD ${head ?? '(unresolved)'}. Run sense run inventory_regeneration at this commit.`,
    );
  }
  const inventory = body as Parameters<typeof computeReverseAdherence>[0]['inventory'];
  const trace = JSON.parse(readFileSync(tracePath, 'utf8')) as Parameters<
    typeof computeReverseAdherence
  >[0]['trace'];
  const surfaces = surfacesInput(request);
  // ADR-SCR-0008: skipped only when every plant surface is declared absent.
  return senseInventoryAdherence({
    report: computeReverseAdherence({ inventory, trace }),
    ...(surfaces === undefined ? {} : { surfaces }),
  });
}

export async function inventoryDeterminism(request: SenseAdapterRequest): Promise<SensorReading> {
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

export function specIdiomaticity(request: SenseAdapterRequest): SensorReading {
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

export async function actionEffectInference(request: SenseAdapterRequest): Promise<SensorReading> {
  const registryPath = absolute(
    request.repoRoot,
    stringInput(request, 'subprocessRegistry') ?? 'law/policy/subprocess-effects.json',
  );
  const tsconfigPath = absolute(
    request.repoRoot,
    stringInput(request, 'tsconfigPath') ?? 'tsconfig.effects.json',
  );
  // #254: an adopter without the effects policy or program reads UNKNOWN, never ENOENT.
  const missing = [registryPath, tsconfigPath].find((path) => !existsSync(path));
  if (missing !== undefined) {
    return unknownReading(
      'action_effect_inference',
      'ACTION_EFFECT_INFERENCE_INPUT_MISSING',
      `Required input is absent: ${missing}`,
    );
  }
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
    tsconfigPath,
    catalog: ACTION_EFFECT_CONTRACTS.map((entry) => entry.action_id),
    contracts: ACTION_EFFECT_CONTRACTS,
    subprocessRegistry,
  });
  return result.reading;
}

export async function runtimeProbe(
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
