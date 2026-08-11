import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { AnySchema, ValidateFunction } from 'ajv';
import type { CAC } from 'cac';
import { EXIT_CONFIG, EXIT_FAIL, EXIT_PASS, EXIT_USAGE } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';
import { isActionOutputExit } from '../../action-output.js';

/**
 * Runtime behind `devai evidence record --kind mutation --run`.
 *
 * Produces `.devai/state/mutation/current.json`. Loads mutation
 * scenarios (one JSON file per scenario) validated against
 * `law/schemas/mutation-scenario.schema.json`. For each scenario, the
 * runner either:
 *
 *   - merges a pre-computed per-scenario MutantReport from
 *     `--external <path-or-dir>` (adopters whose external producer —
 *     Stryker, Pitest, etc. — already runs the mutation but want DEVAI
 *     to consume their per-scenario verdicts); OR
 *   - invokes the configured `--mutator <module>` ESM adapter, whose
 *     default export is `(scenario, ctx) => Promise<MutantReport>`; OR
 *   - reports the scenario as `Survived` (no runner configured) —
 *     useful for dry-run and config validation.
 *
 * Emits `.devai/state/mutation/current.json` in the canonical mutation-report shape:
 *
 *     {
 *       "schemaVersion": "1.0.0",
 *       "mutation_score": <0..100>,
 *       "survived": <int>,
 *       "report_path": "<optional rich-report path>",
 *       // Stryker-compat fields:
 *       "metrics": { "mutationScore": ..., "survived": ..., ... },
 *       "scenarios": [ { id, status, duration_ms?, error? }, ... ]
 *     }
 *
 * Aggregate fields drive threshold checks; `metrics` and `scenarios` retain
 * detailed results for evidence review.
 *
 * Not included in this deterministic runner:
 *   - AST mutators.
 *   - Multi-file atomic mutations executed by the built-in runner.
 *   - Parallel scenario execution.
 *
 * The built-in `string-replace` / `regex-replace` runner — that mutates
 * source files in place and invokes a configured `test_command` — is
 * intentionally not included. DEVAI owns the scenario contract and canonical
 * report shape; the mutate-and-test loop is supplied through the adopter's
 * explicit `--mutator` adapter.
 */

const MUTATION_ACTION = 'devai evidence record --kind mutation';

// ============================================================================
// Public types — exported for adopter mutator adapters and tests.
// ============================================================================

const SCHEMA_REL = 'law/schemas/mutation-scenario.schema.json';

const DEFAULT_OUT = '.devai/state/mutation/current.json';

export type MutationStatus = 'Killed' | 'Survived' | 'Timeout' | 'RuntimeError';

export interface MutationScenarioMutation {
  readonly type: 'string-replace' | 'regex-replace';
  readonly find?: string;
  readonly pattern?: string;
  readonly flags?: string;
  readonly replace: string;
  readonly mutator_name?: string;
}

export interface MutationScenarioExpectation {
  readonly assertion: 'tests-detect' | 'tests-tolerate';
  readonly specs: readonly string[];
  readonly threshold?: { readonly status?: MutationStatus };
}

export interface MutationScenario {
  readonly schema_version: string;
  readonly id: string;
  readonly kind: 'mutation';
  readonly target: {
    readonly file: string;
    readonly symbol?: string;
    readonly invariant_ref?: string;
  };
  readonly mutations: readonly MutationScenarioMutation[];
  readonly expectations: readonly MutationScenarioExpectation[];
  readonly domain_tags?: readonly string[];
  readonly rationale?: string;
  readonly timeout_ms?: number;
  readonly __source_file?: string; // attached at load time; not in schema
}

export interface MutantReport {
  readonly id: string;
  readonly status: MutationStatus;
  readonly duration_ms?: number;
  readonly error?: string;
}

export interface MutatorAdapterContext {
  readonly repoRoot: string;
}

export type MutatorAdapter = (
  scenario: MutationScenario,
  ctx: MutatorAdapterContext,
) => Promise<MutantReport> | MutantReport;

// ============================================================================
// Loader: scenarios + schema.
// ============================================================================

