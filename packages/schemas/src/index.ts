// @devai-nyx/schemas — canonical validator registry.
// W02.c: lazy per-schema compilation — compile on first access, never eagerly.
// Schemas are authored in law/schemas/ (canonical); the build stages copies into
// dist (prepack pattern). The wireframe resolves the authored tree directly.
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROSTER, type SchemaName } from './roster.js';
export { ROSTER } from './roster.js';
export type { SchemaName } from './roster.js';

/** Assembly replaces only this fixed function with checked package asset literals. */
function bundledPackageAssets(): Readonly<Record<string, string>> | undefined {
  return undefined;
}
const CODE_BOUND_ASSETS = bundledPackageAssets();

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_SCHEMAS_DIR = join(HERE, 'schemas');
const SCHEMAS_DIR =
  CODE_BOUND_ASSETS !== undefined || existsSync(BUNDLED_SCHEMAS_DIR)
    ? BUNDLED_SCHEMAS_DIR
    : join(HERE, '..', '..', '..', 'law', 'schemas');
const AVAILABLE_SCHEMA_NAMES =
  CODE_BOUND_ASSETS !== undefined || existsSync(BUNDLED_SCHEMAS_DIR)
    ? (ROSTER as readonly SchemaName[])
    : (readdirSync(SCHEMAS_DIR)
        .filter((name) => name.endsWith('.schema.json'))
        .sort() as SchemaName[]);
const SENSOR_REGISTRY_PATH = join(
  CODE_BOUND_ASSETS !== undefined || existsSync(join(HERE, 'sensor-registry.json'))
    ? HERE
    : join(SCHEMAS_DIR, '..', 'policy'),
  'sensor-registry.json',
);

const ajv = new Ajv2020({ strict: false });
addFormats(ajv);

const rawCache = new Map<SchemaName, Record<string, unknown>>();
let packageSnapshot:
  | {
      readonly schemas: ReadonlyMap<string, Buffer>;
      readonly sensorRegistry: Buffer;
    }
  | undefined =
  CODE_BOUND_ASSETS === undefined
    ? undefined
    : {
        schemas: new Map(
          Object.entries(CODE_BOUND_ASSETS)
            .filter(([path]) => path.startsWith('schemas/'))
            .map(([path, bytes]) => [path.slice('schemas/'.length), Buffer.from(bytes)]),
        ),
        sensorRegistry: Buffer.from(CODE_BOUND_ASSETS['sensor-registry.json'] ?? ''),
      };
let schemaAccessed = false;
let hostSnapshotBound = false;

/**
 * Internal trusted-host seam. The CLI verifies the package snapshot brand before
 * supplying its complete schema population. No callback, path or lazy fallback is
 * accepted here. Eager package compilation is allowed only from code-bound
 * literals, and this first host binding must prove their complete byte equality.
 * Ambient source compilation cannot be retroactively bound.
 */
export function bindSchemaPackageSnapshot(input: {
  readonly schemas: ReadonlyMap<string, Uint8Array>;
  readonly sensor_registry: Uint8Array;
}): void {
  const invalid = (): never => {
    throw new Error('rpl-package-identity-mismatch');
  };
  if (hostSnapshotBound || (schemaAccessed && CODE_BOUND_ASSETS === undefined)) invalid();
  const schemas = new Map<string, Buffer>();
  for (const [name, bytes] of input.schemas) {
    if (!/^[a-z0-9][a-z0-9-]*\.schema\.json$/u.test(name) || schemas.has(name)) invalid();
    schemas.set(name, Buffer.from(bytes));
  }
  if (ROSTER.some((name) => !schemas.has(name))) invalid();
  if (
    packageSnapshot !== undefined &&
    (schemas.size !== packageSnapshot.schemas.size ||
      [...schemas].some(([name, bytes]) => !packageSnapshot?.schemas.get(name)?.equals(bytes)) ||
      !packageSnapshot.sensorRegistry.equals(Buffer.from(input.sensor_registry)))
  )
    invalid();
  hostSnapshotBound = true;
  packageSnapshot = Object.freeze({ schemas, sensorRegistry: Buffer.from(input.sensor_registry) });
}

