import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  closeSync,
  execFileSync,
  existsSync,
  fileOpenConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from '@devai-nyx/authority';
import { basename, dirname, join, relative, sep } from 'node:path';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { loadSchema, validators, type SchemaName } from '@devai-nyx/schemas';
import {
  buildSensorReading,
  DIRECT_BODY_DIRECTORY,
  REGENERATED_BODY_DIRECTORY,
  senseInventoryApi,
  senseInventoryCoverage,
  senseInventoryDataHandling,
  senseInventoryDataModel,
  senseInventoryDepGraph,
  senseInventoryRbac,
  senseInventoryRoutes,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from '@devai-nyx/sensors';
import { regenerateInventory } from '#runtime-core';
import { persistSensorReading } from './shared.js';
import { resolveInventoryRouteInputs } from './inventory-inputs.js';

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

/**
 * The kinds regeneration produces from source, each through its own typed producer, in
 * dependency order: a kind's inputs are always produced before it. The routes body is
 * named for its framework (`routes-<framework>.json`), as `resolveRoutesPath` reads it.
 */
const REGENERATED_BODY_FILES = {
  inventory_api: 'inventory_api/api-map.json',
  inventory_routes: 'inventory_routes/routes-<framework>.json',
  inventory_data_model: 'inventory_data_model/data-model.json',
  inventory_rbac: 'inventory_rbac/rbac.json',
  inventory_data_handling: 'inventory_data_handling/data-model-pii.json',
  inventory_dep_graph: 'inventory_dep_graph/dep-graph.json',
  inventory_coverage: 'inventory_coverage/coverage-matrix.json',
} as const;

export type RegeneratedKind = keyof typeof REGENERATED_BODY_FILES;

const REGENERATED_KINDS = Object.keys(REGENERATED_BODY_FILES) as readonly RegeneratedKind[];

const ROUTES_BODY_NAME = /^routes-[^.]+\.json$/u;

/** The repository-relative state path of a kind's body; routes take the body's framework. */
function regeneratedBodyPath(kind: RegeneratedKind, body?: unknown): string {
  if (kind !== 'inventory_routes')
    return join(REGENERATED_BODY_DIRECTORY, REGENERATED_BODY_FILES[kind]);
  const framework =
    typeof body === 'object' && body !== null && 'framework' in body
      ? String((body as { readonly framework: unknown }).framework)
      : '';
  if (!/^[a-z0-9-]+$/u.test(framework)) {
    throw new Error(`routes body names no usable framework (${JSON.stringify(framework)})`);
  }
  return join(REGENERATED_BODY_DIRECTORY, 'inventory_routes', `routes-${framework}.json`);
}

/** The existing state bodies of a kind, as repository-relative paths. */
function existingBodyPaths(repoRoot: string, kind: RegeneratedKind): readonly string[] {
  if (kind !== 'inventory_routes') {
    const path = regeneratedBodyPath(kind);
    return existsSync(join(repoRoot, path)) ? [path] : [];
  }
  const directory = join(REGENERATED_BODY_DIRECTORY, 'inventory_routes');
  if (!existsSync(join(repoRoot, directory))) return [];
  return readdirSync(join(repoRoot, directory))
    .filter((name) => ROUTES_BODY_NAME.test(name))
    .sort()
    .map((name) => join(directory, name));
}

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
  /**
   * Whether an input may enter a bound body: git tracks it and it is a regular file. A
   * tracked symlink is refused, since its target need not be in the commit or the checkout.
   */
  readonly admit: (absolutePath: string) => boolean;
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

function admissionOf(
  repoRoot: string,
  tracked: ReadonlySet<string>,
): (absolutePath: string) => boolean {
  return (absolutePath) => {
    if (!tracked.has(relative(repoRoot, absolutePath))) return false;
    try {
      return lstatSync(absolutePath).isFile();
    } catch {
      return false;
    }
  };
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
      admit: admissionOf(repoRoot, trackedFiles(repoRoot)),
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
  switch (kind) {
    case 'inventory':
      return { schema: 'inventory.schema.json', validate: validators.inventory };
    case 'inventory_api':
      return { schema: 'api-map.schema.json', validate: validators.apiMap };
    case 'inventory_routes':
      return { schema: 'routes-inventory.schema.json', validate: validators.routesInventory };
    case 'inventory_data_model':
    case 'inventory_data_handling':
      return {
        schema: 'data-model-inventory.schema.json',
        validate: validators.dataModelInventory,
      };
    case 'inventory_rbac':
      return { schema: 'rbac-inventory.schema.json', validate: validators.rbacInventory };
    case 'inventory_dep_graph':
      return { schema: 'dep-graph.schema.json', validate: validators.depGraph };
    case 'inventory_coverage':
      return { schema: 'coverage-matrix.schema.json', validate: validators.coverageMatrix };
  }
}

const exhaustiveValidators = new Map<string, ValidateFunction>();

/** The body schema compiled to report every error, for a REVIEW body that fails it. */
function exhaustiveValidator(schema: string): ValidateFunction {
  let validate = exhaustiveValidators.get(schema);
  if (validate === undefined) {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    validate = ajv.compile(loadSchema(schema as SchemaName));
    exhaustiveValidators.set(schema, validate);
  }
  return validate;
}

/** A top-level collection the body holds empty, which the schema requires to hold one. */
function isEmptyCollection(body: unknown, error: ErrorObject): boolean {
  if (error.keyword !== 'minItems' || !/^\/[^/]+$/u.test(error.instancePath)) return false;
  if (typeof body !== 'object' || body === null) return false;
  const value = (body as Record<string, unknown>)[error.instancePath.slice(1)];
  return Array.isArray(value) && value.length === 0;
}

/**
 * Validate a produced body against its own schema before anything is staged. A producer
 * that inventories nothing reads REVIEW and returns its collection empty, which a schema
 * requiring at least one item rejects; that empty collection is the REVIEW the producer
 * already reports, so it alone does not refuse the body. Every other departure does, and
 * a PASS body must validate exactly.
 */
function validateBody(kind: RegeneratedBody['kind'], status: SensorStatus, body: unknown): void {
  const { schema, validate } = bodySchema(kind);
  if (validate(body)) return;
  let errors: unknown = validate.errors;
  if (status === 'review') {
    const exhaustive = exhaustiveValidator(schema);
    if (exhaustive(body)) return;
    const remaining = (exhaustive.errors ?? []).filter((error) => !isEmptyCollection(body, error));
    if (remaining.length === 0) return;
    errors = remaining;
  }
  throw new Error(`body fails ${schema}: ${JSON.stringify(errors)}`);
}

/**
 * A body the same commit regenerates byte for byte in any checkout. Producers name the
 * repository they read as `sourceRepo`, its absolute location; a bound body names it `.`,
 * the repository root it is published in. Any other trace of the checkout location refuses
 * the body, since it would describe one checkout rather than the commit.
 */
function portableBody(repoRoot: string, body: unknown): unknown {
  const portable =
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    typeof (body as Record<string, unknown>)['sourceRepo'] === 'string'
      ? { ...(body as Record<string, unknown>), sourceRepo: '.' }
      : body;
  if (JSON.stringify(portable).includes(repoRoot)) {
    throw new Error('body embeds the absolute checkout location, so it describes no commit');
  }
  return portable;
}

/**
 * A validated body, the exact bytes publication will write, and the durable temporary file
 * that holds them beside their target. A dependent producer reads its input from that
 * staged file, so nothing is published before the whole set is valid.
 */
interface StagedBody extends RegeneratedBody {
  readonly bytes: string;
  readonly temporary: string;
}

function stageBody(
  repoRoot: string,
  kind: RegeneratedBody['kind'],
  bodyPath: string,
  producerStatus: SensorStatus,
  body: unknown,
  producer?: { readonly reading: SensorReading; readonly candidate: RegenerationCandidate },
): StagedBody {
  validateBody(kind, producerStatus, body);
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
    temporary: writeTemporary(target, bytes),
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
 * Publish a complete set of validated bodies together. Every body was staged as a durable
 * temporary file when it was produced; only once the whole set is staged is each changed
 * body renamed over its target and its directory synced. An up-to-date body's temporary is
 * discarded. A failure before the renames publishes nothing.
 */
function publishBodies(repoRoot: string, staged: readonly StagedBody[]): void {
  for (const body of staged) {
    if (body.action !== 'regenerated') {
      discardTemporary(body.temporary);
      continue;
    }
    const target = join(repoRoot, body.body_path);
    renameSync(body.temporary, target);
    fsyncDirectory(dirname(target));
  }
}

/**
 * Remove every state body that no published body stands for: the bodies of kinds the
 * declaration no longer requires, and a routes body for a framework other than the one
 * just published, so no stale body is ever read as current.
 */
function removeObsoleteBodies(
  repoRoot: string,
  published: ReadonlySet<string>,
): readonly ObsoleteBody[] {
  const removed: ObsoleteBody[] = [];
  for (const kind of REGENERATED_KINDS) {
    for (const bodyPath of existingBodyPaths(repoRoot, kind)) {
      if (published.has(bodyPath)) continue;
      const target = join(repoRoot, bodyPath);
      unlinkSync(target);
      fsyncDirectory(dirname(target));
      removed.push({ kind, body_path: bodyPath, action: 'removed' });
    }
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

/**
 * The required kinds, in dependency order: each kind is required while a surface it is
 * bound to is declared present (ADR-SCR-0003). The dependency graph is always required;
 * coverage is bound to http and actions, so both absent drops it. RBAC and data handling
 * measure from the data model, so they are required only with `database` present too.
 */
function requiredKinds(surfaces: RegenerationSurfaces | undefined): readonly RegeneratedKind[] {
  const present = (surface: keyof RegenerationSurfaces): boolean =>
    surfaces === undefined || surfaces[surface];
  const bound: Readonly<Record<RegeneratedKind, boolean>> = {
    inventory_api: present('http'),
    inventory_routes: present('http'),
    inventory_data_model: present('database'),
    inventory_rbac: present('rbac') && present('database'),
    inventory_data_handling: present('rbac') && present('database'),
    inventory_dep_graph: true,
    inventory_coverage: present('http') || present('actions'),
  };
  return REGENERATED_KINDS.filter((kind) => bound[kind]);
}

/** The staged temporary file of a kind already produced in this run, if any. */
type StagedInputs = ReadonlyMap<RegeneratedKind, string>;

interface ProducedKind {
  readonly status: SensorStatus;
  readonly codes: string;
  readonly body: unknown;
  readonly reading: SensorReading;
}

function produceKind(
  repoRoot: string,
  kind: RegeneratedKind,
  candidate: RegenerationCandidate,
  surfaces: RegenerationSurfaces | undefined,
  inputs: StagedInputs,
): ProducedKind {
  const now = candidate.timestamp;
  const declared = surfaces === undefined ? {} : { surfaces };
  // A dependent reads exactly the bodies this run staged, passed explicitly; an input whose
  // kind is not required is passed as no path. Neither a published state body nor a
  // record/proofs default is ever read: each staged file is admitted beside the files git
  // tracks at the candidate, and no other file under an inventory body directory is.
  const staged = new Set(inputs.values());
  const bodyDirectories = [REGENERATED_BODY_DIRECTORY, DIRECT_BODY_DIRECTORY].map(
    (directory) => `${join(repoRoot, directory)}${sep}`,
  );
  const admitFile = (path: string): boolean =>
    staged.has(path) ||
    (candidate.admit(path) && !bodyDirectories.some((directory) => path.startsWith(directory)));
  const input = <K extends string>(name: K, from: RegeneratedKind): { [P in K]?: string } =>
    (inputs.has(from) ? { [name]: inputs.get(from) } : {}) as { [P in K]?: string };
  const requiredInput = (from: RegeneratedKind): string => {
    const path = inputs.get(from);
    if (path === undefined) throw new Error(`its input ${from} was not produced`);
    if (!admitFile(path)) throw new Error(`its input ${from} could not be admitted`);
    return path;
  };
  const common = { repoRoot, persistBody: false, now, ...declared } as const;
  let produced: { readonly reading: SensorReading; readonly body: unknown };
  switch (kind) {
    // The source walks describe only regular files tracked at the candidate HEAD, so an
    // ignored source file on a clean tree never enters a HEAD-bound body.
    case 'inventory_api':
      produced = senseInventoryApi({ ...common, admitFile });
      break;
    case 'inventory_routes':
      produced = senseInventoryRoutes({
        ...common,
        ...resolveInventoryRouteInputs(repoRoot),
        admitFile,
      });
      break;
    case 'inventory_data_model':
      produced = senseInventoryDataModel({ ...common, admitFile });
      break;
    case 'inventory_rbac':
      produced = senseInventoryRbac({
        ...common,
        dataModelPath: requiredInput('inventory_data_model'),
        // The rbac producer admits any file it is pointed at, so an api map this run did
        // not stage is named explicitly as no input rather than left to its defaults.
        apiMapPath: inputs.get('inventory_api') ?? null,
      });
      break;
    case 'inventory_data_handling':
      produced = senseInventoryDataHandling({
        ...common,
        dataModelPath: requiredInput('inventory_data_model'),
      });
      break;
    case 'inventory_dep_graph':
      produced = senseInventoryDepGraph({ repoRoot, persistBody: false, now, admitFile });
      break;
    case 'inventory_coverage':
      produced = senseInventoryCoverage({
        ...common,
        admitFile,
        ...input('apiMapPath', 'inventory_api'),
        ...input('routesPath', 'inventory_routes'),
      });
      break;
  }
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

/** Remove the bodies this run published after the snapshot moved; absence reads as missing, never stale. */
function retractedResult(
  repoRoot: string,
  staged: readonly StagedBody[],
  changed: string,
): RegenerateInventoryResult {
  const failures: string[] = [];
  for (const body of staged) {
    const target = join(repoRoot, body.body_path);
    try {
      if (existsSync(target)) {
        unlinkSync(target);
        fsyncDirectory(dirname(target));
      }
    } catch (error) {
      failures.push(`${body.body_path}: ${messageOf(error)}`);
    }
  }
  const outcome =
    failures.length === 0
      ? 'The bodies just published were removed, so none stands for a commit it does not describe.'
      : `Removing the bodies just published failed (${failures.join('; ')}), so they may be stale.`;
  return unwrittenResult(repoRoot, {
    severity: failures.length === 0 ? 'warning' : 'error',
    code: 'INVENTORY_REGENERATION_SNAPSHOT_CHANGED',
    message:
      `The repository changed while the inventory was published (${changed}). ${outcome}`.slice(
        0,
        400,
      ),
  });
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
 * kinds the declared surfaces require (#382) through their own typed producers, in
 * dependency order, each dependent reading its inputs from the files staged in the same
 * run. It validates every body against its schema and publishes the set only when all of
 * it is valid, by atomic replacement. It removes every state body no published body stands
 * for, then rebuilds any kind it does not regenerate from its body as `sense record
 * --rebuild` does; every inventory kind is now regenerated, so that walk finds none.
 * A producer's REVIEW stays REVIEW; an error, a missing required kind, or an aggregate
 * reading the store did not receive is a FAIL. Without a clean candidate commit it reads
 * UNKNOWN and writes nothing.
 */
export async function regenerateInventoryReadings(
  repoRoot: string,
  options: RegenerationOptions = {},
): Promise<RegenerateInventoryResult> {
  repoRoot = realpathSync(repoRoot);
  const candidate = resolveCandidate(repoRoot);
  if ('code' in candidate) return unwrittenResult(repoRoot, candidate);
  const staged: StagedBody[] = [];
  try {
    return await regenerateForCandidate(repoRoot, options, candidate, staged);
  } finally {
    // A published body's temporary was renamed away; every other staged file is discarded.
    for (const body of staged) discardTemporary(body.temporary);
  }
}

async function regenerateForCandidate(
  repoRoot: string,
  options: RegenerationOptions,
  candidate: RegenerationCandidate,
  staged: StagedBody[],
): Promise<RegenerateInventoryResult> {
  const errors: string[] = [];
  const findings: SensorFinding[] = [];
  let surfaceCount = 0;
  try {
    const inventory = await regenerateInventory({
      repoRoot,
      timestamp: candidate.timestamp,
      integrationHead: candidate.head,
      admitFile: candidate.admit,
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
  const inputs = new Map<RegeneratedKind, string>();
  for (const kind of required) {
    let bodyPath = join(REGENERATED_BODY_DIRECTORY, REGENERATED_BODY_FILES[kind]);
    try {
      const produced = produceKind(repoRoot, kind, candidate, options.surfaces, inputs);
      if (produced.status !== 'pass' && produced.status !== 'review') {
        errors.push(
          `regenerate ${bodyPath} failed: ${kind} read ${produced.status} (${produced.codes})`,
        );
        continue;
      }
      const portable = portableBody(repoRoot, produced.body);
      // The schema is checked before the body names its own path (routes-<framework>.json).
      validateBody(kind, produced.status, portable);
      bodyPath = regeneratedBodyPath(kind, portable);
      const staging = stageBody(repoRoot, kind, bodyPath, produced.status, portable, {
        reading: produced.reading,
        candidate,
      });
      staged.push(staging);
      inputs.set(kind, staging.temporary);
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
      obsolete = removeObsoleteBodies(repoRoot, new Set(staged.map((body) => body.body_path)));
      // Publication is not atomic with the check above: a commit or edit can land between
      // them. Check again afterwards; a stale set is retracted, so no body outlives its HEAD.
      const late = snapshotChange(repoRoot, candidate);
      if (late !== undefined) return retractedResult(repoRoot, staged, late);
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