function findRepoRoot(start: string): string {
  let dir = start;
  // Walk up looking for the schema file. Fall back to start.
  while (true) {
    if (existsSync(join(dir, SCHEMA_REL))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

let cachedValidator: ValidateFunction | undefined;
function getScenarioValidator(repoRoot: string): ValidateFunction {
  if (cachedValidator !== undefined) return cachedValidator;
  const schemaPath = join(repoRoot, SCHEMA_REL);
  if (!existsSync(schemaPath)) {
    // Walk up: tests may resolve repo-root at the consumer's cwd; the
    // framework root (where the schema lives) may be a parent.
    const upRoot = findRepoRoot(repoRoot);
    const upPath = join(upRoot, SCHEMA_REL);
    if (!existsSync(upPath)) {
      throw new Error(`mutation-scenario schema not found at ${schemaPath} (also tried ${upPath})`);
    }
    const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: false });
    addFormats(ajv);
    cachedValidator = ajv.compile(JSON.parse(readFileSync(upPath, 'utf8')) as AnySchema);
    return cachedValidator;
  }
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: false });
  addFormats(ajv);
  cachedValidator = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')) as AnySchema);
  return cachedValidator;
}

/**
 * Test seam: reset the cached schema validator. Without this, multiple
 * integration tests in the same process can reuse a stale validator that
 * was compiled against a different repo's schema file.
 */
export function _resetScenarioValidator(): void {
  cachedValidator = undefined;
}

/**
 * Expand a scenarios argument to a list of JSON file paths.
 * Supports:
 *   - a single JSON file path
 *   - a directory (recursively collects `*.json` not ending in `.schema.json`)
 *   - a simple `<dir>/**\/*.json` pattern (the `**` segment is normalized
 *     to recursive)
 *
 * Returns absolute paths, sorted for deterministic ordering.
 */
function expandScenarioPaths(scenariosArg: string, repoRoot: string): string[] {
  const abs = isAbsolute(scenariosArg) ? scenariosArg : resolve(repoRoot, scenariosArg);

  // Glob form: <dir>/**/*.json or <dir>/*.json
  const globIdx = abs.indexOf('*');
  if (globIdx >= 0) {
    const root = abs.slice(0, globIdx).replace(/\/+$/, '');
    if (!existsSync(root)) {
      throw new Error(`scenarios path does not exist: ${root}`);
    }
    return walkJsonFiles(root);
  }

  if (!existsSync(abs)) {
    throw new Error(`scenarios path does not exist: ${abs}`);
  }
  const st = statSync(abs);
  if (st.isFile()) return [abs];
  if (st.isDirectory()) return walkJsonFiles(abs);
  throw new Error(`scenarios path is neither file nor directory: ${abs}`);
}

function walkJsonFiles(dir: string): string[] {
  const out: string[] = [];
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
      } else if (st.isFile() && full.endsWith('.json') && !full.endsWith('.schema.json')) {
        out.push(full);
      }
    }
  }
  out.sort();
  return out;
}

export interface LoadedScenario {
  readonly scenario: MutationScenario;
  readonly file: string;
}

export interface LoadResult {
  readonly scenarios: readonly LoadedScenario[];
  readonly errors: readonly { readonly file: string; readonly error: string }[];
}

/**
 * Load + validate a list of scenario files. Schema errors are collected
 * (the caller decides whether to hard-fail or report).
 */
export function loadScenarios(
  files: readonly string[],
  validator: ValidateFunction,
  opts: { readonly strict?: boolean } = {},
): LoadResult {
  const strict = opts.strict === true;
  const scenarios: LoadedScenario[] = [];
  const errors: { file: string; error: string }[] = [];
  const seenIds = new Map<string, string>();

  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      if (strict) {
        errors.push({
          file,
          error: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      continue;
    }
    // Cheap pre-filter: when walking a directory we may encounter
    // unrelated JSON (e.g. `test-result-example.json`). Only files that
    // declare `kind: "mutation"` are treated as scenarios; anything
    // else is silently skipped in non-strict mode (the default when a
    // *directory* is passed) and hard-errored in strict mode (when a
    // *single file* is passed).
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      if (strict) errors.push({ file, error: 'top-level value must be a JSON object' });
      continue;
    }
    const obj = raw as { kind?: unknown };
    if (obj.kind !== 'mutation') {
      if (strict)
        errors.push({ file, error: `not a mutation scenario (kind=${JSON.stringify(obj.kind)})` });
      continue;
    }

    if (!validator(raw)) {
      errors.push({
        file,
        error: `schema validation failed: ${JSON.stringify(validator.errors)}`,
      });
      continue;
    }
    const scenario = raw as MutationScenario;
    const prior = seenIds.get(scenario.id);
    if (prior !== undefined) {
      errors.push({
        file,
        error: `duplicate scenario id '${scenario.id}' (also in ${prior})`,
      });
      continue;
    }
    seenIds.set(scenario.id, file);
    scenarios.push({ scenario: { ...scenario, __source_file: file }, file });
  }

  return { scenarios, errors };
}

