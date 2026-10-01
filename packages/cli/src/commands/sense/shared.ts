import { mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { loadSchema, type SchemaName } from '@devai-nyx/schemas';
import { resolveSensorParams } from '@devai-nyx/skills';
import type { SensorReading } from '@devai-nyx/sensors';
import { isSensorKind } from '@devai-nyx/sensors/registry';
import { EXIT_PASS, EXIT_USAGE } from '@devai-nyx/utils';

export const DEFAULT_REPO_ROOT = '.';

/**
 * Phase 19.B (D-61): per-sensor pack-tune helper. When a sense CLI
 * invocation opts in via `--pack-tune` (or pins a pack with
 * `--pack-id`), this resolves the matched pack's `extractor_params`
 * for the given sensor kind and returns them as a defaults map.
 * CLI flags supplied explicitly always win over pack defaults; the
 * caller is responsible for that precedence.
 *
 * Returns an empty object when:
 *   - The caller did not opt in (packTune undefined/false and packId
 *     undefined).
 *   - No pack matches the adopter root.
 *   - The matched pack declares no params for this sensor kind.
 */
export interface PackTuneInputs {
  readonly packTune?: boolean;
  readonly packId?: string;
  readonly packsRoot?: string;
}

export function maybeResolvePackParams(
  sensorKind: string,
  adopterRoot: string,
  inputs: PackTuneInputs,
): Readonly<Record<string, unknown>> {
  if (inputs.packTune !== true && inputs.packId === undefined) return {};
  const resolved = resolveSensorParams({
    adopterRoot,
    sensorKind,
    ...(inputs.packsRoot !== undefined && { packsRoot: inputs.packsRoot }),
    ...(inputs.packId !== undefined && { explicitId: inputs.packId }),
  });
  return resolved?.params ?? {};
}

/**
 * Map a SensorReading status to a process exit code.
 *
 * CTX-07 separates successful observations from execution errors. PASS,
 * REVIEW, UNKNOWN, and SKIPPED are payload verdicts and exit 0. A sensor
 * invoked as a gate exits 3 on FAIL. Operational ERROR/KILLED outcomes exit 6
 * and never manufacture a verdict.
 */
export function exitFor(status: SensorReading['status']): number {
  switch (status) {
    case 'pass':
    case 'skipped':
    case 'unknown':
    case 'review':
      return EXIT_PASS;
    case 'fail':
      return 3;
    case 'error':
    case 'killed':
      return 6;
  }
}

export function emit(reading: SensorReading, human: boolean): void {
  if (human) {
    const findings = (reading.findings ?? [])
      .map(
        (f) =>
          `  [${f.severity}] ${f.code}: ${f.message}${f.file !== undefined ? ` (${f.file}${f.line !== undefined ? `:${String(f.line)}` : ''})` : ''}`,
      )
      .join('\n');
    process.stdout.write(
      `${reading.sensor.name} [${reading.sensor.kind}]: ${reading.status.toUpperCase()}` +
        (reading.duration_ms !== undefined ? ` (${String(reading.duration_ms)}ms)` : '') +
        '\n' +
        (findings.length > 0 ? findings + '\n' : ''),
    );
  } else {
    process.stdout.write(JSON.stringify(reading) + '\n');
  }
}

/**
 * Persist a SensorReading to
 * `<repoRoot>/.devai/state/sensor-readings/<kind>/<id>.json`. The
 * scorecard machinery (in `@devai-nyx/skills` via
 * `loadReadingsFromDir`) reads from this directory; without
 * persistence, the autonomous loop's scorecard → backlog →
 * assessment recipes receive all-UNKNOWN cells and
 * produces no useful work for adopters.
 *
 * Pre-21.E, the sense-* commands built SensorReading records and
 * emitted them to stdout via `emit()` but never persisted them.
 * Omitting this record makes
 * the autonomous loop non-functional for adopters even though the
 * substrate wired correctly end-to-end.
 *
 * Writes are best-effort: directory-creation or write failures
 * surface as a stderr note but don't change the SensorReading's
 * status. The sense command's exit code is driven by the reading,
 * not by the persistence side-effect.
 */
export function persistSensorReading(reading: SensorReading, repoRoot: string): string {
  const dir = join(repoRoot, '.devai/state/sensor-readings', reading.sensor.kind);
  const target = join(dir, `${reading.id}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, JSON.stringify(reading, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(
      `warning: failed to persist SensorReading to ${target}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  return target;
}

/**
 * Shared post-amble for every supported sense observation. R21 D-139
 * supersedes the Phase 21.E/D-120 implicit persistence behavior: an
 * observation emits its reading and exits, but never creates state. A caller
 * that wants canonical persistence invokes the separately governed
 * `sense readings record` mutation over the exact emitted artifact.
 */
export interface FinishSenseOptions {
  readonly repoRoot: string;
  readonly human?: boolean;
}

export function finishSenseCommand(reading: SensorReading, opts: FinishSenseOptions): void {
  emit(reading, opts.human === true);
  process.exitCode = exitFor(reading.status);
}

export type InventoryOutputMode = 'reading' | 'body';

export interface FinishInventorySenseOptions extends FinishSenseOptions {
  readonly output?: string;
}

/**
 * Emit either the ordinary SensorReading or an inventory's complete body.
 *
 * D-139 makes both modes pure observations: selecting `body` changes stdout,
 * never persistence. The default remains `reading` so `sense run` and existing
 * machine consumers retain the stable SensorReading contract.
 */
export function finishInventorySenseCommand(
  reading: SensorReading,
  body: unknown,
  opts: FinishInventorySenseOptions,
): void {
  const output = opts.output ?? 'reading';
  if (output !== 'reading' && output !== 'body') {
    process.stderr.write(
      `sense inventory: --output must be 'reading' or 'body' (got '${output}')\n`,
    );
    process.exit(EXIT_USAGE);
  }
  if (output === 'body') {
    if (opts.human === true) {
      process.stderr.write(
        'sense inventory: --output body cannot be combined with --format human\n',
      );
      process.exit(EXIT_USAGE);
    }
    process.stdout.write(JSON.stringify(body) + '\n');
    // Large inventories can exceed a pipe's buffer. Assigning exitCode lets
    // Node drain stdout before termination; process.exit() can truncate the
    // payload (observed at 65,536 bytes for DEVAI's own dependency graph).
    process.exitCode = exitFor(reading.status);
    return;
  }
  finishSenseCommand(reading, opts);
}

// ---------------------------------------------------------------------------
// ADR-SCR-0005: declared sensor inputs.
// ---------------------------------------------------------------------------

/** Adopter declaration of sensor inputs, relative to the repository root. */
export const SENSOR_INPUTS_DECLARATION_PATH = '.devai/config/sensor-inputs.json';

const SENSOR_INPUTS_SCHEMA_NAME = 'sensor-inputs.schema.json';

/** Keys whose value is one repository-relative path. */
const DECLARED_PATH_KEYS: ReadonlySet<string> = new Set([
  'adrDir',
  'invariantsDir',
  'coveragePath',
  'tsconfigPath',
]);
/**
 * Keys whose value is a list of repository-relative globs: test roots with one wildcard
 * segment each, and plant_depth's file exclusions, whose fixed prefix and first
 * wildcard expansion must stay inside the root the same way.
 */
const DECLARED_GLOB_KEYS: ReadonlySet<string> = new Set(['testGlobs', 'excludeGlobs']);

export type SenseInputsErrorCode =
  | 'SENSE_INPUTS_UNDECLARED_KEY'
  | 'SENSE_INPUTS_UNKNOWN_KIND'
  | 'SENSE_INPUTS_PATH_ESCAPES_ROOT'
  | 'SENSE_INPUTS_INVALID'
  | 'SENSE_INPUTS_SCHEMA_UNAVAILABLE';

/** Structured refusal of a sensor inputs declaration; the code is also in the message. */
export class SenseInputsError extends Error {
  readonly code: SenseInputsErrorCode;

  constructor(code: SenseInputsErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'SenseInputsError';
    this.code = code;
  }
}

export type SensorInputs = Readonly<Record<string, unknown>>;

/**
 * ADR-SCR-0003: the sensor kinds bound to a declared plant surface. Each receives the
 * declaration's `surfaces` object as the effective input `surfaces`; when the object
 * is omitted nothing is added and the sensor presumes every surface present.
 */
export const SURFACE_BOUND_SENSOR_KINDS: ReadonlySet<string> = new Set([
  'inventory_api',
  'inventory_routes',
  'inventory_data_model',
  'inventory_rbac',
  'inventory_data_handling',
  'inventory_coverage',
  'plant_coverage',
  'inventory_performance',
  // ADR-SCR-0008: inventory_adherence is N/A only when every surface is declared absent.
  'inventory_adherence',
]);

interface SensorInputsSchema {
  readonly validate: ValidateFunction;
  /** Declared keys per kind, read from the schema's `inputs` properties. */
  readonly keysByKind: ReadonlyMap<string, readonly string[]>;
}

interface RepositoryRoots {
  readonly lexical: string;
  readonly real: string;
}

let sensorInputsSchema: SensorInputsSchema | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadSensorInputsSchema(): SensorInputsSchema {
  if (sensorInputsSchema !== undefined) return sensorInputsSchema;
  let document: Record<string, unknown>;
  try {
    document = loadSchema(SENSOR_INPUTS_SCHEMA_NAME as string as SchemaName);
  } catch (error) {
    throw new SenseInputsError(
      'SENSE_INPUTS_SCHEMA_UNAVAILABLE',
      `cannot load the installed ${SENSOR_INPUTS_SCHEMA_NAME}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const defs = isRecord(document['$defs']) ? document['$defs'] : {};
  const properties = isRecord(document['properties']) ? document['properties'] : {};
  const inputs = isRecord(properties['inputs']) ? properties['inputs'] : {};
  const kinds = isRecord(inputs['properties']) ? inputs['properties'] : {};
  const keysByKind = new Map<string, readonly string[]>();
  for (const [kind, contract] of Object.entries(kinds)) {
    const ref = isRecord(contract) ? contract['$ref'] : undefined;
    const definition =
      typeof ref === 'string' && ref.startsWith('#/$defs/')
        ? defs[ref.slice('#/$defs/'.length)]
        : contract;
    const keys =
      isRecord(definition) && isRecord(definition['properties'])
        ? Object.keys(definition['properties'])
        : [];
    keysByKind.set(kind, Object.freeze(keys));
  }
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  sensorInputsSchema = { validate: ajv.compile(document), keysByKind };
  return sensorInputsSchema;
}

/** Input keys the schema lets a kind declare; empty for a kind that takes none. */
export function declaredInputKeys(sensorKind: string): readonly string[] {
  return loadSensorInputsSchema().keysByKind.get(sensorKind) ?? [];
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Real path of `target`, resolving the nearest existing ancestor when it does not exist. */
function nearestRealPath(target: string): string {
  const rest: string[] = [];
  let current = target;
  for (;;) {
    try {
      return join(realpathSync(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return target;
      rest.push(basename(current));
      current = parent;
    }
  }
}

function assertInsideRoot(roots: RepositoryRoots, kind: string, key: string, value: string): void {
  const target = isAbsolute(value) ? value : resolve(roots.lexical, value);
  if (!isInside(roots.real, nearestRealPath(target))) {
    throw new SenseInputsError(
      'SENSE_INPUTS_PATH_ESCAPES_ROOT',
      `${kind}.${key} '${value}' resolves outside the repository root`,
    );
  }
}

function assertGlobInsideRoot(
  roots: RepositoryRoots,
  kind: string,
  key: string,
  glob: string,
): void {
  const parts = glob.split('/');
  const wildcard = parts.findIndex((part) => part.includes('*'));
  if (wildcard < 0) {
    assertInsideRoot(roots, kind, key, glob);
    return;
  }
  const before = parts.slice(0, wildcard).join('/');
  const after = parts.slice(wildcard + 1).join('/');
  assertInsideRoot(roots, kind, key, before === '' ? '.' : before);
  let entries: string[];
  try {
    entries = readdirSync(isAbsolute(before) ? before : resolve(roots.lexical, before));
  } catch {
    return;
  }
  // Each expansion is compared on real paths, so a symlinked entry cannot lead out.
  for (const entry of entries) {
    const expanded = [before, entry, after].filter((segment) => segment !== '').join('/');
    assertInsideRoot(roots, kind, key, expanded);
  }
}

function assertDeclaredKeys(schema: SensorInputsSchema, inputs: Record<string, unknown>): void {
  for (const [kind, entry] of Object.entries(inputs)) {
    if (!isSensorKind(kind)) {
      throw new SenseInputsError(
        'SENSE_INPUTS_UNKNOWN_KIND',
        `'${kind}' is not a registered sensor kind`,
      );
    }
    const accepted = schema.keysByKind.get(kind);
    if (accepted === undefined) {
      throw new SenseInputsError(
        'SENSE_INPUTS_UNDECLARED_KEY',
        `sensor kind '${kind}' takes no declared input`,
      );
    }
    if (!isRecord(entry)) continue;
    for (const key of Object.keys(entry)) {
      if (!accepted.includes(key)) {
        throw new SenseInputsError(
          'SENSE_INPUTS_UNDECLARED_KEY',
          `'${key}' is not a declared input of sensor kind '${kind}'`,
        );
      }
    }
  }
}

function assertPathsInsideRoot(repoRoot: string, inputs: Record<string, unknown>): void {
  const lexical = resolve(repoRoot);
  const roots: RepositoryRoots = { lexical, real: nearestRealPath(lexical) };
  for (const [kind, entry] of Object.entries(inputs)) {
    if (!isRecord(entry)) continue;
    for (const [key, value] of Object.entries(entry)) {
      if (DECLARED_PATH_KEYS.has(key) && typeof value === 'string') {
        assertInsideRoot(roots, kind, key, value);
      } else if (DECLARED_GLOB_KEYS.has(key) && Array.isArray(value)) {
        for (const glob of value) {
          if (typeof glob === 'string') assertGlobInsideRoot(roots, kind, key, glob);
        }
      }
    }
  }
}

function validateDeclaration(
  repoRoot: string,
  declaration: unknown,
): Readonly<Record<string, SensorInputs>> {
  const schema = loadSensorInputsSchema();
  const inputs = isRecord(declaration) ? declaration['inputs'] : undefined;
  if (isRecord(inputs)) {
    // Specific refusals first, so the code names the defect; the schema pass then
    // covers every remaining shape rule of the whole file.
    assertDeclaredKeys(schema, inputs);
    assertPathsInsideRoot(repoRoot, inputs);
  }
  if (!schema.validate(declaration)) {
    const [first] = schema.validate.errors ?? [];
    throw new SenseInputsError(
      'SENSE_INPUTS_INVALID',
      `${SENSOR_INPUTS_DECLARATION_PATH} does not match ${SENSOR_INPUTS_SCHEMA_NAME}` +
        (first === undefined ? '' : ` at '${first.instancePath || '/'}': ${first.message ?? ''}`),
    );
  }
  return (declaration as { readonly inputs: Readonly<Record<string, SensorInputs>> }).inputs;
}

/**
 * Resolve the effective inputs of one sensor kind (ADR-SCR-0005).
 *
 * Reads `.devai/config/sensor-inputs.json` when present, validates the whole
 * declaration against the installed schema and the sensor registry, refuses a
 * declared path that leaves the repository root on real paths, and merges
 * `explicit` over the declared entry key by key (a declared list is replaced,
 * never concatenated). The explicit input is operator-supplied for one run: it
 * is not path-checked here and never written back. Without a declaration the
 * result is `explicit` alone, so sensor defaults stay in force. A kind bound to a
 * plant surface also receives the declared `surfaces` object (ADR-SCR-0003); when
 * the declaration omits it every surface is presumed present.
 */
export function resolveDeclaredSensorInputs(args: {
  readonly repoRoot: string;
  readonly sensorKind: string;
  readonly explicit?: SensorInputs;
}): SensorInputs {
  if (!isSensorKind(args.sensorKind)) {
    throw new SenseInputsError(
      'SENSE_INPUTS_UNKNOWN_KIND',
      `'${args.sensorKind}' is not a registered sensor kind`,
    );
  }
  const path = join(args.repoRoot, SENSOR_INPUTS_DECLARATION_PATH);
  if (!existsSync(path)) return Object.freeze({ ...(args.explicit ?? {}) });
  let declaration: unknown;
  try {
    declaration = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new SenseInputsError(
      'SENSE_INPUTS_INVALID',
      `${SENSOR_INPUTS_DECLARATION_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const declared = validateDeclaration(args.repoRoot, declaration)[args.sensorKind] ?? {};
  // The schema pass above has validated `surfaces` when present.
  const surfaces = isRecord(declaration) ? declaration['surfaces'] : undefined;
  const bound =
    surfaces !== undefined && SURFACE_BOUND_SENSOR_KINDS.has(args.sensorKind) ? { surfaces } : {};
  return Object.freeze({ ...declared, ...bound, ...(args.explicit ?? {}) });
}
