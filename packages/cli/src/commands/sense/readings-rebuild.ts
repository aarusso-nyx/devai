import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  execFileSync,
  existsSync,
  fileOpenConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from '@devai-nyx/authority';
import { basename, dirname, join, relative } from 'node:path';
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

const REGENERATED_KINDS = Object.keys(REGENERATED_BODY_PATHS) as readonly RegeneratedKind[];

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
  /** The typed producer's own reading, kept whole; absent for the combined manifest. */
  readonly producer_reading?: ProducerReading;
}

/** What binds a producer's reading to the exact repository state and body it was read from. */
export interface ProducerInputBinding {
  readonly integration_head: string;
  readonly integration_tree: string;
  readonly generated_at: string;
  readonly body_sha256: string;
}

/** A typed producer's own reading, preserved beside the aggregate that summarizes it. */
export interface ProducerReading {
  readonly sensor: { readonly name: string; readonly kind: string };
  readonly status: SensorStatus;
  readonly command: string;
  readonly command_hash: string;
  readonly findings: readonly SensorFinding[];
  readonly metrics: Readonly<Record<string, number | string | boolean>>;
  readonly input_binding: ProducerInputBinding;
}

/** The body of a kind the declaration no longer requires, removed so it stands in for nothing. */
export interface ObsoleteBody {
  readonly kind: RegeneratedKind;
  readonly body_path: string;
  readonly action: 'removed';
}

export interface RegenerationReport extends RebuildReport {
  /** The commit every regenerated body is bound to; null when none could be bound. */
  readonly integration_head: string | null;
  /** The bodies this run published or found up to date; empty when nothing was published. */
  readonly regenerated: readonly RegeneratedBody[];
  readonly obsolete: readonly ObsoleteBody[];
}

export interface RegenerateInventoryResult {
  readonly report: RegenerationReport;
  readonly reading: SensorReading;
}

interface RegenerationCandidate {
  readonly head: string;
  /** The tree of that commit: with the head, the identity the whole run is bound to. */
  readonly tree: string;
  /** The files git tracks at that commit; nothing else may enter a bound body. */
  readonly tracked: ReadonlySet<string>;
  /** The commit time, so the same commit regenerates byte-identical bodies. */
  readonly timestamp: string;
}

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

/** The repository-relative files git tracks, from its index, which a clean status pins to HEAD. */
function trackedFiles(repoRoot: string): ReadonlySet<string> {
  const listing = git(repoRoot, ['ls-files', '-z']);
  return new Set(listing.split('\0').filter((path) => path.length > 0));
}

/** A change since the candidate was resolved, or undefined when its identity still holds. */
function snapshotChange(repoRoot: string, candidate: RegenerationCandidate): string | undefined {
  try {
    const head = git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (head !== candidate.head) return `HEAD moved from ${candidate.head} to ${head}`;
    const tree = git(repoRoot, ['rev-parse', '--verify', `${head}^{tree}`]);
    if (tree !== candidate.tree) return `the tree of ${head} changed from ${candidate.tree}`;
    if (git(repoRoot, ['status', '--porcelain']).length > 0) {
      return `the working tree no longer matches ${head}`;
    }
    return undefined;
  } catch (error) {
    return `the repository state could not be read again: ${messageOf(error)}`;
  }
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
    const tree = git(repoRoot, ['rev-parse', '--verify', `${head}^{tree}`]);
    return {
      head,
      tree,
      tracked: trackedFiles(repoRoot),
      timestamp: new Date(committed).toISOString(),
    };
  } catch (error) {
    return {
      severity: 'warning',
      code: 'INVENTORY_REGENERATION_NO_CANDIDATE',
      message: `The state of HEAD ${head} could not be read: ${messageOf(error)}`.slice(0, 200),
    };
  }
}

interface BodyValidator {
  (value: unknown): boolean;
  readonly errors?: unknown;
}

/** Each body's own schema: every produced body is validated whatever its producer read. */
function bodySchema(kind: RegeneratedBody['kind']): {
  readonly schema: string;
  readonly validate: BodyValidator;
} {
  if (kind === 'inventory')
    return { schema: 'inventory.schema.json', validate: validators.inventory };
  if (kind === 'inventory_dep_graph') {
    return { schema: 'dep-graph.schema.json', validate: validators.depGraph };
  }
  return { schema: 'coverage-matrix.schema.json', validate: validators.coverageMatrix };
}

