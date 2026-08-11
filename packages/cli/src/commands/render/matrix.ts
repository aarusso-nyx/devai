import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { join, resolve } from 'node:path';
import type { CAC } from 'cac';
import { EXIT_FAIL, EXIT_PASS, EXIT_USAGE } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';

const DEFAULT_REPO_ROOT = process.cwd();
const DEFAULT_INPUT_DIR = '.devai/state/test-results';
const DEFAULT_CONFIG_PATH = '.devai/config/test-matrix.json';
const DEFAULT_THRESHOLDS_PATH = '.devai/config/thresholds.json';
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

function loadConfig(repoRoot: string, explicit: string | undefined): MatrixConfig | undefined {
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

function loadThresholds(
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
type Status = 'pass' | 'fail' | 'error' | 'skipped' | 'flaky';

interface TestResult {
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

interface Options {
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

function readAllResults(dir: string): TestResult[] {
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

function parseFilter(raw: string | undefined): Filter {
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

function statusGlyph(status: Status | 'na'): string {
  switch (status) {
    case 'pass':
      return 'PASS';
    case 'fail':
      return 'FAIL';
    case 'error':
      return 'ERR';
    case 'skipped':
      return 'SKIP';
    case 'flaky':
      return 'FLAKY';
    case 'na':
      return 'N/A';
  }
}

/** Format a duration in milliseconds into a human-readable string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${((ms % 60_000) / 1000).toFixed(0)}s`;
}

interface Cell {
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

function buildMatrix(
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
interface StrictViolation {
  readonly scope: string;
  readonly tier: string;
  readonly reason: string;
}

interface StrictCheckOpts {
  readonly config: MatrixConfig | undefined;
  readonly thresholds: ThresholdsConfig | undefined;
  readonly results: readonly TestResult[];
}

function checkStrict(
  matrix: ReturnType<typeof buildMatrix>,
  opts: StrictCheckOpts,
): StrictViolation[] {
  const violations: StrictViolation[] = [];
  const { config, thresholds, results } = opts;

  // Build a lookup: scope → tier → latest result
  const byCell = new Map<string, TestResult>();
  for (const r of results) {
    const scope = r.scope ?? r.repo ?? '(unknown)';
    const key = `${scope}\x00${r.tier}`;
    const existing = byCell.get(key);
    if (existing === undefined || r.timestamp > existing.timestamp) {
      byCell.set(key, r);
    }
  }

  const maxAgeMs = (thresholds?.freshness?.default_max_age_hours ?? 168) * 60 * 60 * 1000;
  const now = Date.now();

  // The matrix only includes tiers that had results or na_overrides.
  // For strict mode, we must also check config-required tiers that are
  // entirely absent from the matrix (no result AND no na_override).
  const configTiers = config?.tiers;
  const naOverrides = config?.na_overrides ?? [];
  const allRequiredTiers =
    configTiers !== undefined && configTiers.length > 0 ? configTiers : matrix.tiers;

  for (const scope of matrix.scopes) {
    const row = matrix.grid.get(scope) as Map<string, Cell>;
    for (const tier of allRequiredTiers) {
      const cell = row.get(tier);

      // Tier is completely absent from the matrix for this scope.
      if (cell === undefined) {
        const naOverride = naOverrides.some((o) => o.scope === scope && o.tier === tier);
        if (!naOverride) {
          violations.push({ scope, tier, reason: 'missing: no test-result record found' });
        }
        continue;
      }

      // N/A cells are declared intentional — not a violation.
      if (cell.status === 'na') {
        const naOverride = naOverrides.some((o) => o.scope === scope && o.tier === tier);
        if (naOverride) continue;
        // na without an override: missing record.
        violations.push({ scope, tier, reason: 'missing: no test-result record found' });
        continue;
      }

      const result = byCell.get(`${scope}\x00${tier}`);
      if (result === undefined) {
        violations.push({ scope, tier, reason: 'missing: no test-result record found' });
        continue;
      }

      // Staleness check.
      const recordTime = new Date(result.timestamp).getTime();
      if (!isNaN(recordTime) && now - recordTime > maxAgeMs) {
        const ageH = ((now - recordTime) / 3_600_000).toFixed(1);
        const limitH = String(thresholds?.freshness?.default_max_age_hours ?? 168);
        violations.push({
          scope,
          tier,
          reason: `stale: record is ${ageH}h old (limit ${limitH}h)`,
        });
      }

      // Status check.
      if (result.status === 'fail' || result.status === 'error') {
        violations.push({ scope, tier, reason: `status: ${result.status}` });
      }

      // Threshold checks.
      if (thresholds !== undefined) {
        const m = result.metrics;
        if (tier === 'coverage' && m?.coverage_pct?.lines !== undefined) {
          const req = thresholds.coverage?.lines;
          if (req !== undefined && m.coverage_pct.lines < req) {
            violations.push({
              scope,
              tier,
              reason: `below threshold: coverage ${m.coverage_pct.lines.toFixed(1)}% < required ${req.toFixed(1)}%`,
            });
          }
        }
        if (tier === 'mutation' && typeof m?.mutation_score === 'number') {
          const req = thresholds.mutation?.score_min;
          if (req !== undefined && m.mutation_score < req) {
            violations.push({
              scope,
              tier,
              reason: `below threshold: mutation score ${m.mutation_score.toFixed(1)}% < required ${req.toFixed(1)}%`,
            });
          }
        }
      }
    }
  }

  return violations;
}

function renderMarkdown(m: ReturnType<typeof buildMatrix>): string {
  if (m.scopes.length === 0) {
    return '# Test matrix\n\n_No test-result records found._\n';
  }
  const lines: string[] = ['# Test matrix', ''];
  lines.push('| Scope | ' + m.tiers.join(' | ') + ' |');
  lines.push('|---' + '|---'.repeat(m.tiers.length) + '|');
  for (const scope of m.scopes) {
    const row = m.grid.get(scope) as Map<string, Cell>;
    const cells = m.tiers.map((t) => {
      const c = row.get(t) as Cell;
      const g = statusGlyph(c.status);
      return c.extra !== undefined ? `${g} ${c.extra}` : g;
    });
    lines.push(`| ${scope} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderHtml(m: ReturnType<typeof buildMatrix>): string {
  const cellClass = (s: Status | 'na'): string => `cell cell-${s}`;
  const head =
    '<!doctype html><meta charset="utf-8"><title>Test matrix</title><style>' +
    'body{font-family:sans-serif;margin:2rem;}' +
    'table{border-collapse:collapse;}' +
    'th,td{border:1px solid #ccc;padding:.4em .7em;text-align:left;}' +
    '.cell-pass{background:#dfd;}.cell-fail{background:#fdd;}' +
    '.cell-error{background:#fbb;}.cell-skipped,.cell-na{background:#eee;color:#777;}' +
    '.cell-flaky{background:#fed;}' +
    '</style>';
  if (m.scopes.length === 0) {
    return `${head}<h1>Test matrix</h1><p><em>No test-result records found.</em></p>`;
  }
  const headerRow = '<tr><th>Scope</th>' + m.tiers.map((t) => `<th>${t}</th>`).join('') + '</tr>';
  const bodyRows = m.scopes
    .map((scope) => {
      const row = m.grid.get(scope) as Map<string, Cell>;
      const cells = m.tiers
        .map((t) => {
          const c = row.get(t) as Cell;
          const label =
            c.extra !== undefined ? `${statusGlyph(c.status)} ${c.extra}` : statusGlyph(c.status);
          return `<td class="${cellClass(c.status)}">${label}</td>`;
        })
        .join('');
      return `<tr><th>${scope}</th>${cells}</tr>`;
    })
    .join('');
  return `${head}<h1>Test matrix</h1><table>${headerRow}${bodyRows}</table>`;
}

const RENDER_MATRIX_EXTENDED_DOC = `### Options

| Flag | Default | Description |
|---|---|---|
| \`--repo-root <path>\` | \`cwd\` | Repository root to resolve all relative paths against. |
| \`--in <dir>\` | \`.devai/state/test-results\` | Input directory of test-result JSON records. |
| \`--out <path>\` | stdout | Output path. Directories are created automatically. |
| \`--format md\\|html\` | \`md\` | Output format. |
| \`--filter <expr>\` | — | Comma-separated filter: e.g. \`tier=unit\\|e2e,status=pass\\|fail\`. |
| \`--config <path>\` | \`.devai/config/test-matrix.json\` if present | Test-matrix config (tiers, scopes_include, scopes_exclude, na_overrides). |
| \`--view timings\` | — | Named view preset: \`timings\` enables duration display (alias for \`--include-duration\`). |
| \`--include-duration\` | off | Show \`duration_ms\` from each record in human format (ms / s / m s). |
| \`--include-thresholds\` | off | Annotate coverage/mutation cells with threshold values from \`.devai/config/thresholds.json\`. |
| \`--thresholds-path <path>\` | \`.devai/config/thresholds.json\` | Override path to thresholds config (used with \`--include-thresholds\` or \`--strict\`). |
| \`--strict\` | off | Exit non-zero if any required tier/scope record is missing, stale, or below threshold. |
| \`--format human\` | off | Emit a human-readable banner when writing to \`--out\`. |

### Worked examples

#### 1. Default view (basic grid)

\`\`\`sh
devai evidence test matrix --repo-root . --format md
\`\`\`

Produces a plain Markdown grid using all observed scopes and tiers:

\`\`\`markdown
# Test matrix

| Scope | unit | e2e | coverage | mutation |
|---|---|---|---|---|
| teat-workspace | PASS 5/5 | PASS 3/3 | PASS 80.2% | PASS 92.0% |
\`\`\`

#### 2. Timings view

\`\`\`sh
devai evidence test matrix --repo-root . --view timings
\`\`\`

Appends human-readable duration to each cell (ms / s / m s):

\`\`\`markdown
# Test matrix

| Scope | unit | e2e | coverage |
|---|---|---|---|
| teat-workspace | PASS 350ms | PASS 2.5s | PASS 1m 12s |
\`\`\`

#### 3. Strict mode with threshold annotations

\`\`\`sh
devai evidence test matrix --repo-root . --include-thresholds --strict
\`\`\`

Annotates coverage and mutation cells with the configured threshold from \`.devai/config/thresholds.json\`, then exits non-zero if any required record is missing, stale, or below threshold. The matrix is always rendered to stdout before any strict-mode exit.

\`\`\`markdown
# Test matrix

| Scope | unit | coverage | mutation |
|---|---|---|---|
| teat-workspace | PASS 5/5 | PASS 80.2% / req 75.0% | PASS 92.0% / req 60.0% |
\`\`\`

Violations are written to stderr:

\`\`\`
devai evidence test matrix: strict mode — 1 violation(s):
  [pkg-internal/coverage] below threshold: coverage 50.0% < required 75.0%
\`\`\`
`;

export const renderMatrix = defineCommand({
  name: 'render matrix',
  description:
    'Render a (scope × tier) test-result matrix as Markdown or HTML. Reads test-result.schema.json-conformant records under .devai/state/test-results/. Example: `devai evidence test matrix --format md --out reports/matrix.md`.',
  authority: 'mesh_controller',
  extended_doc: RENDER_MATRIX_EXTENDED_DOC,
  register(cli: CAC): void {
    cli
      .command(
        'render-matrix',
        'Render a (scope × tier) test-result matrix from test-result records',
      )
      .option('--repo-root <path>', `Repo root (default: cwd)`)
      .option('--in <dir>', `Input dir of test-result records (default: ${DEFAULT_INPUT_DIR})`)
      .option('--out <path>', 'Output path (default: stdout)')
      .option('--format <fmt>', 'Output format: md|html (default: md)')
      .option(
        '--filter <expr>',
        'Filter expression, comma-separated. e.g. tier=unit|e2e,status=pass|fail',
      )
      .option(
        '--config <path>',
        `Optional test-matrix.config.json (per law/schemas/test-matrix.schema.json). Default: ${DEFAULT_CONFIG_PATH} if present, otherwise no config.`,
      )
      .option('--view <name>', 'Named view preset: timings (alias for --include-duration)')
      .option(
        '--include-duration',
        'Show duration_ms from each test-result record in human-readable format',
      )
      .option(
        '--include-thresholds',
        'Annotate coverage/mutation cells with configured thresholds from .devai/config/thresholds.json',
      )
      .option(
        '--thresholds-path <path>',
        `Path to thresholds config (default: ${DEFAULT_THRESHOLDS_PATH})`,
      )
      .option(
        '--strict',
        'Exit non-zero if any required tier/scope record is missing, stale, or below threshold',
      )
      .option('--human', 'Human-readable banner; otherwise emits the raw format')
      .action(async (options: Options) => {
        try {
          const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
          const inDir = resolve(repoRoot, options.in ?? DEFAULT_INPUT_DIR);
          const format = (options.format ?? 'md').toLowerCase();
          if (format !== 'md' && format !== 'html') {
            process.stderr.write(
              `devai evidence test matrix: --format must be md|html (got '${format}')\n`,
            );
            process.exit(EXIT_USAGE);
          }

          // Resolve view presets.
          const viewName = options.view?.toLowerCase();
          if (viewName !== undefined && viewName !== 'timings') {
            process.stderr.write(
              `devai evidence test matrix: --view must be 'timings' (got '${viewName}')\n`,
            );
            process.exit(EXIT_USAGE);
          }
          const showDuration = options.includeDuration === true || viewName === 'timings';
          const showThresholds = options.includeThresholds === true;

          const filter = parseFilter(options.filter);
          const config = loadConfig(repoRoot, options.config);
          const thresholds =
            showThresholds || options.strict === true
              ? loadThresholds(repoRoot, options.thresholdsPath)
              : undefined;

          const results = readAllResults(inDir);
          const matrix = buildMatrix(results, filter, config, {
            showDuration,
            showThresholds,
            thresholds,
          });
          const body = format === 'html' ? renderHtml(matrix) : renderMarkdown(matrix);

          if (options.out !== undefined) {
            const { dirname } = await import('node:path');
            mkdirSync(dirname(resolve(repoRoot, options.out)), { recursive: true });
            writeFileSync(resolve(repoRoot, options.out), body);
            if (options.human === true) {
              process.stdout.write(
                `devai evidence test matrix: wrote ${String(matrix.scopes.length)} scope(s) × ${String(matrix.tiers.length)} tier(s) → ${options.out}\n`,
              );
            }
          } else {
            process.stdout.write(body);
            if (!body.endsWith('\n')) process.stdout.write('\n');
          }

          // Strict-mode check — runs after rendering so the matrix is always emitted.
          if (options.strict === true) {
            const violations = checkStrict(matrix, { config, thresholds, results });
            if (violations.length > 0) {
              process.stderr.write(
                `devai evidence test matrix: strict mode — ${String(violations.length)} violation(s):\n`,
              );
              for (const v of violations) {
                process.stderr.write(`  [${v.scope}/${v.tier}] ${v.reason}\n`);
              }
              process.exitCode = EXIT_FAIL;
              return;
            }
          }

          process.exitCode = EXIT_PASS;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`devai evidence test matrix: ${msg}\n`);
          process.exit(EXIT_FAIL);
        }
      });
  },
});
