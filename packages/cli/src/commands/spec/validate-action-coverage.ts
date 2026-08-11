import { existsSync, readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { loadDomains, validateInvariants } from '#runtime-core';
import { getActionsList, type ActionAuthority } from '../../define-command.js';
import { ACTION_REGISTRY } from '../../generated/action-registry.js';
import { maybeResolvePackParams } from '../sense/shared.js';

// ---------------------------------------------------------------------------
// Shared action-coverage check.
// ---------------------------------------------------------------------------

export interface ActionCoverageCheckOptions {
  readonly repoRoot: string;
  readonly invariantsDir: string;
  readonly domains: ReturnType<typeof loadDomains>;
  readonly scope?: string;
  readonly coverageAuthorities?: string;
  readonly adopterRoot?: string;
  readonly packTune?: boolean;
  readonly packId?: string;
  readonly packsRoot?: string;
}

export interface ActionCoverageCheckResult {
  readonly ok: boolean;
  readonly scope: 'self' | 'adopter';
  readonly unclaimed: string[];
  readonly orphanClaims: string[];
  readonly registeredCount: number;
  readonly inScopeCount: number;
  readonly claimedCount: number;
  readonly adopterFacingAuthorities?: string[];
}

function projectCanonicalClaims(
  sourceClaims: ReadonlySet<string>,
  _includeCompleteCatalog: boolean,
): Readonly<{ readonly claimed: ReadonlySet<string>; readonly orphanClaims: readonly string[] }> {
  const byActionId = new Map<string, (typeof ACTION_REGISTRY)[number]>(
    ACTION_REGISTRY.map((entry) => [entry.action_id, entry] as const),
  );
  const claimed = new Set<string>();
  const orphanClaims: string[] = [];

  for (const sourceClaim of sourceClaims) {
    const entry = byActionId.get(sourceClaim);
    if (entry === undefined) {
      orphanClaims.push(sourceClaim);
      continue;
    }
    claimed.add(entry.action_id);
  }

  return Object.freeze({ claimed, orphanClaims: Object.freeze(orphanClaims) });
}

/** Scope-aware action-coverage gate used by the canonical `check` facade. */
export function runActionCoverageCheck(
  opts: ActionCoverageCheckOptions,
): ActionCoverageCheckResult {
  const result = validateInvariants({
    invariantsDir: opts.invariantsDir,
    domains: opts.domains,
    repoRoot: opts.repoRoot,
  });
  const sourceClaims = new Set<string>();
  for (const inv of result.invariants) {
    let parsed: { measurable_via?: readonly string[] };
    try {
      parsed = JSON.parse(readFileSync(inv.file, 'utf8')) as {
        measurable_via?: readonly string[];
      };
    } catch {
      continue;
    }
    const mv = parsed.measurable_via;
    if (mv === undefined) continue;
    for (const action of mv) sourceClaims.add(action);
  }

  const registry = getActionsList();

  const explicitScope = opts.scope;
  let scope: 'self' | 'adopter';
  if (explicitScope === 'self' || explicitScope === 'adopter') {
    scope = explicitScope;
  } else {
    scope = detectSelfPosture(opts.repoRoot) ? 'self' : 'adopter';
  }

  const projection = projectCanonicalClaims(sourceClaims, scope === 'self');
  const claimed = projection.claimed;

  const adopterRoot = opts.adopterRoot ?? opts.repoRoot;
  const packParams =
    scope === 'adopter'
      ? maybeResolvePackParams('action_coverage', adopterRoot, {
          ...(opts.packTune !== undefined && { packTune: opts.packTune }),
          ...(opts.packId !== undefined && { packId: opts.packId }),
          ...(opts.packsRoot !== undefined && { packsRoot: opts.packsRoot }),
        })
      : {};
  const adopterFacingAuthorities = resolveAdopterFacingAuthorities(
    opts.coverageAuthorities,
    packParams,
  );

  let inScopeActions: ReadonlySet<string>;
  if (scope === 'adopter') {
    inScopeActions = discoverAdopterActions(opts.repoRoot, claimed, adopterFacingAuthorities);
  } else {
    inScopeActions = new Set(registry.map((a) => a.name));
  }

  const unclaimed: string[] = [];
  for (const action of registry) {
    if (claimed.has(action.name)) continue;
    if (DELIBERATELY_UNCOVERED.has(action.name)) continue;
    if (!inScopeActions.has(action.name)) continue;
    unclaimed.push(action.name);
  }
  return {
    ok: unclaimed.length === 0,
    scope,
    unclaimed,
    orphanClaims: [...projection.orphanClaims],
    registeredCount: registry.length,
    inScopeCount: inScopeActions.size,
    claimedCount: claimed.size,
    ...(scope === 'adopter' && {
      adopterFacingAuthorities: Array.from(adopterFacingAuthorities).sort(),
    }),
  };
}

/**
 * D-A-36 — adopter-facing authorities for the action-coverage check.
 * Adopter invariants are expected to claim sensor + specifier actions
 * (sense-*, spec-*, inv-*, etc.) that observe their product. The five
 * framework-internal authorities (mesh_controller, release_controller,
 * policy_firewall, agent_runtime, host_tooling) are DEVAI infrastructure
 * — adopters have no business claiming them.
 *
 * Substring matches against framework-internal authorities are dropped
 * from the adopter-scope `inScopeActions` set. Adopters who explicitly
 * claim a framework-internal action via `measurable_via` are NOT
 * filtered (their explicit declaration overrides the default).
 *
 * Override via `--coverage-authorities <comma-list>` CLI flag or pack-tune
 * `extractor_params.action_coverage.authorities`.
 */
const DEFAULT_ADOPTER_FACING_AUTHORITIES: ReadonlySet<ActionAuthority> = new Set<ActionAuthority>([
  'sensor',
  'specifier',
]);

const ALL_AUTHORITIES: ReadonlySet<string> = new Set<string>([
  'mesh_controller',
  'specifier',
  'constructor',
  'sensor',
  'policy_firewall',
  'release_controller',
  'agent_runtime',
  'host_tooling',
]);

function safeStat(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/**
 * Detect whether the repository carries framework sources
 * or an adopter. Source-repository detection uses the presence of
 * the canonical workspace markers (packages/cli/src/bin.ts +
 * examples/redox-pack-* directories).
 */
function detectSelfPosture(repoRoot: string): boolean {
  const binPath = join(repoRoot, 'packages/cli/src/bin.ts');
  if (!existsSync(binPath)) return false;
  // Look for any examples/redox-pack-* dir.
  let entries: string[];
  try {
    entries = readdirSync(join(repoRoot, 'examples'));
  } catch {
    return false;
  }
  return entries.some((e) => e.startsWith('redox-pack-'));
}

function walkSink(dir: string, sink: string[]): void {
  const st = safeStat(dir);
  if (st === null) return;
  if (st.isFile()) {
    sink.push(dir);
    return;
  }
  if (!st.isDirectory()) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git' || e === 'dist' || e === 'build') continue;
    walkSink(join(dir, e), sink);
  }
}

/**
 * Adopter-scope referenced-action discovery: the set of
 * actions an adopter actually uses, computed as:
 * 1. Substring matches in CI workflow run: scripts (.github/workflows/*.yml{,.yaml})
 * 2. Substring matches in scripts/**.{sh,mjs,js,cjs}
 * 3. The union of every invariant's measurable_via[] (adopters with
 *    one invariant get a one-action minimum).
 *
 * An action name normalizes via " " → "-" so "sense rbac" matches
 * "devai sense inventory rbac".
 */
function discoverAdopterActions(
  repoRoot: string,
  claimedFromInvariants: ReadonlySet<string>,
  adopterFacingAuthorities: ReadonlySet<ActionAuthority>,
): Set<string> {
  const referenced = new Set<string>();
  const allActions = getActionsList();
  // D-A-36: build a substring-eligible subset filtered by authority.
  // Adopter-claimed actions (via measurable_via) always count regardless
  // of authority — explicit declaration overrides the default filter.
  const substringEligible = allActions.filter(
    (a) => a.authority === undefined || adopterFacingAuthorities.has(a.authority),
  );
  const normalisedNames: Array<{ name: string; tokens: readonly string[] }> = substringEligible.map(
    (a) => ({
      name: a.name,
      tokens: [a.name, a.name.replace(/\s+/g, '-')],
    }),
  );

  // Walk workflow files for run: bodies (and any other reference).
  const corpus: string[] = [];
  const workflowDir = join(repoRoot, '.github/workflows');
  if (safeStat(workflowDir) !== null) {
    let entries: string[];
    try {
      entries = readdirSync(workflowDir);
    } catch {
      entries = [];
    }
    for (const e of entries) {
      if (!(e.endsWith('.yml') || e.endsWith('.yaml'))) continue;
      try {
        corpus.push(readFileSync(join(workflowDir, e), 'utf8'));
      } catch {
        /* skip */
      }
    }
  }

  // Walk scripts/**/* for shell/node references.
  const scriptsDir = join(repoRoot, 'scripts');
  const scriptFiles: string[] = [];
  walkSink(scriptsDir, scriptFiles);
  for (const f of scriptFiles) {
    if (!/\.(sh|mjs|js|cjs)$/.test(f)) continue;
    try {
      corpus.push(readFileSync(f, 'utf8'));
    } catch {
      /* skip */
    }
  }
  const joined = corpus.join('\n').toLowerCase();

  for (const { name, tokens } of normalisedNames) {
    if (tokens.some((t) => joined.includes(t.toLowerCase()))) referenced.add(name);
  }
  // Explicit invariant claims always count — adopters who DO declare
  // framework-internal actions in measurable_via opt-in to those checks.
  for (const claim of claimedFromInvariants) referenced.add(claim);
  return referenced;
}

/**
 * Parse adopter-facing authorities from input or pack tuning.
 * Returns the configured set or `DEFAULT_ADOPTER_FACING_AUTHORITIES` when
 * unset. Invalid authority strings are logged to stderr but don't fail
 * the check (graceful degradation).
 */
function resolveAdopterFacingAuthorities(
  cliFlag: string | undefined,
  packParams: Readonly<Record<string, unknown>>,
): ReadonlySet<ActionAuthority> {
  const raw =
    cliFlag !== undefined
      ? cliFlag
      : typeof packParams['authorities'] === 'string'
        ? (packParams['authorities'] as string)
        : Array.isArray(packParams['authorities'])
          ? (packParams['authorities'] as unknown[])
              .filter((v): v is string => typeof v === 'string')
              .join(',')
          : undefined;
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_ADOPTER_FACING_AUTHORITIES;
  }
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out = new Set<ActionAuthority>();
  for (const p of parts) {
    if (ALL_AUTHORITIES.has(p)) {
      out.add(p as ActionAuthority);
    } else {
      process.stderr.write(
        `check action-coverage: ignoring unknown authority '${p}' in --coverage-authorities\n`,
      );
    }
  }
  return out.size > 0 ? out : DEFAULT_ADOPTER_FACING_AUTHORITIES;
}

/** Explicitly justified temporary exclusions. Empty in the release candidate. */
const DELIBERATELY_UNCOVERED: ReadonlySet<string> = new Set([
  // (empty for now; populate with rationale comments when adding entries)
]);
