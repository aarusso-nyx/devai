import { mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { getValidator } from '@devai-nyx/schemas';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConstitutionBindingPlan } from '../constitution/index.js';

export interface BootstrapPlanEntry {
  readonly path: string;
  readonly action: 'create' | 'overwrite' | 'skip-exists';
  /** File content (newly created) or null when action is skip-exists. */
  readonly content: string | null;
  readonly bytes: number;
}

export interface BootstrapPlan {
  readonly target_root: string;
  readonly devai_version: string;
  readonly entries: BootstrapPlanEntry[];
  readonly summary: {
    readonly create: number;
    readonly overwrite: number;
    readonly skip: number;
  };
}

const DEFAULT_VERSION = '0.0.0';
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const POLICY_FILES = [
  'domains.json',
  'forbidden-actions.json',
  'glob-guards.json',
  'scorecard-na.json',
  'thresholds.json',
] as const;

type BootstrapPolicyFile = (typeof POLICY_FILES)[number];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
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

export function validateCanonicalPolicyContent(file: BootstrapPolicyFile, bytes: string): string {
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
    const validate = getValidator(schemaName);
    if (!validate(parsed)) {
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

function canonicalPolicyContent(file: (typeof POLICY_FILES)[number]): string {
  const candidates = [
    join(PACKAGE_ROOT, 'law/policy', file),
    join(PACKAGE_ROOT, 'dist/law/policy', file),
    join(PACKAGE_ROOT, '../../law/policy', file),
  ];
  const source = candidates.find((candidate) => existsSync(candidate));
  if (source === undefined) {
    throw new Error(`canonical policy source unavailable: law/policy/${file}`);
  }
  const bytes = readFileSync(source, 'utf8');
  return validateCanonicalPolicyContent(file, bytes);
}

/**
 * Compute a bootstrap plan for an adopter target:
 *
 *   .devai/constitution.md (pointer to the vendored constitution)
 *   .devai/pin/constitution.md (canonical vendored constitution)
 *   record/proofs/chain.json (empty genesis)
 *   .devai/{pin,config,state}/
 *   law/, product/, work/, record/, and scratch/ according to profile
 *
 * Existing files are flagged 'skip-exists' (deny-by-default). The caller
 * can apply with `executeBootstrapPlan(plan, { force })` to overwrite.
 */
export function buildBootstrapPlan(opts: {
  readonly targetRoot: string;
  readonly version?: string;
  /** Adoption profile written into project.json when provided. */
  readonly profile?: 'tier1' | 'tier2' | 'tier3';
}): BootstrapPlan {
  const version = opts.version ?? DEFAULT_VERSION;
  const entries: BootstrapPlanEntry[] = [];
  const counters = JSON.stringify({ TASK: 0, RGR: 0, CTG: 0, ESC: 0 }, null, 2) + '\n';
  const policyContent = Object.fromEntries(
    POLICY_FILES.map((file) => [file, canonicalPolicyContent(file)]),
  ) as Record<(typeof POLICY_FILES)[number], string>;
  const emptyChain = JSON.stringify({ head: null, records: [] }, null, 2) + '\n';
  const canonicalGitignore = 'scratch/\n';

  // Plan constitution binding first so its resolved pin can be included in
  // project.json. Every target is an adopter, including a target that already
  // has law/constitution.md.
  const constitutionBinding = buildConstitutionBindingPlan(opts.targetRoot, version);

  // The deterministic seed omits timestamps so repeated plans produce
  // byte-identical project.json output.
  const projectConfig =
    JSON.stringify(
      {
        schemaVersion: '1.0.0',
        project_type: 'runtime-host',
        // Bootstrap starts in the posture DEVAI can guarantee without a
        // verified host adapter.
        authority_enforcement: { mode: 'cli-only' },
        // An omitted profile uses the schema default.
        ...(opts.profile !== undefined && { profile: opts.profile }),
        constitution: constitutionBinding.pin,
        devai_version: version,
      },
      null,
      2,
    ) + '\n';

  interface PlanItem {
    readonly path: string;
    readonly content: string;
  }

  const plan: PlanItem[] = [
    { path: '.gitignore', content: canonicalGitignore },
    { path: 'record/proofs/chain.json', content: emptyChain },
    { path: '.devai/state/counters.json', content: counters },
    ...POLICY_FILES.map((file) => ({
      path: `.devai/config/${file}`,
      content: policyContent[file],
    })),
    { path: '.devai/config/project.json', content: projectConfig },
    constitutionBinding.pointerFile,
    constitutionBinding.rootFile,
  ];

  const profile = opts.profile ?? 'tier3';
  const f1Dirs: ReadonlyArray<readonly [string, string]> = [
    ['record/proofs', 'machine only'],
    ['record/derived/inventory', 'regeneration subsystem only'],
    ['scratch/worktrees', 'ephemeral'],
    ...(profile === 'tier1'
      ? []
      : [
          ['law', 'Architect'] as const,
          ['law/adr', 'Architect'] as const,
          ['law/invariants', 'Architect'] as const,
          ['law/policy', 'Architect'] as const,
          ['law/glossary', 'Owner and Architect, jointly'] as const,
          ['product', 'Owner'] as const,
        ]),
    ...(profile === 'tier3'
      ? [['work/rounds', 'Architect'] as const, ['work/audit', 'Auditor'] as const]
      : []),
  ];
  for (const [dir, authority] of f1Dirs) {
    plan.push({
      path: `${dir}/README.md`,
      content: `# ${dir.split('/').pop() ?? ''}\n\n**Authority:** ${authority} (Constitution Article 6).\n\nContent is intentionally empty until authored. Generated by DEVAI v${version}.\n`,
    });
  }

  let create = 0;
  let skip = 0;
  for (const item of plan) {
    const abs = join(opts.targetRoot, item.path);
    const exists = existsSync(abs);
    if (exists) {
      // Carry the fresh content so `executeBootstrapPlan(plan, { force: true })`
      // has something to write. Without this, `--force` would silently be a
      // no-op for existing files (the previous bug).
      entries.push({
        path: item.path,
        action: 'skip-exists',
        content: item.content,
        bytes: Buffer.byteLength(item.content, 'utf8'),
      });
      skip++;
    } else {
      entries.push({
        path: item.path,
        action: 'create',
        content: item.content,
        bytes: Buffer.byteLength(item.content, 'utf8'),
      });
      create++;
    }
  }
  return {
    target_root: opts.targetRoot,
    devai_version: version,
    entries,
    summary: { create, overwrite: 0, skip },
  };
}

export interface ExecuteOptions {
  readonly force?: boolean;
}

export interface ExecuteResult {
  readonly created: readonly string[];
  readonly overwritten: readonly string[];
  readonly skipped: readonly string[];
  /**
   * Paths that were preserved despite `--force`. The bootstrap plan
   * refuses to overwrite the evidence chain or counters once they
   * contain real data (chain.records.length > 0 or counter > 0), per
   * Constitution Article 32. `--force` is for re-laying template files
   * onto a fresh repo, not for resetting provenance.
   */
  readonly preserved: readonly string[];
}

/**
 * Paths that must never be overwritten with template content once they
 * contain real data. These hold the framework's own provenance and ID
 * counters; clobbering them silently destroys the hash chain and breaks
 * `devai evidence verify --scope chain`.
 */
const PRESERVE_WHEN_POPULATED: ReadonlySet<string> = new Set([
  'record/proofs/chain.json',
  '.devai/state/counters.json',
]);

function mergeGitignore(current: string, canonical: string): string {
  const lines = new Set(current.split(/\r?\n/u));
  const missing = canonical.split('\n').filter((line) => line.length > 0 && !lines.has(line));
  if (missing.length === 0) return current;
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  return `${current}${separator}${missing.join('\n')}\n`;
}

function isPopulated(absPath: string): boolean {
  if (!existsSync(absPath)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absPath, 'utf8'));
  } catch {
    // If we can't parse it, treat as populated — don't overwrite
    // something we don't understand.
    return true;
  }
  if (parsed === null || typeof parsed !== 'object') return false;
  const obj = parsed as Record<string, unknown>;
  // Evidence chain: any records means populated.
  if (Array.isArray(obj.records) && obj.records.length > 0) return true;
  // Counters: any value > 0 means populated.
  for (const value of Object.values(obj)) {
    if (typeof value === 'number' && value > 0) return true;
  }
  return false;
}