// ============================================================================
// External-merge mode.
// ============================================================================

/**
 * `--external` accepts either:
 *   (a) a single JSON file containing either
 *         - an array of MutantReport, or
 *         - an object keyed by scenario id → MutantReport, or
 *         - an object with `scenarios` array (matches our own emit shape);
 *   (b) a directory of JSON files, each a single MutantReport.
 *
 * Returns a map from scenario id → MutantReport.
 */
function loadExternalReports(externalArg: string, repoRoot: string): Map<string, MutantReport> {
  const abs = isAbsolute(externalArg) ? externalArg : resolve(repoRoot, externalArg);
  if (!existsSync(abs)) {
    throw new Error(`--external path does not exist: ${abs}`);
  }
  const st = statSync(abs);
  const map = new Map<string, MutantReport>();

  if (st.isFile()) {
    const raw = JSON.parse(readFileSync(abs, 'utf8')) as unknown;
    if (Array.isArray(raw)) {
      for (const item of raw) ingestReport(item, map);
    } else if (raw !== null && typeof raw === 'object') {
      const obj = raw as { scenarios?: unknown; [k: string]: unknown };
      if (Array.isArray(obj.scenarios)) {
        for (const item of obj.scenarios) ingestReport(item, map);
      } else {
        // assume id-keyed
        for (const [id, val] of Object.entries(obj)) {
          if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
            const r = val as { status?: unknown; duration_ms?: unknown; error?: unknown };
            if (isValidStatus(r.status)) {
              const out: MutantReport = {
                id,
                status: r.status as MutationStatus,
                ...(typeof r.duration_ms === 'number' && { duration_ms: r.duration_ms }),
                ...(typeof r.error === 'string' && { error: r.error }),
              };
              map.set(id, out);
            }
          }
        }
      }
    }
    return map;
  }

  if (st.isDirectory()) {
    for (const file of walkJsonFiles(abs)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
        ingestReport(raw, map);
      } catch {
        // skip unreadable
      }
    }
    return map;
  }

  throw new Error(`--external path is neither file nor directory: ${abs}`);
}

function ingestReport(item: unknown, map: Map<string, MutantReport>): void {
  if (item === null || typeof item !== 'object') return;
  const r = item as { id?: unknown; status?: unknown; duration_ms?: unknown; error?: unknown };
  if (typeof r.id !== 'string') return;
  if (!isValidStatus(r.status)) return;
  const out: MutantReport = {
    id: r.id,
    status: r.status as MutationStatus,
    ...(typeof r.duration_ms === 'number' && { duration_ms: r.duration_ms }),
    ...(typeof r.error === 'string' && { error: r.error }),
  };
  map.set(r.id, out);
}

function isValidStatus(s: unknown): s is MutationStatus {
  return s === 'Killed' || s === 'Survived' || s === 'Timeout' || s === 'RuntimeError';
}

// ============================================================================
// Mutator adapter (dynamic import).
// ============================================================================

async function loadMutatorAdapter(mutatorArg: string, repoRoot: string): Promise<MutatorAdapter> {
  const abs = isAbsolute(mutatorArg) ? mutatorArg : resolve(repoRoot, mutatorArg);
  if (!existsSync(abs)) {
    throw new Error(`--mutator module not found: ${abs}`);
  }
  const url = pathToFileURL(abs).href;
  const mod = (await import(url)) as { default?: unknown };
  if (typeof mod.default !== 'function') {
    throw new Error(
      `--mutator module ${abs} does not export a default function (mutator, ctx) => MutantReport`,
    );
  }
  return mod.default as MutatorAdapter;
}

// ============================================================================
// Verdict computation: scenario expectation × mutant status → kept score.
// ============================================================================

