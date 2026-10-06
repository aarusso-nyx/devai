import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

/**
 * Declared plant surfaces (ADR-SCR-0003).
 *
 * An adopter states in `.devai/config/sensor-inputs.json` which of the four plant
 * surfaces it has. `sense run` resolves the `surfaces` object and the adapters hand it
 * to the inventory and plant sensors as an option. Omitted, every surface is presumed
 * present and each sensor measures as it did before the declaration existed.
 *
 * The rule, applied once here for every bound sensor:
 *   - every bound surface declared absent and no evidence found: `skipped`, first
 *     finding SURFACE_DECLARED_ABSENT (info) naming the surfaces and the declaration;
 *   - evidence found for a surface declared absent: `review` with a finding
 *     SURFACE_DECLARATION_CONTRADICTED naming what was found, never a skip;
 *   - otherwise the measured reading stands.
 */

export interface DeclaredSurfaces {
  readonly http: boolean;
  readonly database: boolean;
  readonly rbac: boolean;
  readonly actions: boolean;
}

export type PlantSurface = keyof DeclaredSurfaces;

/** The declaration file, relative to the repository root. */
export const SURFACES_DECLARATION_PATH = '.devai/config/sensor-inputs.json';

/** The action registry, relative to the repository root. */
export const ACTION_REGISTRY_PATH = 'law/policy/action-registry.json';

/** A surface is present unless the declaration states it false. */
export function surfacePresent(
  surfaces: DeclaredSurfaces | undefined,
  surface: PlantSurface,
): boolean {
  return surfaces === undefined || surfaces[surface];
}

/** True when a declaration is given and every bound surface is declared absent. */
export function allBoundSurfacesAbsent(
  surfaces: DeclaredSurfaces | undefined,
  bound: readonly PlantSurface[],
): boolean {
  return surfaces !== undefined && bound.every((surface) => !surfaces[surface]);
}

/** Evidence one sensor found for one surface. */
export interface SurfaceEvidence {
  readonly surface: PlantSurface;
  /** What was found: endpoint or route paths, tables, columns, action ids. */
  readonly items: readonly string[];
}

const EVIDENCE_LIMIT = 10;

function listItems(items: readonly string[]): string {
  const shown = items.slice(0, EVIDENCE_LIMIT).join(', ');
  const rest = items.length - EVIDENCE_LIMIT;
  return rest > 0 ? `${shown}, and ${String(rest)} more` : shown;
}

/**
 * Apply the surfaces declaration to a measured reading. `evidence` lists what the
 * sensor found per bound surface; only surfaces declared absent are consulted.
 */
export function applySurfaceDeclaration(
  reading: SensorReading,
  surfaces: DeclaredSurfaces | undefined,
  bound: readonly PlantSurface[],
  evidence: readonly SurfaceEvidence[],
): SensorReading {
  if (surfaces === undefined) return reading;
  const contradictions: SensorFinding[] = [];
  for (const found of evidence) {
    if (!bound.includes(found.surface) || surfaces[found.surface]) continue;
    if (found.items.length === 0) continue;
    contradictions.push({
      severity: 'warning',
      code: 'SURFACE_DECLARATION_CONTRADICTED',
      message: `Surface ${found.surface} is declared absent in ${SURFACES_DECLARATION_PATH}, but the sensor found ${String(found.items.length)}: ${listItems(found.items)}. Correct the declaration or remove the surface.`,
      file: SURFACES_DECLARATION_PATH,
    });
  }
  if (contradictions.length > 0) {
    const status: SensorStatus =
      reading.status === 'pass' || reading.status === 'skipped' || reading.status === 'unknown'
        ? 'review'
        : reading.status;
    return rebuild(reading, status, [...(reading.findings ?? []), ...contradictions]);
  }
  if (!allBoundSurfacesAbsent(surfaces, bound)) return reading;
  return rebuild(reading, 'skipped', [
    {
      severity: 'info',
      code: 'SURFACE_DECLARED_ABSENT',
      message: `Not measured: ${SURFACES_DECLARATION_PATH} declares the surface${bound.length === 1 ? '' : 's'} ${bound.join(', ')} absent, and no evidence of ${bound.length === 1 ? 'it' : 'them'} was found.`,
      file: SURFACES_DECLARATION_PATH,
    },
  ]);
}

function rebuild(
  reading: SensorReading,
  status: SensorStatus,
  findings: readonly SensorFinding[],
): SensorReading {
  return buildSensorReading({
    ...(reading.lifecycle !== undefined && { lifecycle: reading.lifecycle }),
    sensorName: reading.sensor.name,
    sensorKind: reading.sensor.kind,
    ...(reading.sensor.version !== undefined && { sensorVersion: reading.sensor.version }),
    command: [reading.command],
    status,
    deterministic: reading.deterministic,
    ...(reading.tier !== undefined && { tier: reading.tier }),
    timestamp: reading.timestamp,
    ...(reading.exit_code !== undefined && { exit_code: reading.exit_code }),
    ...(reading.duration_ms !== undefined && { duration_ms: reading.duration_ms }),
    ...(reading.out_head !== undefined && { out_head: reading.out_head }),
    ...(reading.err_head !== undefined && { err_head: reading.err_head }),
    ...(reading.killed !== undefined && { killed: reading.killed }),
    ...(status !== 'skipped' &&
      reading.evidence_path !== undefined && { evidence_path: reading.evidence_path }),
    findings,
    ...(reading.metrics !== undefined && { metrics: reading.metrics }),
  });
}