export function executeBootstrapPlan(
  plan: BootstrapPlan,
  opts: ExecuteOptions = {},
): ExecuteResult {
  const created: string[] = [];
  const overwritten: string[] = [];
  const skipped: string[] = [];
  const preserved: string[] = [];

  for (const entry of plan.entries) {
    const abs = join(plan.target_root, entry.path);
    const dir = dirname(abs);
    if (entry.action === 'skip-exists') {
      if (opts.force === true && entry.content !== null) {
        // Provenance-critical files (Article 32): refuse to overwrite
        // when they already contain real data. This closes the
        // `init --execute --force` foot-gun that would otherwise
        // silently delete the evidence chain.
        if (PRESERVE_WHEN_POPULATED.has(entry.path) && isPopulated(abs)) {
          preserved.push(entry.path);
          continue;
        }
        mkdirSync(dir, { recursive: true });
        const next =
          entry.path === '.gitignore'
            ? mergeGitignore(readFileSync(abs, 'utf8'), entry.content)
            : entry.content;
        if (entry.path === '.gitignore' && next === readFileSync(abs, 'utf8')) {
          skipped.push(entry.path);
        } else {
          writeFileSync(abs, next);
          overwritten.push(entry.path);
        }
      } else {
        skipped.push(entry.path);
      }
      continue;
    }
    if (entry.content === null) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(abs, entry.content);
    created.push(entry.path);
  }

  return {
    created: created.sort(),
    overwritten: overwritten.sort(),
    skipped: skipped.sort(),
    preserved: preserved.sort(),
  };
}

// Keep the introspector available through the package bootstrap surface.
export * from './introspect.js';
