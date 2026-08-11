import { readFileSync } from 'node:fs';

export interface DomainsFile {
  readonly schemaVersion?: string;
  readonly core?: readonly string[];
  readonly framework?: readonly string[];
  readonly client?: readonly string[];
}

export interface DomainTaxonomy {
  /** Union of core + framework + client. */
  readonly all: ReadonlySet<string>;
  readonly core: readonly string[];
  readonly framework: readonly string[];
  readonly client: readonly string[];
}

/**
 * Load `.devai/config/domains.json` and merge the three categories
 * (core, framework, client) into a single allowed-domain taxonomy.
 *
 * Validates structure: each category, if present, must be an array of
 * strings matching `^[A-Z][A-Z0-9]{1,15}$` (the invariant-domain pattern
 * per invariant.schema.json).
 */
export function loadDomains(path: string): DomainTaxonomy {
  const text = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`domains: failed to parse ${path}: ${msg}`);
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`domains: ${path} is not a JSON object`);
  }
  const file = parsed as DomainsFile;
  const core = validateCategory('core', file.core);
  const framework = validateCategory('framework', file.framework);
  const client = validateCategory('client', file.client);
  const all = new Set<string>([...core, ...framework, ...client]);
  return { all, core, framework, client };
}

const DOMAIN_PATTERN = /^[A-Z][A-Z0-9]{1,15}$/;

function validateCategory(name: string, value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`domains: '${name}' must be an array of strings`);
  }
  for (const v of value as unknown[]) {
    if (typeof v !== 'string') {
      throw new Error(`domains: '${name}' contains a non-string entry`);
    }
    if (!DOMAIN_PATTERN.test(v)) {
      throw new Error(
        `domains: '${name}' entry '${v}' does not match pattern ${DOMAIN_PATTERN.source}`,
      );
    }
  }
  return value as readonly string[];
}

export function isDomainAllowed(taxonomy: DomainTaxonomy, code: string): boolean {
  return taxonomy.all.has(code);
}
