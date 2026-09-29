import { mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isAdoptionProfile, type AdoptionProfile } from '@devai-nyx/utils';
import { buildConstitutionBindingPlan } from '../constitution/index.js';
import {
  ADOPTER_LAW_POLICY_FILES,
  POLICY_FILES,
  isPlainRecord,
  resolveCanonicalPolicyContent,
} from './policy-content.js';
export { resolveCanonicalPolicyContent, validateCanonicalPolicyContent } from './policy-content.js';
export type { CanonicalPolicyFile } from './policy-content.js';

export interface BootstrapPlanEntry {
  readonly path: string;
  /**
   * `create` for an absent path, `replace` for an existing file that
   * `executeBootstrapPlan(plan, { force: true })` would overwrite, `skip-exists`
   * for an existing file the execution keeps (byte-identical, protected
   * guidance, or populated provenance), and `overwrite` for the always-applied
   * project.json reconciliation (ADR-GOV-0020).
   */
  readonly action: 'create' | 'overwrite' | 'replace' | 'skip-exists';
  /** Template content the entry would write. */
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
    /**
     * Existing files `--force` would overwrite (ADR-GOV-0020). Every built plan
     * carries it; it is optional only so a hand-built plan from before the
     * replace action still type-checks.
     */
    readonly replace?: number;
    readonly skip: number;
  };
}

const DEFAULT_VERSION = '0.0.0';

/** The whole of an adopter CLAUDE.md: the import of AGENTS.md (ADR-GOV-0020). */
const CLAUDE_IMPORT = '@AGENTS.md\n';

export const MATERIALIZED_POLICY_FILES = [...POLICY_FILES, 'subprocess-effects.json'] as const;

export interface ProjectConfigReconciliationOptions {
  readonly version: string;
  readonly profile?: AdoptionProfile;
  readonly constitution?: object;
}

/**
 * Reconcile framework-managed project metadata without discarding adopter-owned
 * declarations. An absent profile is materialized as the schema's strict tier3
 * default so the effective adoption decision is always explicit on disk.
 *
 * The rows of the adopter-policy ownership matrix (ADR-CFG-0002, exported by the CLI
 * as ADOPTER_POLICY_OWNERSHIP_MATRIX and stated in docs/adopters/install.md) belong
 * to `init bind --adopter-policy`: /repo, /docs, /docs/ia, /ci_economy and its nested
 * rows are carried through unchanged, never invented and never retired here, and
 * /project_type is only defaulted when the schema would otherwise refuse the file.
 * /devai_version is stamped exactly as every bind stamps it.
 */
