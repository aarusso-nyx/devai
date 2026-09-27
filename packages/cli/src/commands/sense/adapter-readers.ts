import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
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
import {
  computeReverseAdherence,
  loadDomains,
  regenerateInventory,
  validateInvariants,
  type GovernanceIntegrityReport,
} from '#runtime-core';
import { validators } from '@devai-nyx/schemas';

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
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8')) as Parameters<
    typeof computeReverseAdherence
  >[0]['inventory'];
  const trace = JSON.parse(readFileSync(tracePath, 'utf8')) as Parameters<
    typeof computeReverseAdherence
  >[0]['trace'];
  return senseInventoryAdherence({ report: computeReverseAdherence({ inventory, trace }) });
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
