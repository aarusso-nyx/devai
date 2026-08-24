import { getValidator } from '@devai-nyx/schemas';
import { resolveCanonicalPolicyContent, validateCanonicalPolicyContent } from '@devai-nyx/skills';

export type JsonObject = Record<string, unknown>;

export const ADOPTER_POLICY_TARGETS = [
  '.devai/config/project.json',
  '.devai/config/domains.json',
  '.devai/config/thresholds.json',
  '.devai/config/scorecard-na.json',
  '.devai/config/glob-guards.json',
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
export function resolveAdopterPolicyMaterialization(input: {
  readonly policy: unknown;
  readonly currentProject: unknown;
  readonly frameworkVersion: string;
}): ReadonlyMap<(typeof ADOPTER_POLICY_TARGETS)[number], string> {
  const validatePolicy = getValidator('adopter-policy.schema.json');
  if (!validatePolicy(input.policy)) {
    throw new Error(`ADOPTER_POLICY_INVALID:${JSON.stringify(validatePolicy.errors)}`);
  }
  const document = input.policy as JsonObject;
  const defaults = (
    file: 'domains.json' | 'thresholds.json' | 'scorecard-na.json' | 'glob-guards.json',
  ) => JSON.parse(resolveCanonicalPolicyContent(file)) as JsonObject;
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
  validateCanonicalPolicyContent('domains.json', jsonBytes(domains));
  validateCanonicalPolicyContent('thresholds.json', jsonBytes(thresholds));
  validateCanonicalPolicyContent('scorecard-na.json', jsonBytes(scorecardNa));
  validateCanonicalPolicyContent('glob-guards.json', jsonBytes(globGuards));

  const projectOverrides = isJsonObject(document['project']) ? { ...document['project'] } : {};
  if (isJsonObject(document['ci_economy'])) projectOverrides['ci_economy'] = document['ci_economy'];
  const project = {
    ...(deepMerge(
      isJsonObject(input.currentProject) ? input.currentProject : {},
      projectOverrides,
    ) as JsonObject),
    devai_version: input.frameworkVersion,
  };
  const validateProject = getValidator('project-config.schema.json');
  if (!validateProject(project)) {
    throw new Error(`ADOPTER_POLICY_PROJECT_INVALID:${JSON.stringify(validateProject.errors)}`);
  }

  return new Map([
    ['.devai/config/project.json', jsonBytes(project)],
    ['.devai/config/domains.json', jsonBytes(domains)],
    ['.devai/config/thresholds.json', jsonBytes(thresholds)],
    ['.devai/config/scorecard-na.json', jsonBytes(scorecardNa)],
    ['.devai/config/glob-guards.json', jsonBytes(globGuards)],
  ]);
}
