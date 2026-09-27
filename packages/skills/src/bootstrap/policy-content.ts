import { getValidator } from '@devai-nyx/schemas';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const POLICY_FILES = [
  'domains.json',
  'forbidden-actions.json',
  'glob-guards.json',
  'scorecard-na.json',
  'thresholds.json',
] as const;
export const ADOPTER_LAW_POLICY_FILES = ['mutation-strength.json'] as const;

const _CANONICAL_POLICY_FILES = [
  ...POLICY_FILES,
  'check-suites.json',
  ...ADOPTER_LAW_POLICY_FILES,
  'subprocess-effects.json',
] as const;

type BootstrapPolicyFile = (typeof POLICY_FILES)[number];
export type CanonicalPolicyFile = (typeof _CANONICAL_POLICY_FILES)[number];

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validStringRoster(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.length > 0) &&
    new Set(value).size === value.length
  );
}

function validFiniteRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function validatesDomains(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (value['schemaVersion'] !== '1.0.0') return false;
  if (!validStringRoster(value['core']) || !validStringRoster(value['framework'])) return false;
  if (!validStringRoster(value['client'])) return false;
  return (value['core'] as unknown[]).length > 0 && (value['framework'] as unknown[]).length > 0;
}

function validatesThresholds(value: unknown): boolean {
  if (!isPlainRecord(value) || value['schemaVersion'] !== '1.0.0') return false;
  const coverage = value['coverage'];
  const mutation = value['mutation'];
  const lint = value['lint'];
  const typecheck = value['typecheck'];
  const freshness = value['freshness'];
  return (
    isPlainRecord(coverage) &&
    ['lines', 'branches', 'functions', 'statements'].every((key) =>
      validFiniteRange(coverage[key], 0, 100),
    ) &&
    isPlainRecord(mutation) &&
    validFiniteRange(mutation['score_min'], 0, 100) &&
    validFiniteRange(mutation['survived_max'], 0, Number.MAX_SAFE_INTEGER) &&
    isPlainRecord(lint) &&
    validFiniteRange(lint['max_errors'], 0, Number.MAX_SAFE_INTEGER) &&
    validFiniteRange(lint['max_warnings'], 0, Number.MAX_SAFE_INTEGER) &&
    isPlainRecord(typecheck) &&
    validFiniteRange(typecheck['max_errors'], 0, Number.MAX_SAFE_INTEGER) &&
    isPlainRecord(freshness) &&
    validFiniteRange(freshness['default_max_age_hours'], 1, 8760) &&
    validFiniteRange(freshness['scorecard_failure_max_age_hours'], 1, 8760)
  );
}

const REGISTERED_POLICY_SCHEMAS: Partial<
  Record<BootstrapPolicyFile, Parameters<typeof getValidator>[0]>
> = {
  'forbidden-actions.json': 'forbidden-actions.schema.json',
  'glob-guards.json': 'glob-guards.schema.json',
  'scorecard-na.json': 'scorecard-na-config.schema.json',
};

export function validateCanonicalPolicyContent(
  file: BootstrapPolicyFile,
  bytes: string,
  resolveValidator: typeof getValidator = getValidator,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch (error) {
    throw new Error(
      `canonical policy ${file} failed schema validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const schemaName = REGISTERED_POLICY_SCHEMAS[file];
  if (schemaName !== undefined) {
    const validate = resolveValidator(schemaName);
    if (validate(parsed) !== true) {
      const detail = (validate.errors ?? [])
        .map((error) => `${error.instancePath || '/'} ${error.message ?? ''}`)
        .join('; ');
      throw new Error(`canonical policy ${file} failed schema validation: ${detail}`);
    }
    return bytes;
  }
  const valid =
    file === 'domains.json'
      ? validatesDomains(parsed)
      : file === 'thresholds.json'
        ? validatesThresholds(parsed)
        : false;
  if (!valid) {
    throw new Error(`canonical policy ${file} failed schema validation`);
  }
  return bytes;
}

export function resolveCanonicalPolicyContent(file: CanonicalPolicyFile): string {
  const candidates = [
    join(PACKAGE_ROOT, 'law/policy/adopter-defaults', file),
    join(PACKAGE_ROOT, 'law/policy', file),
    join(PACKAGE_ROOT, 'dist/law/policy', file),
    join(PACKAGE_ROOT, '../../law/policy/adopter-defaults', file),
    join(PACKAGE_ROOT, '../../law/policy', file),
  ];
  const source = candidates.find((candidate) => existsSync(candidate));
  if (source === undefined) {
    throw new Error(`canonical policy source unavailable: law/policy/${file}`);
  }
  const bytes = readFileSync(source, 'utf8');
  if ((POLICY_FILES as readonly string[]).includes(file)) {
    return validateCanonicalPolicyContent(file as BootstrapPolicyFile, bytes);
  }
  JSON.parse(bytes);
  return bytes;
}