/**
 * Given a scenario and the runner's observed status, decide whether the
 * scenario passes its declared expectations. The verdict here is what's
 * surfaced in the per-scenario `scenarios[]` array; the *aggregate*
 * `survived` / `mutation_score` reflect the observed status, which is
 * what the canonical mutation check compares against thresholds.
 *
 * For v1.0.0:
 *   - `tests-detect` with default threshold expects `Killed`.
 *   - `tests-detect` with explicit `threshold.status` expects that status.
 *   - `tests-tolerate` expects `Survived` (the mutation goes undetected).
 *
 * If any expectation fails, the scenario's `error` field carries a hint.
 */
export function classifyScenario(
  scenario: MutationScenario,
  observed: MutationStatus,
): { ok: boolean; reason?: string } {
  for (const exp of scenario.expectations) {
    if (exp.assertion === 'tests-tolerate') {
      if (observed !== 'Survived') {
        return {
          ok: false,
          reason: `tests-tolerate expected Survived but observed ${observed}`,
        };
      }
    } else {
      const want = exp.threshold?.status ?? 'Killed';
      if (observed !== want) {
        return {
          ok: false,
          reason: `tests-detect expected ${want} but observed ${observed}`,
        };
      }
    }
  }
  return { ok: true };
}

// ============================================================================
// CLI command.
// ============================================================================

interface RunOptions {
  readonly repoRoot?: string;
  readonly scenarios?: string;
  readonly out?: string;
  readonly mutator?: string;
  readonly external?: string;
  readonly reportPath?: string;
  readonly human?: boolean;
  readonly failOnSurvivors?: boolean;
}

interface CurrentJson {
  readonly schemaVersion: '1.0.0';
  readonly mutation_score: number;
  readonly survived: number;
  readonly killed: number;
  readonly total: number;
  readonly report_path?: string;
  readonly metrics: {
    readonly mutationScore: number;
    readonly survived: number;
    readonly killed: number;
    readonly timeout: number;
    readonly runtimeErrors: number;
    readonly total: number;
  };
  readonly scenarios: readonly {
    readonly id: string;
    readonly status: MutationStatus;
    readonly duration_ms?: number;
    readonly error?: string;
    readonly ok?: boolean;
  }[];
}