/** A validated body and the exact bytes publication will write. */
interface StagedBody extends RegeneratedBody {
  readonly bytes: string;
}

function stageBody(
  repoRoot: string,
  kind: RegeneratedBody['kind'],
  bodyPath: string,
  producerStatus: SensorStatus,
  body: unknown,
  producer?: { readonly reading: SensorReading; readonly candidate: RegenerationCandidate },
): StagedBody {
  const { schema, validate } = bodySchema(kind);
  if (!validate(body)) throw new Error(`body fails ${schema}: ${JSON.stringify(validate.errors)}`);
  const bytes = `${JSON.stringify(body, null, 2)}\n`;
  const target = join(repoRoot, bodyPath);
  const unchanged = existsSync(target) && readFileSync(target, 'utf8') === bytes;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    kind,
    body_path: bodyPath,
    action: unchanged ? 'up-to-date' : 'regenerated',
    producer_status: producerStatus,
    sha256,
    ...(producer === undefined
      ? {}
      : {
          producer_reading: preserveProducerReading(producer.reading, producer.candidate, sha256),
        }),
    bytes,
  };
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(
    directory,
    fileOpenConstants.O_RDONLY | (fileOpenConstants.O_DIRECTORY ?? 0),
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Durable bytes in a fresh temporary file beside `target`; no walker reads a `.tmp` name. */
function writeTemporary(target: string, bytes: string): string {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, 'wx', 0o644);
  try {
    writeSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return temporary;
}

function discardTemporary(temporary: string): void {
  try {
    if (existsSync(temporary)) unlinkSync(temporary);
  } catch {
    // An unpublished temporary that cannot be removed still never ends in `.json`.
  }
}

/**
 * Publish a complete set of validated bodies together. Every changed body is first written
 * to a durable temporary file; only when all of them exist is each renamed over its target
 * and its directory synced. A failure before the renames publishes nothing.
 */
function publishBodies(repoRoot: string, staged: readonly StagedBody[]): void {
  const pending: { readonly temporary: string; readonly target: string }[] = [];
  try {
    for (const body of staged) {
      if (body.action !== 'regenerated') continue;
      const target = join(repoRoot, body.body_path);
      pending.push({ temporary: writeTemporary(target, body.bytes), target });
    }
    for (const { temporary, target } of pending) {
      renameSync(temporary, target);
      fsyncDirectory(dirname(target));
    }
  } catch (error) {
    for (const { temporary } of pending) discardTemporary(temporary);
    throw error;
  }
}

/** Remove the bodies of regenerated kinds the declaration no longer requires. */
function removeObsoleteBodies(
  repoRoot: string,
  required: readonly RegeneratedKind[],
): readonly ObsoleteBody[] {
  const removed: ObsoleteBody[] = [];
  for (const kind of REGENERATED_KINDS) {
    if (required.includes(kind)) continue;
    const target = join(repoRoot, REGENERATED_BODY_PATHS[kind]);
    if (!existsSync(target)) continue;
    unlinkSync(target);
    fsyncDirectory(dirname(target));
    removed.push({ kind, body_path: REGENERATED_BODY_PATHS[kind], action: 'removed' });
  }
  return removed;
}

/** Persist the aggregate reading as a new store file; the failure text when it cannot be. */
function persistRegenerationReading(repoRoot: string, reading: SensorReading): string | undefined {
  const target = join(
    repoRoot,
    '.devai/state/sensor-readings',
    reading.sensor.kind,
    `${reading.id}.json`,
  );
  let temporary: string | undefined;
  try {
    if (existsSync(target)) throw new Error(`reading ${reading.id} already exists`);
    temporary = writeTemporary(target, `${JSON.stringify(reading, null, 2)}\n`);
    renameSync(temporary, target);
    fsyncDirectory(dirname(target));
    return undefined;
  } catch (error) {
    if (temporary !== undefined) discardTemporary(temporary);
    return `persist ${target} failed: ${messageOf(error)}`;
  }
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
): {
  readonly status: SensorStatus;
  readonly codes: string;
  readonly body: unknown;
  readonly reading: SensorReading;
} {
  const admitFile = (path: string): boolean => candidate.tracked.has(relative(repoRoot, path));
  const produced =
    kind === 'inventory_dep_graph'
      ? senseInventoryDepGraph({
          repoRoot,
          persistBody: false,
          now: candidate.timestamp,
          admitFile,
        })
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
    reading: produced.reading,
  };
}

