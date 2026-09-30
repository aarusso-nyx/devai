import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getValidator } from '@devai-nyx/schemas';
import { canonicalJson } from '@devai-nyx/utils';
import {
  parseConstitutionVersion,
  resolveCanonicalPolicyContent,
  validateCanonicalPolicyContent,
} from '@devai-nyx/skills';
import { projectOwnedProjectConfig } from './adopter-policy-ownership.js';
import {
  type AdopterAuthorityBlock,
  type AdopterAuthorityExtension,
  compileAdopterAuthorityExtension,
  loadAdopterAuthorityDefaultTestSelectors,
} from '../authority/policy-adopter-extension.js';

export {
  ADOPTER_POLICY_OWNERSHIP_MATRIX,
  RETIRABLE_OWNED_POINTERS,
  type AdopterPolicyOwnershipRow,
} from './adopter-policy-ownership.js';

export type JsonObject = Record<string, unknown>;

export interface AdopterPolicyMaterializationSources {
  readonly getValidator: typeof getValidator;
  readonly readPolicy: (
    file:
      | 'domains.json'
      | 'thresholds.json'
      | 'scorecard-na.json'
      | 'glob-guards.json'
      | 'release-verification.json',
  ) => string;
}

export const ADOPTER_POLICY_TARGETS = [
  '.devai/config/project.json',
  '.devai/config/domains.json',
  '.devai/config/thresholds.json',
  '.devai/config/scorecard-na.json',
  '.devai/config/glob-guards.json',
  '.devai/config/release-verification.json',
] as const;

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isJsonObject(base) || !isJsonObject(override)) return override;
  const result: JsonObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in result ? deepMerge(result[key], value) : value;
  }
  return result;
}