export function reconcileProjectConfig(
  current: unknown,
  options: ProjectConfigReconciliationOptions,
): Record<string, unknown> {
  if (!isPlainRecord(current)) {
    throw new Error('PROJECT_CONFIG_INVALID: expected a JSON object');
  }
  const {
    schemaVersion,
    project_type: projectType,
    authority_enforcement: authorityEnforcement,
    profile: currentProfile,
    constitution: currentConstitution,
    devai_version: _currentVersion,
    ...adopterDeclarations
  } = current;
  const profile = options.profile ?? (isAdoptionProfile(currentProfile) ? currentProfile : 'tier3');
  const constitution = options.constitution ?? currentConstitution;

  return {
    schemaVersion: schemaVersion ?? '1.0.0',
    project_type: projectType ?? 'runtime-host',
    authority_enforcement: authorityEnforcement ?? { mode: 'cli-only' },
    profile,
    ...(constitution !== undefined && { constitution }),
    devai_version: options.version,
    ...adopterDeclarations,
  };
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
 * An existing file is planned `replace` when `executeBootstrapPlan(plan,
 * { force: true })` would overwrite it and `skip-exists` when the execution
 * keeps it, so the plan and the execution report agree before the first byte
 * is written (ADR-GOV-0020). Without `force` nothing existing is written.
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
    POLICY_FILES.map((file) => [file, resolveCanonicalPolicyContent(file)]),
  ) as Record<(typeof POLICY_FILES)[number], string>;
  const adopterLawPolicyContent = Object.fromEntries(
    ADOPTER_LAW_POLICY_FILES.map((file) => [file, resolveCanonicalPolicyContent(file)]),
  ) as Record<(typeof ADOPTER_LAW_POLICY_FILES)[number], string>;
  const emptyChain = JSON.stringify({ head: null, records: [] }, null, 2) + '\n';
  const canonicalGitignore = 'scratch/\n';

  // Plan constitution binding first so its resolved pin can be included in
  // project.json. Every target is an adopter, including a target that already
  // has law/constitution.md.
  const constitutionBinding = buildConstitutionBindingPlan(opts.targetRoot, version);

  const projectConfigPath = join(opts.targetRoot, '.devai/config/project.json');
  const existingProjectConfig = existsSync(projectConfigPath)
    ? (JSON.parse(readFileSync(projectConfigPath, 'utf8')) as unknown)
    : {};
  // The deterministic reconciliation omits timestamps, preserves adopter
  // declarations, and records the effective profile explicitly.
  const reconciledProjectConfig = reconcileProjectConfig(existingProjectConfig, {
    version,
    ...(opts.profile !== undefined && { profile: opts.profile }),
    constitution: constitutionBinding.pin,
  });
  const projectConfig = JSON.stringify(reconciledProjectConfig, null, 2) + '\n';

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
    ...ADOPTER_LAW_POLICY_FILES.map((file) => ({
      path: `law/policy/${file}`,
      content: adopterLawPolicyContent[file],
    })),
    { path: '.devai/config/project.json', content: projectConfig },
    constitutionBinding.pointerFile,
    constitutionBinding.rootFile,
  ];

  const profile = opts.profile ?? 'tier3';
  const agentInstructions = `# Agent instructions

Follow Constitution Article 6 role separation: Owner, Architect, Inspector,
Engineer, and Auditor. Read README.md, law/constitution.md, law/adr, and
law/schemas before changing governed repository state.
`;
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
      ? [
          ['law/schemas', 'Architect'] as const,
          ['docs/dev/operations', 'Architect'] as const,
          ['docs/dev/security', 'Architect'] as const,
          ['work/rounds', 'Architect'] as const,
          ['work/audit', 'Auditor'] as const,
        ]
      : []),
  ];
  for (const [dir, authority] of f1Dirs) {
    plan.push({
      path: `${dir}/README.md`,
      content: `# ${dir.split('/').pop() ?? ''}\n\n**Authority:** ${authority} (Constitution Article 6).\n\nContent is intentionally empty until authored. Generated by DEVAI v${version}.\n`,
    });
  }
  if (profile === 'tier3') {
    plan.push(
      { path: 'AGENTS.md', content: agentInstructions },
      // ADR-GOV-0020: CLAUDE.md is the import of the single contract, never a copy.
      { path: 'CLAUDE.md', content: CLAUDE_IMPORT },
    );
  }

  let create = 0;
  let overwrite = 0;
  let replace = 0;
  let skip = 0;
  for (const item of plan) {
    const abs = join(opts.targetRoot, item.path);
    const bytes = Buffer.byteLength(item.content, 'utf8');
    if (!existsSync(abs)) {
      entries.push({ path: item.path, action: 'create', content: item.content, bytes });
      create++;
      continue;
    }
    if (
      item.path === '.devai/config/project.json' &&
      !isDeepStrictEqual(existingProjectConfig, reconciledProjectConfig)
    ) {
      entries.push({ path: item.path, action: 'overwrite', content: item.content, bytes });
      overwrite++;
      continue;
    }
    // Carry the template content either way: the execution rechecks the file
    // at write time, because a reviewed plan may outlive an adopter write.
    if (forcedDisposition(abs, item.path, item.content) === 'write') {
      entries.push({ path: item.path, action: 'replace', content: item.content, bytes });
      replace++;
    } else {
      entries.push({ path: item.path, action: 'skip-exists', content: item.content, bytes });
      skip++;
    }
  }
  return {
    target_root: opts.targetRoot,
    devai_version: version,
    entries,
    summary: { create, overwrite, replace, skip },
  };
}

export interface ExecuteOptions {
  readonly force?: boolean;
}

export function preflightBootstrapPlan(plan: BootstrapPlan): readonly string[] {
  const root = resolve(plan.target_root);
  return plan.entries.map((entry) => {
    const target = resolve(root, entry.path);
    if (target === root || !target.startsWith(`${root}${sep}`)) {
      throw new Error(`BOOTSTRAP_PATH_ESCAPE:${entry.path}`);
    }
    let cursor = root;
    for (const segment of entry.path.split('/').slice(0, -1)) {
      cursor = join(cursor, segment);
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
        throw new Error(`BOOTSTRAP_SYMLINK_REFUSED:${entry.path}`);
      }
    }
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      throw new Error(`BOOTSTRAP_SYMLINK_REFUSED:${entry.path}`);
    }
    return target;
  });
}

