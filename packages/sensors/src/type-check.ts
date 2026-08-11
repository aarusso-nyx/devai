import { existsSync, statSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { runCommand } from './run-command.js';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

export type TypecheckStrategy = 'root' | 'per-package';

export interface TypeCheckOptions {
  readonly cwd: string;
  /** Explicit tsconfig path. When set, strategy is forced to `root`. */
  readonly project?: string;
  readonly timeoutMs?: number;
  /**
   * Phase 23.D (closes D-A-21). `root` (default) preserves pre-23.D
   * behaviour: invoke `tsc --noEmit` against the cwd's root
   * tsconfig. `per-package` walks `scanDirs` for per-package
   * `tsconfig.json` files and runs `tsc --noEmit -p <each>`,
   * emitting one per-project SensorReading plus one aggregate.
   * Pack-configurable via `extractor_params.inventory_type_check.typecheck_strategy`.
   */
  readonly strategy?: TypecheckStrategy;
  /**
   * Directories under `cwd` to scan for per-package tsconfigs.
   * Default: `['packages', 'apps', 'reference', 'domain', 'tools']`.
   * Only applies when `strategy === 'per-package'`.
   */
  readonly scanDirs?: readonly string[];
}

export interface TypeCheckResult {
  readonly aggregate: SensorReading;
  /** One SR per discovered project. Empty when strategy === 'root'. */
  readonly perProject: readonly SensorReading[];
}

const TSC_ERROR_PATTERN = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;
const DEFAULT_SCAN_DIRS: readonly string[] = ['packages', 'apps', 'reference', 'domain', 'tools'];

/**
 * Wrap `tsc --noEmit` and emit a SensorReading with per-error
 * findings. `strategy === 'per-package'` runs
 * the compiler against every per-package tsconfig discovered under
 * the configured scan dirs and emits a SensorReading per project
 * plus an aggregate; `strategy === 'root'` preserves pre-23.D
 * behaviour (one SR against the cwd root tsconfig).
 *
 * Pre-23.D, root-mode was the only option; against monorepos with
 * a root tsconfig that omits `jest` from `types[]`, the L0
 * correctness signal false-positives on every `*.spec.ts` file
 * (TS2304/TS2593 against `describe`, `expect`, etc.) — stynx T1
 * This keeps package findings attributable to their source package.
 */
export function senseTypeCheck(opts: TypeCheckOptions): TypeCheckResult {
  const strategy: TypecheckStrategy = opts.strategy ?? 'root';
  if (strategy === 'per-package' && opts.project === undefined) {
    return runPerPackage(opts);
  }
  return { aggregate: runSingle(opts), perProject: [] };
}

function runSingle(opts: TypeCheckOptions, projectOverride?: string): SensorReading {
  const project = projectOverride ?? opts.project;
  const args = ['npx', 'tsc', '--noEmit'];
  if (project !== undefined) args.push('-p', project);
  const result = runCommand(args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 120_000 });

  const findings: SensorFinding[] = [];
  for (const line of result.stdout.split('\n')) {
    const m = TSC_ERROR_PATTERN.exec(line);
    if (m) {
      findings.push({
        severity: 'error',
        code: m[4] ?? 'TS0',
        message: m[5] ?? '',
        file: m[1],
        line: Number(m[2]),
      });
    }
  }
  const status: SensorStatus = result.exit_code === 0 ? 'pass' : 'fail';
  const sensorName =
    projectOverride !== undefined
      ? `type-check:${labelFor(projectOverride, opts.cwd)}`
      : 'type-check';

  return buildSensorReading({
    sensorName,
    sensorKind: 'type_check',
    command: args,
    status,
    deterministic: true,
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    out_head: result.stdout,
    err_head: result.stderr,
    killed: result.killed,
    findings,
    metrics: {
      error_count: findings.length,
      ...(projectOverride !== undefined && { project: labelFor(projectOverride, opts.cwd) }),
    },
  });
}

function runPerPackage(opts: TypeCheckOptions): TypeCheckResult {
  const projects = discoverProjects(opts.cwd, opts.scanDirs ?? DEFAULT_SCAN_DIRS);
  if (projects.length === 0) {
    // No per-package tsconfigs found: fall through to root mode so
    // the caller still gets one SR rather than an empty aggregate.
    return { aggregate: runSingle(opts), perProject: [] };
  }
  const perProject = projects.map((p) => runSingle(opts, p));
  return { aggregate: buildAggregate(perProject, opts.cwd, projects), perProject };
}

function discoverProjects(cwd: string, scanDirs: readonly string[]): readonly string[] {
  const found: string[] = [];
  for (const dir of scanDirs) {
    const absDir = isAbsolute(dir) ? dir : join(cwd, dir);
    if (!existsSync(absDir)) continue;
    let entries: readonly string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      continue;
    }
    for (const entry of [...entries].sort()) {
      const absPkg = join(absDir, entry);
      let s;
      try {
        s = statSync(absPkg);
      } catch {
        continue;
      }
      if (!s.isDirectory()) continue;
      const tsconfig = join(absPkg, 'tsconfig.json');
      if (existsSync(tsconfig)) found.push(tsconfig);
    }
  }
  return found;
}

function labelFor(tsconfigPath: string, cwd: string): string {
  const rel = relative(cwd, tsconfigPath);
  // strip trailing /tsconfig.json for readability
  return rel.replace(/\/tsconfig\.json$/, '');
}

function buildAggregate(
  perProject: readonly SensorReading[],
  cwd: string,
  projects: readonly string[],
): SensorReading {
  const failed = perProject.filter((r) => r.status === 'fail').length;
  const passed = perProject.filter((r) => r.status === 'pass').length;
  const errorCount = perProject.reduce(
    (sum, r) => sum + (typeof r.metrics?.error_count === 'number' ? r.metrics.error_count : 0),
    0,
  );
  const projectLabels = projects.map((p) => labelFor(p, cwd));
  const status: SensorStatus = failed > 0 ? 'fail' : 'pass';
  const findings: SensorFinding[] = perProject
    .filter((r) => r.status === 'fail')
    .map((r) => ({
      severity: 'error' as const,
      code: 'TYPECHECK_PROJECT_FAIL',
      message: `project '${String(r.metrics?.project ?? 'unknown')}' failed with ${String(
        r.metrics?.error_count ?? '?',
      )} TS error(s)`,
    }));
  return buildSensorReading({
    sensorName: 'type-check',
    sensorKind: 'type_check',
    command: ['npx', 'tsc', '--noEmit', '(per-package aggregate)'],
    status,
    deterministic: true,
    duration_ms: perProject.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0),
    findings,
    metrics: {
      projects_total: perProject.length,
      projects_passed: passed,
      projects_failed: failed,
      error_count_total: errorCount,
      project_paths: projectLabels.join(','),
    },
  });
}
