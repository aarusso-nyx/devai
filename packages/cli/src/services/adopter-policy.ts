import { getValidator } from '@devai-nyx/schemas';
import { canonicalJson } from '@devai-nyx/utils';
import { resolveCanonicalPolicyContent, validateCanonicalPolicyContent } from '@devai-nyx/skills';

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

/**
 * Deterministically resolves adopter policy into the five bound config files.
 * This function has no filesystem effects and is shared by init bind and Doctor.
 */
export function resolveAdopterPolicyMaterialization(
  input: {
    readonly policy: unknown;
    readonly currentProject: unknown;
    readonly frameworkVersion: string;
  },
  sources?: AdopterPolicyMaterializationSources,
): ReadonlyMap<(typeof ADOPTER_POLICY_TARGETS)[number], string> {
  const validator = sources === undefined ? getValidator : sources.getValidator;
  const readPolicy = sources === undefined ? resolveCanonicalPolicyContent : sources.readPolicy;
  const validatePolicy = validator('adopter-policy.schema.json');
  if (validatePolicy(input.policy) !== true) {
    throw new Error(`ADOPTER_POLICY_INVALID:${JSON.stringify(validatePolicy.errors)}`);
  }
  const document = input.policy as JsonObject;
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

  const projectOverrides = isJsonObject(document['project']) ? { ...document['project'] } : {};
  if (isJsonObject(document['ci_economy'])) projectOverrides['ci_economy'] = document['ci_economy'];
  const project = {
    ...(deepMerge(
      isJsonObject(input.currentProject) ? input.currentProject : {},
      projectOverrides,
    ) as JsonObject),
    devai_version: input.frameworkVersion,
  };
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
    const canonical = (readPolicy as (name: string) => string)(file);
    return canonicalJson(JSON.parse(canonical)) === canonicalJson(value)
      ? canonical
      : jsonBytes(value);
  };
  const resolved = new Map<(typeof ADOPTER_POLICY_TARGETS)[number], string>([
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
  return resolved;
}
