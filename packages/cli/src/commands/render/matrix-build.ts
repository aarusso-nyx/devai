import { existsSync, readFileSync, readdirSync, statSync } from '@devai-nyx/authority';
import { join, resolve } from 'node:path';

export const DEFAULT_CONFIG_PATH = '.devai/config/test-matrix.json';
export const DEFAULT_THRESHOLDS_PATH = '.devai/config/thresholds.json';
const DEFAULT_TIER_ORDER = [
  'unit',
  'api',
  'db',
  'e2e',
  'mutation',
  'perf',
  'lint',
  'typecheck',
  'coverage',
] as const;

interface MatrixConfig {
  readonly schemaVersion?: string;
  readonly tiers?: readonly string[];
  readonly scopes_include?: readonly string[];
  readonly scopes_exclude?: readonly string[];
  readonly na_overrides?: readonly {
    readonly scope: string;
    readonly tier: string;
    readonly reason?: string;
  }[];
  readonly thresholds_ref?: string;
}

interface ThresholdsConfig {
  readonly schemaVersion?: string;
  readonly coverage?: {
    readonly lines?: number;
    readonly branches?: number;
    readonly functions?: number;
    readonly statements?: number;
  };
  readonly mutation?: {
    readonly score_min?: number;
    readonly survived_max?: number;
  };
  readonly lint?: {
    readonly max_errors?: number;
    readonly max_warnings?: number;
  };
  readonly typecheck?: {
    readonly max_errors?: number;
  };
  readonly freshness?: {
    readonly default_max_age_hours?: number;
    readonly per_sensor?: Record<string, number>;
  };
}