function aggregate(
  reports: readonly MutantReport[],
  scenariosById: Map<string, MutationScenario>,
  reportPath: string | undefined,
): CurrentJson {
  let killed = 0;
  let survived = 0;
  let timeout = 0;
  let runtimeErrors = 0;
  const detail: CurrentJson['scenarios'] = reports.map((r) => {
    switch (r.status) {
      case 'Killed':
        killed += 1;
        break;
      case 'Survived':
        survived += 1;
        break;
      case 'Timeout':
        timeout += 1;
        break;
      case 'RuntimeError':
        runtimeErrors += 1;
        break;
    }
    const sc = scenariosById.get(r.id);
    const verdict = sc !== undefined ? classifyScenario(sc, r.status) : { ok: true };
    // Error precedence: the raw runner error (e.g., "no external
    // report") takes precedence over the verdict-derived reason; only
    // when the runner reported no error do we surface the
    // expectation-mismatch hint.
    const error =
      typeof r.error === 'string'
        ? r.error
        : verdict.reason !== undefined
          ? verdict.reason
          : undefined;
    return {
      id: r.id,
      status: r.status,
      ...(typeof r.duration_ms === 'number' && { duration_ms: r.duration_ms }),
      ...(error !== undefined && { error }),
      ok: verdict.ok,
    };
  });
  const total = reports.length;
  // Conventional Stryker mutation score: killed / (killed + survived + timeout)
  // — runtime errors are excluded from the denominator. We match that.
  const denom = killed + survived + timeout;
  const score = denom === 0 ? 100 : (killed / denom) * 100;
  return {
    schemaVersion: '1.0.0',
    mutation_score: round1(score),
    survived,
    killed,
    total,
    ...(reportPath !== undefined && { report_path: reportPath }),
    metrics: {
      mutationScore: round1(score),
      survived,
      killed,
      timeout,
      runtimeErrors,
      total,
    },
    scenarios: detail,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export const mutationRun = defineCommand({
  name: 'mutation run',
  description: 'Run mutation scenarios and emit the current mutation evidence report.',
  authority: 'sensor',
  extended_doc: [
    '### Invocation',
    '',
    '```',
    'devai evidence record --kind mutation --run \\',
    '  --scenarios tests/mutation/scenarios/ \\',
    '  --out .devai/state/mutation/current.json \\',
    '  [--mutator ./scripts/my-mutator.mjs] \\',
    '  [--external reports/mutation/scenario-results.json]',
    '```',
    '',
    '### Flags',
    '',
    '- `--scenarios <path>` (required) — directory, single JSON file, or simple `dir/**/*.json` pattern. Every file must validate against `law/schemas/mutation-scenario.schema.json`.',
    '- `--out <path>` — output `current.json` (default: `.devai/state/mutation/current.json`).',
    '- `--mutator <module>` — adopter ESM module path. Default export: `(scenario, ctx) => Promise<MutantReport>`. Mutually exclusive with `--external`.',
    '- `--external <path>` — pre-computed per-scenario report (single JSON file or directory of files). Use when an upstream framework (Stryker, Pitest) has already produced verdicts.',
    '- `--report-path <path>` — optional rich-report path embedded in `current.json.report_path`.',
    '- `--fail-on-survivors` — exit non-zero if any scenario survived.',
    '- `--format human` — human-readable summary.',
    '',
    '### Output shape',
    '',
    'The emitted `current.json` contains aggregate metrics and per-scenario results:',
    '',
    '```json',
    '{',
    '  "schemaVersion": "1.0.0",',
    '  "mutation_score": 92.0,',
    '  "survived": 2,',
    '  "killed": 23,',
    '  "total": 25,',
    '  "metrics": { "mutationScore": 92.0, "survived": 2, "killed": 23, "timeout": 0, "runtimeErrors": 0, "total": 25 },',
    '  "scenarios": [ { "id": "AIT-001", "status": "Killed", "ok": true } ]',
    '}',
    '```',
    '',
    'The canonical mutation check compares `mutation_score` and `survived` with thresholds and an optional baseline.',
    '',
    '### Exit codes',
    '',
    '- `0` — scenarios loaded, `current.json` written.',
    '- `2` — usage error (missing flag, unknown path, schema-invalid scenario, conflicting flags).',
    '- `65` — schema configuration error (mutation-scenario schema missing).',
    '- `1` — `--fail-on-survivors` and at least one scenario survived.',
    '',
    '### See also',
    '',
    '- [`docs/adopters/mutation-scenarios.md`](../../adopters/mutation-scenarios.md) — adopter guide.',
  ].join('\n'),
  register(cli: CAC): void {
    cli
      .command('mutation-run', 'Run mutation scenarios and emit current.json')
      .option('--repo-root <path>', 'Repo root (default: cwd)')
      .option('--scenarios <path>', 'Scenarios path (file, dir, or dir/**/*.json) — required')
      .option('--out <path>', `Output current.json (default: ${DEFAULT_OUT})`)
      .option(
        '--mutator <module>',
        'ESM mutator adapter module (default export = (scenario, ctx) => MutantReport)',
      )
      .option('--external <path>', 'Pre-computed per-scenario reports (file or dir of JSON)')
      .option('--report-path <path>', 'Optional rich-report path written into current.json')
      .option('--fail-on-survivors', 'Exit non-zero if any scenario survived')
      .option('--human', 'Human-readable summary on stdout')
      .action(async (options: RunOptions) => {
        try {
          const repoRoot = resolve(options.repoRoot ?? process.cwd());
          if (options.scenarios === undefined || options.scenarios.length === 0) {
            process.stderr.write(`${MUTATION_ACTION}: --scenarios is required\n`);
            process.exit(EXIT_USAGE);
          }
          if (options.mutator !== undefined && options.external !== undefined) {
            process.stderr.write(
              `${MUTATION_ACTION}: --mutator and --external are mutually exclusive\n`,
            );
            process.exit(EXIT_USAGE);
          }

          let validator: ValidateFunction;
          try {
            validator = getScenarioValidator(repoRoot);
          } catch (err) {
            process.stderr.write(
              `${MUTATION_ACTION}: ${err instanceof Error ? err.message : String(err)}\n`,
            );
            process.exit(EXIT_CONFIG);
            return;
          }

          let scenarioFiles: string[];
          let strictLoad = false;
          try {
            scenarioFiles = expandScenarioPaths(options.scenarios, repoRoot);
            // Strict mode (any non-mutation JSON is a load error) when the
            // user passed a single file path. Non-strict (silently skip
            // non-scenario JSON) when the input was a directory or glob —
            // the directory is allowed to contain unrelated JSON.
            const expandedAbs = isAbsolute(options.scenarios)
              ? options.scenarios
              : resolve(repoRoot, options.scenarios);
            strictLoad =
              !options.scenarios.includes('*') &&
              existsSync(expandedAbs) &&
              statSync(expandedAbs).isFile();
          } catch (err) {
            process.stderr.write(
              `${MUTATION_ACTION}: ${err instanceof Error ? err.message : String(err)}\n`,
            );
            process.exit(EXIT_USAGE);
            return;
          }
          if (scenarioFiles.length === 0) {
            process.stderr.write(
              `${MUTATION_ACTION}: no scenario files matched ${options.scenarios}\n`,
            );
            process.exit(EXIT_USAGE);
          }

          const { scenarios: loaded, errors: loadErrors } = loadScenarios(
            scenarioFiles,
            validator,
            { strict: strictLoad },
          );
          if (loadErrors.length > 0) {
            for (const e of loadErrors) {
              process.stderr.write(`${MUTATION_ACTION}: ${e.file}: ${e.error}\n`);
            }
            process.exit(EXIT_USAGE);
          }

          const scenariosById = new Map<string, MutationScenario>();
          for (const s of loaded) scenariosById.set(s.scenario.id, s.scenario);

          // Compute per-scenario MutantReport.
          const reports: MutantReport[] = [];
          if (options.external !== undefined) {
            const externalMap = loadExternalReports(options.external, repoRoot);
            for (const { scenario } of loaded) {
              const r = externalMap.get(scenario.id);
              if (r === undefined) {
                reports.push({
                  id: scenario.id,
                  status: 'RuntimeError',
                  error: `no external report for scenario '${scenario.id}'`,
                });
              } else {
                reports.push(r);
              }
            }
          } else if (options.mutator !== undefined) {
            const adapter = await loadMutatorAdapter(options.mutator, repoRoot);
            const ctx: MutatorAdapterContext = { repoRoot };
            for (const { scenario } of loaded) {
              const t0 = Date.now();
              try {
                const r = await Promise.resolve(adapter(scenario, ctx));
                const enriched: MutantReport = {
                  id: scenario.id,
                  status: r.status,
                  ...(typeof r.duration_ms === 'number'
                    ? { duration_ms: r.duration_ms }
                    : { duration_ms: Date.now() - t0 }),
                  ...(typeof r.error === 'string' && { error: r.error }),
                };
                reports.push(enriched);
              } catch (err) {
                reports.push({
                  id: scenario.id,
                  status: 'RuntimeError',
                  duration_ms: Date.now() - t0,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          } else {
            // No runner configured. The public mutation evidence action accepts an adopter
            // mutator or external report; without either, every loaded scenario survives.
            for (const { scenario } of loaded) {
              reports.push({
                id: scenario.id,
                status: 'Survived',
                error:
                  'no --mutator or --external configured (scenarios loaded; mutations not executed)',
              });
            }
          }

          const current = aggregate(reports, scenariosById, options.reportPath);

          const outPath = resolve(repoRoot, options.out ?? DEFAULT_OUT);
          mkdirSync(dirname(outPath), { recursive: true });
          writeFileSync(outPath, JSON.stringify(current, null, 2) + '\n');

          if (options.human === true) {
            process.stdout.write(
              `${MUTATION_ACTION}: ${String(loaded.length)} scenario(s) loaded; ` +
                `${String(current.killed)} killed, ${String(current.survived)} survived, ` +
                `${String(current.metrics.timeout)} timeout, ` +
                `${String(current.metrics.runtimeErrors)} runtime-error. ` +
                `Score ${current.mutation_score.toFixed(1)}%. Wrote ${outPath}\n`,
            );
          } else {
            process.stdout.write(
              JSON.stringify({
                ok: true,
                out: outPath,
                scenarios_loaded: loaded.length,
                killed: current.killed,
                survived: current.survived,
                mutation_score: current.mutation_score,
              }) + '\n',
            );
          }

          process.exitCode =
            options.failOnSurvivors === true && current.survived > 0 ? EXIT_FAIL : EXIT_PASS;
        } catch (err) {
          if (isActionOutputExit(err)) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${MUTATION_ACTION}: ${msg}\n`);
          process.exit(EXIT_FAIL);
        }
      });
  },
});