/** The producer's own reading with the state and body it is bound to, kept beside the aggregate. */
function preserveProducerReading(
  reading: SensorReading,
  candidate: RegenerationCandidate,
  bodySha256: string,
): ProducerReading {
  return {
    sensor: { name: reading.sensor.name, kind: reading.sensor.kind },
    status: reading.status,
    command: reading.command,
    command_hash: reading.command_hash,
    findings: (reading.findings ?? []).map((finding) => ({ ...finding })),
    metrics: { ...(reading.metrics ?? {}) },
    input_binding: {
      integration_head: candidate.head,
      integration_tree: candidate.tree,
      generated_at: candidate.timestamp,
      body_sha256: bodySha256,
    },
  };
}

/** The aggregate's record of one producer's reading: its findings, hash, binding and metrics. */
function producerRecord(
  repoRoot: string,
  body: RegeneratedBody,
): {
  readonly findings: SensorFinding[];
  readonly metrics: Record<string, number | string>;
} {
  const reading = body.producer_reading;
  if (reading === undefined) return { findings: [], metrics: {} };
  const metrics: Record<string, number | string> = {
    [`${body.kind}_command_hash`]: reading.command_hash,
    [`${body.kind}_input_sha256`]: reading.input_binding.body_sha256,
    [`${body.kind}_finding_count`]: reading.findings.length,
  };
  for (const [name, value] of Object.entries(reading.metrics)) {
    metrics[`${body.kind}_metric_${name}`] =
      typeof value === 'number' || typeof value === 'string' ? value : String(value);
  }
  return {
    findings: reading.findings.map((finding) => ({
      severity: finding.severity,
      code: 'INVENTORY_REGENERATION_PRODUCER_FINDING',
      // The checkout's own location names no part of the reading the store keeps.
      message:
        `${body.kind} [${finding.code}]: ${finding.message.split(`${repoRoot}/`).join('')}`.slice(
          0,
          400,
        ),
      ...(finding.file === undefined ? {} : { file: finding.file }),
      ...(finding.line === undefined ? {} : { line: finding.line }),
    })),
    metrics,
  };
}

/** The run that bound no candidate or lost its snapshot: UNKNOWN, with nothing written. */
function unwrittenResult(repoRoot: string, finding: SensorFinding): RegenerateInventoryResult {
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
      obsolete: [],
    },
    reading: regenerationReading('unknown', [finding], {
      kinds_touched: 0,
      kinds_rebuilt: 0,
      kinds_up_to_date: 0,
      error_count: 0,
    }),
  };
}

/**
 * `sense run inventory_regeneration` (#237, ADR-SCR-0012). Regenerates, for the clean
 * HEAD commit, the combined F4 manifest `inventory_adherence` reads and the bodies of the
 * required kinds through their own typed producers, validates every body against its
 * schema, and publishes the set only when all of it is valid, by atomic replacement. It
 * removes the body of a regenerated kind the declaration no longer requires, then rebuilds
 * the kinds it does not regenerate from their bodies as `sense record --rebuild` does.
 * A producer's REVIEW stays REVIEW; an error, a missing required kind, or an aggregate
 * reading the store did not receive is a FAIL. Without a clean candidate commit it reads
 * UNKNOWN and writes nothing.
 */
