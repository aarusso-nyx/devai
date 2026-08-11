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

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_SCHEMAS_DIR = join(HERE, 'schemas');
const SCHEMAS_DIR = existsSync(BUNDLED_SCHEMAS_DIR)
  ? BUNDLED_SCHEMAS_DIR
  : join(HERE, '..', '..', '..', 'law', 'schemas');
const AVAILABLE_SCHEMA_NAMES = existsSync(BUNDLED_SCHEMAS_DIR)
  ? (ROSTER as readonly SchemaName[])
  : (readdirSync(SCHEMAS_DIR)
      .filter((name) => name.endsWith('.schema.json'))
      .sort() as SchemaName[]);
const SENSOR_REGISTRY_PATH = join(
  existsSync(join(HERE, 'sensor-registry.json')) ? HERE : join(SCHEMAS_DIR, '..', 'policy'),
  'sensor-registry.json',
);

const ajv = new Ajv2020({ strict: false });
addFormats(ajv);

const rawCache = new Map<SchemaName, Record<string, unknown>>();
export function loadSchema(name: SchemaName): Record<string, unknown> {
  let s = rawCache.get(name);
  if (!s) {
    s = JSON.parse(readFileSync(join(SCHEMAS_DIR, name), 'utf8')) as Record<string, unknown>;
    if (name === 'sensor-reading.schema.json') {
      const registry = JSON.parse(readFileSync(SENSOR_REGISTRY_PATH, 'utf8')) as {
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

let commonRegistered = false;
function ensureCommon(): void {
  if (!commonRegistered) {
    ajv.addSchema(loadSchema('common-defs.schema.json'), 'common-defs.schema.json');
    ajv.addSchema(loadSchema('record-meta.schema.json'), 'record-meta.schema.json');
    commonRegistered = true;
  }
}

function ensureSchemaReferences(name: SchemaName): void {
  if (name === 'action-result.schema.json' && ajv.getSchema('error.schema.json') === undefined) {
    ajv.addSchema(loadSchema('error.schema.json'), 'error.schema.json');
  }
}

const compiled = new Map<SchemaName, ReturnType<typeof ajv.compile>>();
export function getValidator(name: SchemaName) {
  let v = compiled.get(name);
  if (!v) {
    if (!(AVAILABLE_SCHEMA_NAMES as readonly string[]).includes(name))
      throw new Error(`unregistered schema: ${name}`);
    ensureCommon();
    ensureSchemaReferences(name);
    v =
      name === 'common-defs.schema.json' || name === 'record-meta.schema.json'
        ? (ajv.getSchema(name) ?? ajv.compile(loadSchema(name)))
        : ajv.compile(loadSchema(name));
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