export function jsonBytes(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export type AdopterPolicyTarget = (typeof ADOPTER_POLICY_TARGETS)[number];

export interface AdopterPolicyProjectionInput {
  readonly policy: unknown;
  readonly currentProject: unknown;
  readonly frameworkVersion: string;
  /**
   * The bound constitution version that gates an `authority` block (ADR-AUT-0003). When
   * absent, it is read from `.devai/pin/constitution.md` under `targetRoot`.
   */
  readonly constitutionVersion?: string;
  /** Repository root whose bound constitution pin gates an `authority` block. */
  readonly targetRoot?: string;
}

const CONSTITUTION_PIN = '.devai/pin/constitution.md';

function boundConstitutionVersion(targetRoot: string): string {
  const pin = join(targetRoot, CONSTITUTION_PIN);
  const version = existsSync(pin) ? parseConstitutionVersion(readFileSync(pin, 'utf8')) : null;
  if (version === null) {
    throw new Error(
      `ADOPTER_AUTHORITY_CONSTITUTION_VERSION:no bound constitution version at ${pin}`,
    );
  }
  return version;
}

/**
 * Compile the source's `authority` block, when declared, against the bound constitution of
 * `targetRoot` and the package default test selectors of the defaults law source. Returns
 * undefined for a source without the block; a refused block throws its ADOPTER_AUTHORITY_*
 * code. The rules carry the given repository id; their count, id, and version do not depend
 * on it, and the trusted authority sources compile the digest-bearing document themselves.
 */
export function compileAdopterPolicyAuthority(
  input: AdopterPolicyProjectionInput,
  options: {
    readonly repositoryId: string;
    readonly validator?: typeof getValidator;
  },
): AdopterAuthorityExtension | undefined {
  if (!isJsonObject(input.policy) || input.policy['authority'] === undefined) return undefined;
  const document = input.policy;
  return compileAdopterAuthorityExtension({
    policyId: String(document['policy_id']),
    policyVersion: String(document['policy_version']),
    authority: document['authority'] as AdopterAuthorityBlock,
    constitutionVersion:
      input.constitutionVersion ?? boundConstitutionVersion(resolve(input.targetRoot ?? '.')),
    defaultTestSelectors: loadAdopterAuthorityDefaultTestSelectors(options.validator),
    repositoryId: options.repositoryId,
  });
}

/**
 * Deterministically resolves adopter policy into the five bound config files.
 * This function writes nothing and is shared by init bind and Doctor; it reads only the
 * bound constitution pin, and only when an `authority` block omits the input version.
 */
export function resolveAdopterPolicyMaterialization(
  input: AdopterPolicyProjectionInput,
  sources?: AdopterPolicyMaterializationSources,
): ReadonlyMap<AdopterPolicyTarget, string> {
  return resolveAdopterPolicyProjection(input, sources).files;
}

/**
 * Resolves the bound files together with the owned project.json rows the projection
 * retires (ADR-CFG-0002), reported as JSON pointers at the ownership-matrix rows.
 */
export function resolveAdopterPolicyProjection(
  input: AdopterPolicyProjectionInput,
  sources?: AdopterPolicyMaterializationSources,
): {
  readonly files: ReadonlyMap<AdopterPolicyTarget, string>;
  readonly retired_keys: readonly string[];
} {
  const validator = sources === undefined ? getValidator : sources.getValidator;
  const readPolicy = sources === undefined ? resolveCanonicalPolicyContent : sources.readPolicy;
  const validatePolicy = validator('adopter-policy.schema.json');
  if (validatePolicy(input.policy) !== true) {
    throw new Error(`ADOPTER_POLICY_INVALID:${JSON.stringify(validatePolicy.errors)}`);
  }
  const document = input.policy as JsonObject;
  // A refused authority block raises its ADOPTER_AUTHORITY_* code before any target is
  // staged. The selectors' repository id is irrelevant to the refusal, so no identity
  // lookup (which may spawn git) is made here.
  compileAdopterPolicyAuthority(input, { repositoryId: 'adopter-repository', validator });
  const defaults = (
    file: 'domains.json' | 'thresholds.json' | 'scorecard-na.json' | 'glob-guards.json',
  ) => JSON.parse(validateCanonicalPolicyContent(file, readPolicy(file), validator)) as JsonObject;
  const domainDefaults = defaults('domains.json');
  const domainConfig = isJsonObject(document['domains']) ? document['domains'] : {};
  const requestedDomains = Array.isArray(domainConfig['client'])
    ? domainConfig['client'].map(String)
    : [];
  const immutableDomains = [
    ...(domainDefaults['core'] as string[]),
    ...(domainDefaults['framework'] as string[]),
  ];
  const collision = requestedDomains.find((domain) => immutableDomains.includes(domain));
  if (collision !== undefined) throw new Error(`ADOPTER_POLICY_DOMAIN_COLLISION:${collision}`);

  const domains = {
    ...domainDefaults,
    client: [...new Set([...(domainDefaults['client'] as string[]), ...requestedDomains])].sort(),
  };
  const thresholds = deepMerge(
    defaults('thresholds.json'),
    document['thresholds'] ?? {},
  ) as JsonObject;
  const scorecardNa = document['scorecard_na'] ?? defaults('scorecard-na.json');
  const globGuards = document['glob_guards'] ?? defaults('glob-guards.json');
  const releaseVerification = document['release_verification'];
  validateCanonicalPolicyContent('domains.json', jsonBytes(domains), validator);
  validateCanonicalPolicyContent('thresholds.json', jsonBytes(thresholds), validator);
  validateCanonicalPolicyContent('scorecard-na.json', jsonBytes(scorecardNa), validator);
  validateCanonicalPolicyContent('glob-guards.json', jsonBytes(globGuards), validator);

  // Owned rows are replaced as a whole or retired; every other key is an adopter
  // declaration and survives unchanged (ADR-CFG-0002).
  const { project, retired_keys: retiredKeys } = projectOwnedProjectConfig({
    policy: document,
    currentProject: isJsonObject(input.currentProject) ? input.currentProject : {},
    frameworkVersion: input.frameworkVersion,
  });
  const validateProject = validator('project-config.schema.json');
  if (validateProject(project) !== true) {
    throw new Error(`ADOPTER_POLICY_PROJECT_INVALID:${JSON.stringify(validateProject.errors)}`);
  }

  // A binding that does not override a policy must not rewrite its bytes. Re-serializing
  // an unchanged document would fork the adopter copy from the installed canonical source
  // and break byte-identity with the operational-law materialization of the same file.
  const unchanged = (
    file:
      | 'domains.json'
      | 'thresholds.json'
      | 'scorecard-na.json'
      | 'glob-guards.json'
      | 'release-verification.json',
    value: unknown,
  ): string => {
    // An installation that does not carry this canonical source cannot preserve its
    // bytes; re-serializing is then the only deterministic result.
    let canonical: string;
    try {
      canonical = (readPolicy as (name: string) => string)(file);
    } catch {
      return jsonBytes(value);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(canonical);
    } catch {
      return jsonBytes(value);
    }
    return canonicalJson(parsed) === canonicalJson(value) ? canonical : jsonBytes(value);
  };
  const resolved = new Map<AdopterPolicyTarget, string>([
    ['.devai/config/project.json', jsonBytes(project)],
    ['.devai/config/domains.json', unchanged('domains.json', domains)],
    ['.devai/config/thresholds.json', unchanged('thresholds.json', thresholds)],
    ['.devai/config/scorecard-na.json', unchanged('scorecard-na.json', scorecardNa)],
    ['.devai/config/glob-guards.json', unchanged('glob-guards.json', globGuards)],
  ]);
  if (releaseVerification !== undefined) {
    resolved.set(
      '.devai/config/release-verification.json',
      unchanged('release-verification.json', releaseVerification),
    );
  }
  return { files: resolved, retired_keys: retiredKeys };
}