// ---------------------------------------------------------------------------
// The actions surface: registered actions against their specification links.
// ---------------------------------------------------------------------------

export interface ActionLinkage {
  /** Registered action ids, in registry order. */
  readonly actionIds: readonly string[];
  readonly linkedIds: ReadonlySet<string>;
  readonly unlinkedIds: readonly string[];
  readonly metrics: {
    readonly action_count: number;
    readonly linked_action_count: number;
    readonly action_coverage_pct: number;
  };
}

interface RegistryShape {
  readonly entries?: ReadonlyArray<{ readonly action_id?: unknown }>;
}

interface UseCaseStepShape {
  readonly refs?: { readonly actionRefs?: ReadonlyArray<{ readonly id?: unknown }> };
}

interface UseCaseFileShape {
  readonly cases?: ReadonlyArray<{
    readonly mainFlow?: readonly UseCaseStepShape[];
    readonly alternateFlows?: ReadonlyArray<{ readonly steps?: readonly UseCaseStepShape[] }>;
  }>;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** Registered action ids, or null when the registry is absent or unreadable. */
export function readRegisteredActionIds(
  repoRoot: string,
  admit: (absolutePath: string) => boolean = () => true,
): readonly string[] | null {
  const path = join(repoRoot, ACTION_REGISTRY_PATH);
  const registry = (admit(path) ? readJson(path) : undefined) as RegistryShape | undefined;
  if (typeof registry !== 'object' || registry === null || !Array.isArray(registry.entries)) {
    return null;
  }
  const entries: NonNullable<RegistryShape['entries']> = registry.entries;
  return entries
    .map((entry) => entry.action_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** Action ids referenced by `refs.actionRefs[].id` in any use-case step under `useCasesDir`. */
function referencedActionIds(
  useCasesDir: string,
  admit: (absolutePath: string) => boolean,
): Set<string> {
  const referenced = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(useCasesDir)
      .filter((name) => name.endsWith('.json') && admit(join(useCasesDir, name)))
      .sort();
  } catch {
    return referenced;
  }
  for (const name of names) {
    const file = readJson(join(useCasesDir, name)) as UseCaseFileShape | undefined;
    if (typeof file !== 'object' || file === null) continue;
    const cases: NonNullable<UseCaseFileShape['cases']> = Array.isArray(file.cases)
      ? file.cases
      : [];
    for (const useCase of cases) {
      const steps = [
        ...(useCase.mainFlow ?? []),
        ...(useCase.alternateFlows ?? []).flatMap((flow) => flow.steps ?? []),
      ];
      for (const step of steps) {
        for (const ref of step.refs?.actionRefs ?? []) {
          if (typeof ref.id === 'string') referenced.add(ref.id);
        }
      }
    }
  }
  return referenced;
}

/**
 * Measure the action registry against the use cases that link its actions, or null
 * when the repository holds no readable registry. A use-case reference to an id the
 * registry does not hold is ignored.
 */
export function measureActionLinkage(
  repoRoot: string,
  useCasesDir: string = join(repoRoot, 'product/use-cases'),
  admit: (absolutePath: string) => boolean = () => true,
): ActionLinkage | null {
  const actionIds = readRegisteredActionIds(repoRoot, admit);
  if (actionIds === null) return null;
  const referenced = referencedActionIds(useCasesDir, admit);
  const linkedIds = new Set(actionIds.filter((id) => referenced.has(id)));
  const unlinkedIds = actionIds.filter((id) => !linkedIds.has(id));
  const pct = actionIds.length === 0 ? 100 : (linkedIds.size / actionIds.length) * 100;
  return {
    actionIds,
    linkedIds,
    unlinkedIds,
    metrics: {
      action_count: actionIds.length,
      linked_action_count: linkedIds.size,
      action_coverage_pct: Math.round(pct * 100) / 100,
    },
  };
}

/** One review finding per registered action no use case links. */
export function unlinkedActionFindings(
  linkage: ActionLinkage,
  code: string,
): readonly SensorFinding[] {
  return linkage.unlinkedIds.map((id) => ({
    severity: 'warning' as const,
    code,
    message: `Registered action ${id} has no specification link: no use-case step under product/use-cases references it in refs.actionRefs.`,
    file: ACTION_REGISTRY_PATH,
  }));
}

/** Evidence of the actions surface: the registry path and its action ids. */
export function actionEvidence(
  repoRoot: string,
  admit: (absolutePath: string) => boolean = () => true,
): SurfaceEvidence {
  const ids = readRegisteredActionIds(repoRoot, admit);
  return {
    surface: 'actions',
    items: ids === null || ids.length === 0 ? [] : [ACTION_REGISTRY_PATH, ...ids],
  };
}