function schemaDocument(name: SchemaName): Record<string, unknown> {
  schemaAccessed = true;
  let s = rawCache.get(name);
  if (!s) {
    const bytes =
      packageSnapshot === undefined
        ? readFileSync(join(SCHEMAS_DIR, name))
        : packageSnapshot.schemas.get(name);
    if (bytes === undefined) throw new Error('rpl-package-identity-mismatch');
    s = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (name === 'sensor-reading.schema.json') {
      const registry = JSON.parse(
        (packageSnapshot === undefined
          ? readFileSync(SENSOR_REGISTRY_PATH)
          : packageSnapshot.sensorRegistry
        ).toString('utf8'),
      ) as {
        entries?: ReadonlyArray<{ kind?: unknown }>;
      };
      const kinds = (registry.entries ?? []).map((entry) => entry.kind);
      if (
        kinds.length === 0 ||
        kinds.some((kind) => typeof kind !== 'string' || kind.length === 0) ||
        new Set(kinds).size !== kinds.length
      ) {
        throw new Error('sensor registry has no unique live kind roster');
      }
      const sensor = (s['properties'] as Record<string, unknown>)['sensor'] as Record<
        string,
        unknown
      >;
      const sensorProperties = sensor['properties'] as Record<string, unknown>;
      const kindContract = sensorProperties['kind'] as Record<string, unknown>;
      kindContract['enum'] = kinds;
    }
    rawCache.set(name, s);
  }
  return s;
}

export function loadSchema(name: SchemaName): Record<string, unknown> {
  const document = schemaDocument(name);
  return packageSnapshot === undefined ? document : structuredClone(document);
}

let commonRegistered = false;
function ensureCommon(): void {
  if (!commonRegistered) {
    ajv.addSchema(schemaDocument('common-defs.schema.json'), 'common-defs.schema.json');
    ajv.addSchema(schemaDocument('record-meta.schema.json'), 'record-meta.schema.json');
    commonRegistered = true;
  }
}

function ensureSchemaReferences(name: SchemaName): void {
  if (name === 'action-result.schema.json' && ajv.getSchema('error.schema.json') === undefined) {
    ajv.addSchema(schemaDocument('error.schema.json'), 'error.schema.json');
  }
  if (name === 'adopter-policy.schema.json') {
    for (const dependency of [
      'glob-guards.schema.json',
      'project-config.schema.json',
      'scorecard-na-config.schema.json',
      'release-verification-profile.schema.json',
    ] as const) {
      if (ajv.getSchema(dependency) === undefined) {
        ajv.addSchema(schemaDocument(dependency), dependency);
      }
    }
  }
  if (
    name === 'github-issues-tracking-config.schema.json' &&
    ajv.getSchema('github-issues-tracking-policy.schema.json') === undefined
  ) {
    ajv.addSchema(
      schemaDocument('github-issues-tracking-policy.schema.json'),
      'github-issues-tracking-policy.schema.json',
    );
  }
  if (
    name === 'triage-classify-result.schema.json' &&
    ajv.getSchema('triage.schema.json') === undefined
  ) {
    ajv.addSchema(schemaDocument('triage.schema.json'), 'triage.schema.json');
  }
  if (
    (name === 'release-plan-receipt.schema.json' ||
      name === 'release-plan-receipt-v2.schema.json') &&
    ajv.getSchema('release-intent.schema.json') === undefined
  ) {
    ajv.addSchema(schemaDocument('release-intent.schema.json'), 'release-intent.schema.json');
  }
  if (
    name === 'release-plan-receipt-v2.schema.json' &&
    ajv.getSchema('release-policy-resolution.schema.json') === undefined
  ) {
    ajv.addSchema(
      schemaDocument('release-policy-resolution.schema.json'),
      'release-policy-resolution.schema.json',
    );
  }
  if (
    name === 'release-lifecycle-store-record.schema.json' &&
    ajv.getSchema('release-lifecycle-store-head.schema.json') === undefined
  ) {
    ajv.addSchema(
      schemaDocument('release-lifecycle-store-head.schema.json'),
      'release-lifecycle-store-head.schema.json',
    );
  }
  if (
    name === 'release-lifecycle-store-record.schema.json' &&
    ajv.getSchema('release-lifecycle-state.schema.json') === undefined
  ) {
    ajv.addSchema(
      schemaDocument('release-lifecycle-state.schema.json'),
      'release-lifecycle-state.schema.json',
    );
  }
}

