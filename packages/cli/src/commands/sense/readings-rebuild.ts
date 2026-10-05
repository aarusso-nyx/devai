import { createHash } from 'node:crypto';
import {
  execFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { dirname, join } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import {
  buildSensorReading,
  senseInventoryCoverage,
  senseInventoryDepGraph,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from '@devai-nyx/sensors';
import { regenerateInventory } from '#runtime-core';
import { persistSensorReading } from './shared.js';

/**
 * Rebuild inventory readings from previously recorded sensor bodies. Walks
 * `<repoRoot>/.devai/state/sensors/<verb>/` body files and
 * synthesizes a minimal `SensorReading` for each, writing it to
 * `<repoRoot>/.devai/state/sensor-readings/<sensor-kind>/<id>.json`.
 *
 * This provides the `sense record --rebuild` path without re-running
 * the underlying static inventory walks.
 *
 * Limitations: the synthesized readings carry only `status: 'pass'`
 * + a body_path-like `evidence_path` pointer + the canonical
 * kind/name fields. They don't reconstruct the original sensor's
 * findings or metrics — that information is lost when the sensor
 * exits. The synthesized reading is sufficient for the scorecard
 * to attribute coverage to the sensor; it isn't a substitute for
 * a fresh sensor run when the sensor's findings matter.
 *
 * `sense run inventory_regeneration` uses {@link regenerateInventoryReadings}
 * instead: it regenerates the inventory bodies from source first (#237).
 */

const SENSOR_KINDS: ReadonlyArray<{
  readonly subdir: string;
  readonly kind: string;
  readonly name: string;
}> = [
  { subdir: 'inventory_api', kind: 'inventory_api', name: 'inventory:api' },
  { subdir: 'inventory_routes', kind: 'inventory_routes', name: 'inventory:routes' },
  { subdir: 'inventory_data_model', kind: 'inventory_data_model', name: 'inventory:data-model' },
  {
    subdir: 'inventory_data_handling',
    kind: 'inventory_data_handling',
    name: 'inventory:data-handling',
  },
  { subdir: 'inventory_rbac', kind: 'inventory_rbac', name: 'inventory:rbac' },
  { subdir: 'inventory_dep_graph', kind: 'inventory_dep_graph', name: 'inventory:dep-graph' },
  { subdir: 'inventory_coverage', kind: 'inventory_coverage', name: 'inventory:coverage' },
];

export interface RebuildEntry {
  readonly kind: string;
  readonly body_path: string;
  readonly reading_path: string;
  readonly action: 'created' | 'skipped-exists';
}

export interface RebuildReport {
  readonly ok: boolean;
  readonly repo_root: string;
  readonly entries: readonly RebuildEntry[];
  readonly skipped: number;
  readonly created: number;
  readonly errors: readonly string[];
}

export interface RebuildSensorReadingsResult {
  readonly report: RebuildReport;
  readonly reading: SensorReading;
}

function synthesizeReading(
  spec: (typeof SENSOR_KINDS)[number],
  bodyAbsPath: string,
  bodyRelPath: string,
): { id: string; reading: unknown } {
  const idSeed = createHash('sha256')
    .update(`${spec.kind}::${bodyRelPath}::rebuild`)
    .digest('hex')
    .slice(0, 16);
  const id = `SR-${idSeed}`;
  const command = `devai sense record --rebuild --repo-root . (synthesized from ${bodyRelPath})`;
  const command_hash = createHash('sha256').update(command).digest('hex');
  const timestamp = new Date().toISOString();
  const reading = {
    schemaVersion: '1.0.0',
    id,
    sensor: { name: spec.name, kind: spec.kind, version: '1.0.0' },
    timestamp,
    status: 'pass',
    deterministic: true,
    command,
    command_hash,
    tier: 'L0',
    evidence_path: bodyAbsPath,
    findings: [
      {
        severity: 'info',
        code: 'REBUILT_FROM_BODY',
        message:
          'SensorReading synthesized from an existing body file by `devai sense record --rebuild`. Findings and metrics from the original sensor run are not preserved.',
      },
    ],
  };
  return { id, reading };
}

interface BodyWalk {
  readonly entries: readonly RebuildEntry[];
  readonly errors: readonly string[];
  readonly created: number;
  readonly skipped: number;
}

/** Synthesize readings from the body files of every kind not named in `skipKinds`. */
function walkInventoryBodies(repoRoot: string, skipKinds: ReadonlySet<string>): BodyWalk {
  const entries: RebuildEntry[] = [];
  const errors: string[] = [];
  let created = 0;
  let skipped = 0;
  for (const spec of SENSOR_KINDS) {
    if (skipKinds.has(spec.kind)) continue;
    const bodyDir = join(repoRoot, '.devai/state/sensors', spec.subdir);
    if (!existsSync(bodyDir)) continue;
    let bodyFiles: readonly string[];
    try {
      bodyFiles = readdirSync(bodyDir)
        .filter((name) => name.endsWith('.json'))
        .sort();
    } catch (error) {
      errors.push(
        `read ${bodyDir} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const outDir = join(repoRoot, '.devai/state/sensor-readings', spec.kind);
    mkdirSync(outDir, { recursive: true });
    for (const file of bodyFiles) {
      const bodyAbsPath = join(bodyDir, file);
      const bodyRelPath = join('.devai/state/sensors', spec.subdir, file);
      try {
        JSON.parse(readFileSync(bodyAbsPath, 'utf8'));
      } catch (error) {
        errors.push(
          `parse ${bodyRelPath} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      const { id, reading } = synthesizeReading(spec, bodyAbsPath, bodyRelPath);
      const target = join(outDir, `${id}.json`);
      if (existsSync(target)) {
        entries.push({
          kind: spec.kind,
          body_path: bodyRelPath,
          reading_path: target,
          action: 'skipped-exists',
        });
        skipped += 1;
        continue;
      }
      try {
        writeFileSync(target, `${JSON.stringify(reading, null, 2)}\n`);
        entries.push({
          kind: spec.kind,
          body_path: bodyRelPath,
          reading_path: target,
          action: 'created',
        });
        created += 1;
      } catch (error) {
        errors.push(
          `write ${target} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return { entries, errors, created, skipped };
}

function errorFindings(errors: readonly string[]): SensorFinding[] {
  return errors.slice(0, 5).map((error) => ({
    severity: 'error' as const,
    code: 'READINGS_REBUILD_ERROR',
    message: error.slice(0, 200),
  }));
}

const NO_KINDS_TOUCHED: SensorFinding = {
  severity: 'info',
  code: 'INVENTORY_REGENERATION_NO_KINDS_TOUCHED',
  message: 'No inventory bodies were found; nothing was rebuilt.',
};

/** Direct in-process adapter used by `sense record --rebuild`. */
export function rebuildSensorReadings(repoRoot: string): RebuildSensorReadingsResult {
  const { entries, errors, created, skipped } = walkInventoryBodies(repoRoot, new Set());
  const report: RebuildReport = {
    ok: errors.length === 0,
    repo_root: repoRoot,
    entries,
    created,
    skipped,
    errors,
  };
  const kindsTouched = new Set(entries.map((entry) => entry.kind)).size;
  let status: 'pass' | 'review' | 'fail';
  const findings: SensorFinding[] = [];
  if (errors.length > 0) {
    status = 'fail';
    findings.push(...errorFindings(errors));
  } else if (kindsTouched === 0) {
    status = 'review';
    findings.push(NO_KINDS_TOUCHED);
  } else {
    status = 'pass';
  }
  const reading = buildSensorReading({
    sensorName: 'inventory-regeneration',
    sensorKind: 'inventory_regeneration',
    command: ['devai', 'sense', 'record', '--rebuild'],
    status,
    deterministic: true,
    tier: 'L0',
    findings,
    metrics: {
      kinds_touched: kindsTouched,
      kinds_rebuilt: created,
      kinds_up_to_date: skipped,
      error_count: errors.length,
    },
    forceUniqueId: true,
  });
  persistSensorReading(reading, repoRoot);
  return { report, reading };
}

// ---------------------------------------------------------------------------
// #237 (ADR-SCR-0012): regeneration from source for `sense run inventory_regeneration`.
// ---------------------------------------------------------------------------

/** The combined F4 manifest `inventory_adherence` reads (ADR-SCR-0012). */
export const INVENTORY_BODY_PATH = '.devai/state/inventory/inventory.json';

/** The kinds regeneration produces from source, each through its own typed producer. */
const REGENERATED_BODY_PATHS = {
  inventory_dep_graph: '.devai/state/sensors/inventory_dep_graph/dep-graph.json',
  inventory_coverage: '.devai/state/sensors/inventory_coverage/coverage-matrix.json',
} as const;

export type RegeneratedKind = keyof typeof REGENERATED_BODY_PATHS;

/** Declared plant surfaces (ADR-SCR-0003), as `.devai/config/sensor-inputs.json` states them. */
export interface RegenerationSurfaces {
  readonly http: boolean;
  readonly database: boolean;
  readonly rbac: boolean;
  readonly actions: boolean;
}

export interface RegenerationOptions {
  /** Omitted: every surface is presumed present, so the coverage kind is required. */
  readonly surfaces?: RegenerationSurfaces;
}

export interface RegeneratedBody {
  readonly kind: 'inventory' | RegeneratedKind;
  readonly body_path: string;
  /** `up-to-date` when the existing body already holds exactly the regenerated bytes. */
  readonly action: 'regenerated' | 'up-to-date';
  /** The producer's own status; the combined manifest reads pass once its schema validates. */
  readonly producer_status: SensorStatus;
  readonly sha256: string;
}

export interface RegenerationReport extends RebuildReport {
  /** The commit every regenerated body is bound to; null when none could be bound. */
  readonly integration_head: string | null;
  readonly regenerated: readonly RegeneratedBody[];
}

export interface RegenerateInventoryResult {
  readonly report: RegenerationReport;
  readonly reading: SensorReading;
}

interface RegenerationCandidate {
  readonly head: string;
  /** The commit time, so the same commit regenerates byte-identical bodies. */
  readonly timestamp: string;
}

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The exact commit the bodies describe, or the finding that explains why none can be
 * bound. A working tree that differs from HEAD would yield bodies describing no commit,
 * so regeneration stops before writing anything.
 */
function resolveCandidate(repoRoot: string): RegenerationCandidate | SensorFinding {
  let head = '';
  try {
    head = git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
  } catch {
    head = '';
  }
  if (!/^[0-9a-f]{40}$/u.test(head)) {
    return {
      severity: 'warning',
      code: 'INVENTORY_REGENERATION_NO_CANDIDATE',
      message:
        'No commit resolves at HEAD of the repository root, so no regenerated body can be bound to a candidate. Nothing was written.',
    };
  }
  try {
    if (git(repoRoot, ['status', '--porcelain']).length > 0) {
      return {
        severity: 'warning',
        code: 'INVENTORY_REGENERATION_SOURCE_DIRTY',
        message: `The working tree differs from HEAD ${head}, so regenerated bodies would describe no commit. Regenerate on a clean tree before recording. Nothing was written.`,
      };
    }
    const committed = git(repoRoot, ['log', '-1', '--format=%cI', head]);
    return { head, timestamp: new Date(committed).toISOString() };
  } catch (error) {
    return {
      severity: 'warning',
      code: 'INVENTORY_REGENERATION_NO_CANDIDATE',
      message: `The state of HEAD ${head} could not be read: ${messageOf(error)}`.slice(0, 200),
    };
  }
}

/** Write a body unless the file already holds exactly these bytes. */
function writeBody(
  repoRoot: string,
  relativePath: string,
  body: unknown,
): Pick<RegeneratedBody, 'action' | 'sha256'> {
  const bytes = `${JSON.stringify(body, null, 2)}\n`;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const target = join(repoRoot, relativePath);
  if (existsSync(target) && readFileSync(target, 'utf8') === bytes) {
    return { action: 'up-to-date', sha256 };
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  return { action: 'regenerated', sha256 };
}

function regenerationReading(
  status: SensorStatus,
  findings: readonly SensorFinding[],
  metrics: Readonly<Record<string, number | string | boolean>>,
): SensorReading {
  return buildSensorReading({
    sensorName: 'inventory-regeneration',
    sensorKind: 'inventory_regeneration',
    command: ['devai', 'sense', 'run', 'inventory_regeneration'],
    status,
    deterministic: true,
    tier: 'L0',
    findings,
    metrics,
    forceUniqueId: true,
  });
}

/** The required kinds: coverage is bound to http and actions, so both absent drops it. */
function requiredKinds(surfaces: RegenerationSurfaces | undefined): readonly RegeneratedKind[] {
  return surfaces !== undefined && !surfaces.http && !surfaces.actions
    ? ['inventory_dep_graph']
    : ['inventory_dep_graph', 'inventory_coverage'];
}

function produceKind(
  repoRoot: string,
  kind: RegeneratedKind,
  candidate: RegenerationCandidate,
  surfaces: RegenerationSurfaces | undefined,
): { readonly status: SensorStatus; readonly codes: string; readonly body: unknown } {
  const produced =
    kind === 'inventory_dep_graph'
      ? senseInventoryDepGraph({ repoRoot, persistBody: false, now: candidate.timestamp })
      : senseInventoryCoverage({
          repoRoot,
          persistBody: false,
          now: candidate.timestamp,
          ...(surfaces === undefined ? {} : { surfaces }),
        });
  return {
    status: produced.reading.status,
    codes: (produced.reading.findings ?? []).map((finding) => finding.code).join(','),
    body: produced.body,
  };
}

/**
 * `sense run inventory_regeneration` (#237, ADR-SCR-0012). Regenerates, for the clean
 * HEAD commit, the combined F4 manifest `inventory_adherence` reads and the bodies of the
 * required kinds through their own typed producers and validators, then rebuilds the
 * remaining kinds from their bodies as `sense record --rebuild` does. A producer's REVIEW
 * stays REVIEW in the aggregate; an error or a missing required kind is never a PASS.
 * Without a clean candidate commit it reads UNKNOWN and writes nothing.
 */
export async function regenerateInventoryReadings(
  repoRoot: string,
  options: RegenerationOptions = {},
): Promise<RegenerateInventoryResult> {
  const candidate = resolveCandidate(repoRoot);
  if ('code' in candidate) {
    return {
      report: {
        ok: false,
        repo_root: repoRoot,
        entries: [],
        created: 0,
        skipped: 0,
        errors: [],
        integration_head: null,
        regenerated: [],
      },
      reading: regenerationReading('unknown', [candidate], {
        kinds_touched: 0,
        kinds_rebuilt: 0,
        kinds_up_to_date: 0,
        error_count: 0,
      }),
    };
  }

  const errors: string[] = [];
  const regenerated: RegeneratedBody[] = [];
  const findings: SensorFinding[] = [];
  let surfaceCount = 0;
  try {
    const inventory = await regenerateInventory({
      repoRoot,
      timestamp: candidate.timestamp,
      integrationHead: candidate.head,
    });
    if (!validators.inventory(inventory)) {
      throw new Error(
        `body fails inventory.schema.json: ${JSON.stringify(validators.inventory.errors)}`,
      );
    }
    surfaceCount =
      inventory.modules.length +
      inventory.routes.length +
      inventory.components.length +
      inventory.dependency_graph.length;
    regenerated.push({
      kind: 'inventory',
      body_path: INVENTORY_BODY_PATH,
      producer_status: 'pass',
      ...writeBody(repoRoot, INVENTORY_BODY_PATH, inventory),
    });
  } catch (error) {
    errors.push(`regenerate ${INVENTORY_BODY_PATH} failed: ${messageOf(error)}`);
  }

  const required = requiredKinds(options.surfaces);
  for (const kind of required) {
    const bodyPath = REGENERATED_BODY_PATHS[kind];
    try {
      const produced = produceKind(repoRoot, kind, candidate, options.surfaces);
      if (produced.status !== 'pass' && produced.status !== 'review') {
        errors.push(
          `regenerate ${bodyPath} failed: ${kind} read ${produced.status} (${produced.codes})`,
        );
        continue;
      }
      regenerated.push({
        kind,
        body_path: bodyPath,
        producer_status: produced.status,
        ...writeBody(repoRoot, bodyPath, produced.body),
      });
    } catch (error) {
      errors.push(`regenerate ${bodyPath} failed: ${messageOf(error)}`);
    }
  }

  // Regenerated kinds never fall back to a reading synthesized from their bodies.
  const walk = walkInventoryBodies(repoRoot, new Set(required));
  errors.push(...walk.errors);
  const kinds = regenerated.filter((body) => body.kind !== 'inventory');
  const kindsTouched = new Set([
    ...kinds.map((body) => body.kind),
    ...walk.entries.map((entry) => entry.kind),
  ]).size;
  const missing = required.filter((kind) => !kinds.some((body) => body.kind === kind));

  let status: SensorStatus;
  if (errors.length > 0) {
    status = 'fail';
    findings.push(...errorFindings(errors));
  } else if (kindsTouched === 0) {
    status = 'review';
    findings.push(NO_KINDS_TOUCHED);
  } else {
    status = 'pass';
    if (surfaceCount === 0) {
      status = 'review';
      findings.push({
        severity: 'warning',
        code: 'INVENTORY_REGENERATION_EMPTY_INVENTORY',
        message:
          'The regenerated inventory holds no module, route, component, or dependency surface, so adherence has nothing to measure.',
      });
    }
    for (const body of kinds) {
      if (body.producer_status !== 'review') continue;
      status = 'review';
      findings.push({
        severity: 'info',
        code: 'INVENTORY_REGENERATION_KIND_REVIEW',
        message: `${body.kind} was regenerated and its producer reads REVIEW; that standing is kept.`,
      });
    }
  }

  const inventoryBody = regenerated.find((body) => body.kind === 'inventory');
  const reading = regenerationReading(status, findings, {
    kinds_touched: kindsTouched,
    kinds_rebuilt: walk.created + kinds.filter((body) => body.action === 'regenerated').length,
    kinds_up_to_date: walk.skipped + kinds.filter((body) => body.action === 'up-to-date').length,
    error_count: errors.length,
    required_kinds: required.length,
    missing_required_kinds: missing.length,
    integration_head: candidate.head,
    ...(inventoryBody === undefined ? {} : { inventory_body_sha256: inventoryBody.sha256 }),
    ...Object.fromEntries(kinds.map((body) => [`${body.kind}_status`, body.producer_status])),
  });
  persistSensorReading(reading, repoRoot);
  return {
    report: {
      ok: errors.length === 0,
      repo_root: repoRoot,
      entries: walk.entries,
      created: walk.created,
      skipped: walk.skipped,
      errors,
      integration_head: candidate.head,
      regenerated,
    },
    reading,
  };
}