export interface ExecuteResult {
  readonly created: readonly string[];
  readonly overwritten: readonly string[];
  readonly skipped: readonly string[];
  /**
   * Paths that were preserved despite `--force`. The bootstrap plan
   * refuses to overwrite the evidence chain or counters once they
   * contain real data (chain.records.length > 0 or counter > 0), per
   * Constitution Article 32, and refuses to overwrite adopter guidance
   * (AGENTS.md, CLAUDE.md, and every README.md under law/) once it differs
   * from the template, per ADR-GOV-0020. `--force` is for re-laying template
   * files onto a fresh repo, not for resetting provenance or guidance.
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

/** Adopter guidance that `--force` never overwrites once it differs from the template. */
function isGuidancePath(relativePath: string): boolean {
  return (
    relativePath === 'AGENTS.md' ||
    relativePath === 'CLAUDE.md' ||
    (relativePath.startsWith('law/') && relativePath.endsWith('/README.md'))
  );
}

/**
 * What `--force` does to an existing file: keep it byte-identical (`identical`),
 * keep it because it is populated provenance or edited guidance (`preserve`), or
 * overwrite it (`write`). The plan and the execution share this one rule.
 */
function forcedDisposition(
  absPath: string,
  relativePath: string,
  template: string,
): 'identical' | 'preserve' | 'write' {
  const current = readFileSync(absPath, 'utf8');
  const next = relativePath === '.gitignore' ? mergeGitignore(current, template) : template;
  if (next === current) return 'identical';
  if (PRESERVE_WHEN_POPULATED.has(relativePath) && isPopulated(absPath, relativePath)) {
    return 'preserve';
  }
  if (isGuidancePath(relativePath)) return 'preserve';
  return 'write';
}

function mergeGitignore(current: string, canonical: string): string {
  const lines = new Set(current.split(/\r?\n/u));
  const missing = canonical.split('\n').filter((line) => line.length > 0 && !lines.has(line));
  if (missing.length === 0) return current;
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  return `${current}${separator}${missing.join('\n')}\n`;
}

function isPopulated(absPath: string, relativePath: string): boolean {
  if (!existsSync(absPath)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absPath, 'utf8'));
  } catch {
    // If we can't parse it, treat as populated — don't overwrite
    // something we don't understand.
    return true;
  }
  // Only recognized empty bootstrap state may be replaced. Parseable damaged or
  // extended records still contain recovery data and are not evidence of emptiness.
  if (!isPlainRecord(parsed)) return true;
  if (relativePath === 'record/proofs/chain.json') {
    return !(
      Object.keys(parsed).length === 2 &&
      parsed.head === null &&
      Array.isArray(parsed.records) &&
      parsed.records.length === 0
    );
  }
  return Object.entries(parsed).some(
    ([key, value]) => !['TASK', 'RGR', 'CTG', 'ESC'].includes(key) || value !== 0,
  );
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
    // A reviewed plan may outlive an adopter write. Reconcile every path that
    // exists at write time through the same force, guidance, and provenance
    // rules the plan applied, whatever the plan said about it.
    if (entry.action !== 'overwrite' && existsSync(abs)) {
      if (opts.force !== true || entry.content === null) {
        skipped.push(entry.path);
        continue;
      }
      const disposition = forcedDisposition(abs, entry.path, entry.content);
      if (disposition === 'identical') {
        skipped.push(entry.path);
      } else if (disposition === 'preserve') {
        preserved.push(entry.path);
      } else {
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          abs,
          entry.path === '.gitignore'
            ? mergeGitignore(readFileSync(abs, 'utf8'), entry.content)
            : entry.content,
        );
        overwritten.push(entry.path);
      }
      continue;
    }
    // A file that existed at planning and vanished before execution is laid
    // again only under --force; without it nothing the plan saw is touched.
    if ((entry.action === 'replace' || entry.action === 'skip-exists') && opts.force !== true) {
      skipped.push(entry.path);
      continue;
    }
    if (entry.content === null) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(abs, entry.content);
    if (entry.action === 'overwrite') overwritten.push(entry.path);
    else created.push(entry.path);
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