export function loadConfig(
  repoRoot: string,
  explicit: string | undefined,
): MatrixConfig | undefined {
  const path =
    explicit !== undefined ? resolve(repoRoot, explicit) : resolve(repoRoot, DEFAULT_CONFIG_PATH);
  if (!existsSync(path)) {
    // Explicit path that doesn't exist is an error; default path missing is just "no config".
    if (explicit !== undefined) {
      throw new Error(`config not found: ${path}`);
    }
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `config parse error at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`config at ${path} must be a JSON object`);
  }
  return raw as MatrixConfig;
}

export function loadThresholds(
  repoRoot: string,
  explicit: string | undefined,
): ThresholdsConfig | undefined {
  const path =
    explicit !== undefined
      ? resolve(repoRoot, explicit)
      : resolve(repoRoot, DEFAULT_THRESHOLDS_PATH);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    return raw as ThresholdsConfig;
  } catch {
    return undefined;
  }
}

/**
 * Shell-glob match for a single scope vs a single pattern. Supports `*`
 * (matches anything except `/`) and `**` (matches anything including
 * `/`). Anchored at both ends.
 */
function matchesGlob(scope: string, pattern: string): boolean {
  const re = pattern
    .split('')
    .map((c, i, arr) => {
      if (c === '*' && arr[i + 1] === '*') return '';
      if (c === '*' && arr[i - 1] === '*') return '.*';
      if (c === '*') return '[^/]*';
      if (/[.+?^${}()|[\]\\]/.test(c)) return `\\${c}`;
      return c;
    })
    .join('');
  return new RegExp(`^${re}$`).test(scope);
}

type Tier = (typeof DEFAULT_TIER_ORDER)[number];
export type Status = 'pass' | 'fail' | 'error' | 'skipped' | 'flaky';

export interface TestResult {
  readonly id: string;
  readonly repo?: string;
  readonly scope?: string;
  readonly tier: Tier;
  readonly status: Status;
  readonly timestamp: string;
  readonly metrics?: {
    readonly passed?: number;
    readonly failed?: number;
    readonly skipped?: number;
    readonly duration_ms?: number;
    readonly coverage_pct?: { readonly lines?: number };
    readonly mutation_score?: number;
  };
}

export interface Options {
  readonly repoRoot?: string;
  readonly in?: string;
  readonly out?: string;
  readonly format?: string;
  readonly filter?: string;
  readonly human?: boolean;
  readonly config?: string;
  readonly view?: string;
  readonly includeDuration?: boolean;
  readonly includeThresholds?: boolean;
  readonly thresholdsPath?: string;
  readonly strict?: boolean;
}

export function readAllResults(dir: string): TestResult[] {
  const out: TestResult[] = [];
  if (!existsSync(dir)) return out;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(cur, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile() && full.endsWith('.json')) {
        try {
          const parsed = JSON.parse(readFileSync(full, 'utf8')) as TestResult;
          // Accept only well-shaped records; silently skip the rest.
          // The matrix is a reporter; canonical checks own validation.
          // is the validating gate.
          if (
            typeof parsed.id === 'string' &&
            typeof parsed.tier === 'string' &&
            typeof parsed.status === 'string' &&
            typeof parsed.timestamp === 'string'
          ) {
            out.push(parsed);
          }
        } catch {
          // Ignore unparseable files; ditto.
        }
      }
    }
  }
  return out;
}

interface Filter {
  readonly tiers?: ReadonlySet<string>;
  readonly statuses?: ReadonlySet<string>;
}

export function parseFilter(raw: string | undefined): Filter {
  if (raw === undefined) return {};
  const out: { tiers?: Set<string>; statuses?: Set<string> } = {};
  for (const piece of raw.split(',')) {
    const eq = piece.indexOf('=');
    if (eq === -1) continue;
    const key = piece.slice(0, eq).trim();
    const vals = piece
      .slice(eq + 1)
      .split('|')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (vals.length === 0) continue;
    if (key === 'tier') out.tiers = new Set(vals);
    else if (key === 'status') out.statuses = new Set(vals);
  }
  return out;
}

/** Format a duration in milliseconds into a human-readable string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${((ms % 60_000) / 1000).toFixed(0)}s`;
}

export interface Cell {
  readonly status: Status | 'na';
  readonly extra?: string;
}

function pickLatest(results: readonly TestResult[]): TestResult | undefined {
  if (results.length === 0) return undefined;
  let best = results[0] as TestResult;
  for (const r of results.slice(1)) {
    if (r.timestamp > best.timestamp) best = r;
  }
  return best;
}

interface BuildOptions {
  readonly showDuration?: boolean;
  readonly showThresholds?: boolean;
  readonly thresholds?: ThresholdsConfig;
}

export function buildMatrix(
  results: readonly TestResult[],
  filter: Filter,
  config: MatrixConfig | undefined,
  opts: BuildOptions = {},
): { tiers: readonly string[]; scopes: readonly string[]; grid: Map<string, Map<string, Cell>> } {
  const filtered = results.filter(
    (r) =>
      (filter.tiers === undefined || filter.tiers.has(r.tier)) &&
      (filter.statuses === undefined || filter.statuses.has(r.status)),
  );

  const tierSet = new Set<string>();
  const scopeSet = new Set<string>();
  const byCell = new Map<string, TestResult[]>();
  for (const r of filtered) {
    tierSet.add(r.tier);
    const scope = r.scope ?? r.repo ?? '(unknown)';
    scopeSet.add(scope);
    const key = `${scope}\x00${r.tier}`;
    const bucket = byCell.get(key);
    if (bucket === undefined) byCell.set(key, [r]);
    else bucket.push(r);
  }

  // Apply config.tiers (allow-list + ordering) — falls back to observed-set
  // in canonical order when no config or no tiers field.
  const configTiers = config?.tiers;
  let tiers: readonly string[];
  if (configTiers !== undefined && configTiers.length > 0) {
    tiers = configTiers.filter(
      (t) => tierSet.has(t) || (config?.na_overrides ?? []).some((o) => o.tier === t),
    );
  } else {
    tiers = DEFAULT_TIER_ORDER.filter((t) => tierSet.has(t));
  }

  // Apply config.scopes_include + scopes_exclude (glob).
  const includes = config?.scopes_include;
  const excludes = config?.scopes_exclude ?? [];
  let scopes = [...scopeSet];
  if (includes !== undefined && includes.length > 0) {
    scopes = scopes.filter((s) => includes.some((p) => matchesGlob(s, p)));
  }
  if (excludes.length > 0) {
    scopes = scopes.filter((s) => !excludes.some((p) => matchesGlob(s, p)));
  }
  // Add scopes that appear only in na_overrides (so an N/A cell can be
  // declared for a scope that never produced any test-result).
  const naOverridesByScope = new Map<string, Set<string>>();
  for (const o of config?.na_overrides ?? []) {
    const cur = naOverridesByScope.get(o.scope) ?? new Set<string>();
    cur.add(o.tier);
    naOverridesByScope.set(o.scope, cur);
    if (!scopeSet.has(o.scope)) {
      // Only add if not explicitly excluded.
      if (excludes.length === 0 || !excludes.some((p) => matchesGlob(o.scope, p))) {
        scopes.push(o.scope);
      }
    }
  }
  scopes = [...new Set(scopes)].sort();

  const { showDuration, showThresholds, thresholds } = opts;

  const grid = new Map<string, Map<string, Cell>>();
  for (const scope of scopes) {
    const row = new Map<string, Cell>();
    const naForScope = naOverridesByScope.get(scope) ?? new Set<string>();
    for (const tier of tiers) {
      if (naForScope.has(tier)) {
        row.set(tier, { status: 'na' });
        continue;
      }
      const bucket = byCell.get(`${scope}\x00${tier}`) ?? [];
      const latest = pickLatest(bucket);
      if (latest === undefined) {
        row.set(tier, { status: 'na' });
      } else {
        const m = latest.metrics;
        const extraParts: string[] = [];

        if (showDuration && m?.duration_ms !== undefined) {
          extraParts.push(formatDuration(m.duration_ms));
        }

        if (showThresholds && thresholds !== undefined) {
          if (tier === 'coverage' && m?.coverage_pct?.lines !== undefined) {
            const actual = m.coverage_pct.lines;
            const req = thresholds.coverage?.lines;
            if (req !== undefined) {
              extraParts.push(`${actual.toFixed(1)}% / req ${req.toFixed(1)}%`);
            } else {
              extraParts.push(`${actual.toFixed(1)}%`);
            }
          } else if (tier === 'mutation' && typeof m?.mutation_score === 'number') {
            const actual = m.mutation_score;
            const req = thresholds.mutation?.score_min;
            if (req !== undefined) {
              extraParts.push(`${actual.toFixed(1)}% / req ${req.toFixed(1)}%`);
            } else {
              extraParts.push(`${actual.toFixed(1)}%`);
            }
          } else if (m?.passed !== undefined && m?.failed !== undefined) {
            extraParts.push(`${String(m.passed)}/${String((m.passed ?? 0) + (m.failed ?? 0))}`);
          }
        } else {
          // Default: existing extra logic (no duration/threshold flags).
          if (tier === 'coverage' && m?.coverage_pct?.lines !== undefined) {
            extraParts.push(`${m.coverage_pct.lines.toFixed(1)}%`);
          } else if (tier === 'mutation' && typeof m?.mutation_score === 'number') {
            extraParts.push(`${m.mutation_score.toFixed(1)}%`);
          } else if (m?.passed !== undefined && m?.failed !== undefined) {
            extraParts.push(`${String(m.passed)}/${String((m.passed ?? 0) + (m.failed ?? 0))}`);
          }
        }

        const extra = extraParts.length > 0 ? extraParts.join(', ') : undefined;
        row.set(tier, { status: latest.status, ...(extra !== undefined && { extra }) });
      }
    }
    grid.set(scope, row);
  }
  return { tiers, scopes, grid };
}

/** Strict-mode violation record. */
export interface StrictViolation {
  readonly scope: string;
  readonly tier: string;
  readonly reason: string;
}

export interface StrictCheckOpts {
  readonly config: MatrixConfig | undefined;
  readonly thresholds: ThresholdsConfig | undefined;
  readonly results: readonly TestResult[];
}