export async function regenerateInventoryReadings(
  repoRoot: string,
  options: RegenerationOptions = {},
): Promise<RegenerateInventoryResult> {
  const candidate = resolveCandidate(repoRoot);
  if ('code' in candidate) return unwrittenResult(repoRoot, candidate);

  const errors: string[] = [];
  const findings: SensorFinding[] = [];
  const staged: StagedBody[] = [];
  let surfaceCount = 0;
  try {
    const inventory = await regenerateInventory({
      repoRoot,
      timestamp: candidate.timestamp,
      integrationHead: candidate.head,
      admittedFiles: candidate.tracked,
    });
    surfaceCount =
      inventory.modules.length +
      inventory.routes.length +
      inventory.components.length +
      inventory.dependency_graph.length;
    staged.push(stageBody(repoRoot, 'inventory', INVENTORY_BODY_PATH, 'pass', inventory));
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
      staged.push(
        stageBody(repoRoot, kind, bodyPath, produced.status, produced.body, {
          reading: produced.reading,
          candidate,
        }),
      );
    } catch (error) {
      errors.push(`regenerate ${bodyPath} failed: ${messageOf(error)}`);
    }
  }

  // Only a complete, validated set is published; any failure publishes and rebuilds nothing.
  let regenerated: readonly RegeneratedBody[] = [];
  let obsolete: readonly ObsoleteBody[] = [];
  let walk: BodyWalk = { entries: [], errors: [], created: 0, skipped: 0 };
  if (errors.length === 0) {
    // The walk was asynchronous: publish only if HEAD, its tree and a clean status still hold.
    const changed = snapshotChange(repoRoot, candidate);
    if (changed !== undefined) {
      return unwrittenResult(repoRoot, {
        severity: 'warning',
        code: 'INVENTORY_REGENERATION_SNAPSHOT_CHANGED',
        message:
          `The repository changed while the inventory was regenerated (${changed}), so the bodies describe no single commit. Nothing was written.`.slice(
            0,
            400,
          ),
      });
    }
    try {
      publishBodies(repoRoot, staged);
      regenerated = staged.map((body) => ({
        kind: body.kind,
        body_path: body.body_path,
        action: body.action,
        producer_status: body.producer_status,
        sha256: body.sha256,
        ...(body.producer_reading === undefined ? {} : { producer_reading: body.producer_reading }),
      }));
      obsolete = removeObsoleteBodies(repoRoot, required);
    } catch (error) {
      errors.push(`publish regenerated bodies failed: ${messageOf(error)}`);
    }
  }
  if (errors.length === 0) {
    // No regenerated kind, required or not, ever falls back to a body-synthesized reading.
    walk = walkInventoryBodies(repoRoot, new Set<string>(REGENERATED_KINDS));
    errors.push(...walk.errors);
  }
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

  // Each producer's own reading rides with the aggregate instead of its bare status.
  const records = kinds.map((body) => producerRecord(repoRoot, body));
  findings.push(...records.flatMap((record) => record.findings));
  const inventoryBody = regenerated.find((body) => body.kind === 'inventory');
  const metrics = {
    kinds_touched: kindsTouched,
    kinds_rebuilt: walk.created + kinds.filter((body) => body.action === 'regenerated').length,
    kinds_up_to_date: walk.skipped + kinds.filter((body) => body.action === 'up-to-date').length,
    error_count: errors.length,
    required_kinds: required.length,
    missing_required_kinds: missing.length,
    obsolete_bodies_removed: obsolete.length,
    integration_head: candidate.head,
    integration_tree: candidate.tree,
    ...(inventoryBody === undefined ? {} : { inventory_body_sha256: inventoryBody.sha256 }),
    ...Object.fromEntries(kinds.map((body) => [`${body.kind}_status`, body.producer_status])),
    ...Object.assign({}, ...records.map((record) => record.metrics)),
  };
  const reading = regenerationReading(status, findings, metrics);
  const unpersisted = persistRegenerationReading(repoRoot, reading);
  const report = {
    repo_root: repoRoot,
    entries: walk.entries,
    created: walk.created,
    skipped: walk.skipped,
    integration_head: candidate.head,
    regenerated,
    obsolete,
  };
  if (unpersisted === undefined) {
    return { report: { ...report, ok: errors.length === 0, errors }, reading };
  }
  // The store holds no record of this run, so the run is a failure that says why.
  errors.push(unpersisted);
  return {
    report: { ...report, ok: false, errors },
    reading: regenerationReading(
      'fail',
      [
        {
          severity: 'error',
          code: 'INVENTORY_REGENERATION_READING_UNPERSISTED',
          message: `The regeneration reading was not written to the readings store, so nothing records this run: ${unpersisted}`,
        },
        ...findings,
      ],
      { ...metrics, error_count: errors.length },
    ),
  };
}