const compiled = new Map<SchemaName, ReturnType<typeof ajv.compile>>();
export function getValidator(name: SchemaName) {
  schemaAccessed = true;
  let v = compiled.get(name);
  if (!v) {
    if (!(AVAILABLE_SCHEMA_NAMES as readonly string[]).includes(name))
      throw new Error(`unregistered schema: ${name}`);
    ensureCommon();
    ensureSchemaReferences(name);
    v =
      name === 'common-defs.schema.json' || name === 'record-meta.schema.json'
        ? (ajv.getSchema(name) ?? ajv.compile(schemaDocument(name)))
        : ajv.compile(schemaDocument(name));
    compiled.set(name, v);
  }
  return v;
}

function validatorKey(name: SchemaName): string {
  return name
    .replace(/\.schema\.json$/, '')
    .replace(/-([a-z0-9])/g, (_match, character: string) => character.toUpperCase());
}

type StripSchemaSuffix<Name extends string> = Name extends `${infer Base}.schema.json`
  ? Base
  : Name;
type CamelCase<Name extends string> = Name extends `${infer Head}-${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : Name;
export type ValidatorKey = CamelCase<StripSchemaSuffix<SchemaName>>;
type SourceCompilationValidatorKey =
  | ValidatorKey
  | 'adr'
  | 'agentRun'
  | 'apiMap'
  | 'assessment'
  | 'coverageMatrix'
  | 'dataModelInventory'
  | 'depGraph'
  | 'glossaryEntry'
  | 'invCandidate'
  | 'journey'
  | 'moduleBlueprint'
  | 'mutationIntent'
  | 'phaseClosure'
  | 'rbacInventory'
  | 'rgr'
  | 'routesInventory'
  | 'rtdManifest'
  | 'testWeakeningConfig'
  | 'useCases';
export type ValidatorRegistry = {
  readonly [Key in SourceCompilationValidatorKey]: ValidateFunction;
};

function lazyValidator(name: SchemaName): ValidateFunction {
  const validate = ((value: unknown) => getValidator(name)(value)) as ValidateFunction;
  Object.defineProperty(validate, 'errors', {
    enumerable: true,
    get: () => getValidator(name).errors,
  });
  return validate;
}

/**
 * Lazy compatibility registry for production consumers. The keys are derived
 * from the explicit roster (`sensor-reading` -> `sensorReading`), so a schema
 * cannot become callable without joining the governed roster first.
 */
export const validators = Object.freeze(
  Object.fromEntries(
    AVAILABLE_SCHEMA_NAMES.map((name) => [validatorKey(name), lazyValidator(name)]),
  ),
) as ValidatorRegistry;

export interface SchemaIssue {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly message?: string;
}

export type SchemaParseFailureKind = 'json-syntax' | 'schema-validation';

export class SchemaParseError extends Error {
  override readonly name = 'SchemaParseError';
  readonly code = 'DEVAI_SCHEMA_PARSE_ERROR';

  constructor(
    readonly schema: string,
    readonly kind: SchemaParseFailureKind,
    message: string,
    readonly issues: readonly SchemaIssue[] = [],
    readonly sourceError?: unknown,
  ) {
    super(message);
  }
}

export type SchemaParseResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SchemaParseError };

export interface SchemaParser {
  readonly schema: string;
  parse<T = unknown>(value: unknown): T;
  safeParse<T = unknown>(value: unknown): SchemaParseResult<T>;
  parseJson<T = unknown>(text: string): T;
  safeParseJson<T = unknown>(text: string): SchemaParseResult<T>;
}

function snapshotIssues(errors: readonly ErrorObject[] | null | undefined): readonly SchemaIssue[] {
  return (errors ?? []).map((error) => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    params: { ...error.params } as Readonly<Record<string, unknown>>,
    ...(error.message === undefined ? {} : { message: error.message }),
  }));
}

function makeParser(schema: string, validator: ValidateFunction): SchemaParser {
  const parse = <T = unknown>(value: unknown): T => {
    if (validator(value)) return value as T;
    throw new SchemaParseError(
      schema,
      'schema-validation',
      `${schema} failed schema validation`,
      snapshotIssues(validator.errors),
    );
  };
  const parseJson = <T = unknown>(source: string): T => {
    let value: unknown;
    try {
      value = JSON.parse(source) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SchemaParseError(schema, 'json-syntax', detail, [], error);
    }
    return parse(value);
  };
  const safe = <T = unknown>(
    operation: () => T,
    fallbackKind: SchemaParseFailureKind,
  ): SchemaParseResult<T> => {
    try {
      return { ok: true, value: operation() };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof SchemaParseError
            ? error
            : new SchemaParseError(schema, fallbackKind, String(error), [], error),
      };
    }
  };
  return {
    schema,
    parse,
    safeParse: (value) => safe(() => parse(value), 'schema-validation'),
    parseJson,
    safeParseJson: (source) => safe(() => parseJson(source), 'json-syntax'),
  };
}

export const parsers = Object.freeze(
  Object.fromEntries(
    Object.entries(validators).map(([schema, validator]) => [
      schema,
      makeParser(schema, validator),
    ]),
  ),
) as {
  readonly [Key in SourceCompilationValidatorKey]: SchemaParser;
};

export function listSchemaFiles(): string[] {
  return readdirSync(SCHEMAS_DIR)
    .filter((f) => f.endsWith('.schema.json'))
    .sort();
}

// --- the meta-schema gate (improvement 6, declarative half) ---
export interface MetaGateReport {
  compliant: string[];
  noncompliant: { name: string; errors: string[] }[];
}
export function metaGate(): MetaGateReport {
  const meta = getValidator('meta.schema.json');
  const report: MetaGateReport = { compliant: [], noncompliant: [] };
  for (const name of ROSTER) {
    if (meta(loadSchema(name))) report.compliant.push(name);
    else
      report.noncompliant.push({
        name,
        errors: (meta.errors ?? []).map((e) => `${e.instancePath} ${e.message}`),
      });
  }
  return report;
}

// --- check-schemas canon linter (improvement 6, recursive half — first slice) ---
const VERDICT_SETS = [
  JSON.stringify(['pass', 'review', 'fail']),
  JSON.stringify(['PASS', 'REVIEW', 'FAIL']),
];
export interface CanonFinding {
  schema: string;
  rule: string;
  path: string;
}
const PREDICATE_KEYWORDS = new Set(['if', 'then', 'else', 'contains', 'oneOf', 'allOf']);

export function checkSchema(name: string, schema: unknown): CanonFinding[] {
  const findings: CanonFinding[] = [];
  const walk = (node: unknown, path: string, predicateFragment: boolean): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`, predicateFragment));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    // Predicate fragments intentionally match part of a containing object. Only
    // complete object shapes must declare their additional-properties policy.
    if (
      !predicateFragment &&
      o['properties'] !== undefined &&
      o['additionalProperties'] === undefined &&
      path !== '$root'
    ) {
      findings.push({ schema: name, rule: 'open-world-object', path });
    }
    // rule: no restated verdict vocabulary outside common-defs
    if (name !== 'common-defs.schema.json' && Array.isArray(o['enum'])) {
      const e = JSON.stringify([...(o['enum'] as unknown[])].sort());
      if (VERDICT_SETS.includes(e))
        findings.push({ schema: name, rule: 'restated-verdict-enum', path });
    }
    for (const [k, v] of Object.entries(o)) {
      walk(v, `${path}/${k}`, predicateFragment || PREDICATE_KEYWORDS.has(k));
    }
  };
  walk(schema, '$root', false);
  return findings;
}

export function checkSchemas(): CanonFinding[] {
  const findings: CanonFinding[] = [];
  for (const name of ROSTER) {
    if (name === 'common-defs.schema.json') continue;
    findings.push(...checkSchema(name, loadSchema(name)));
  }
  return findings;
}
