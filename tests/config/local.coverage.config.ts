import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import type { Reporter, TestModule, TestRunEndReason, Vitest } from 'vitest/node';
import {
  COVERAGE_PRODUCER_NAME,
  FULL_SUITE_SELECTOR,
  readHeadCommit,
  sha256OfFile,
  type CoverageBinding,
} from '../../packages/sensors/src/coverage-binding.js';
import {
  LOCAL_INCLUDE,
  MAX_TEST_WORKERS,
  RC_ONLY,
  SUBPROCESS_TEST_TIMEOUT_MS,
} from './local.config.js';

/**
 * The database-free coverage producer for the `local` population (ADR-SCR-0007).
 *
 * It runs `LOCAL_INCLUDE` from the local configuration, leaves out exactly the
 * suites `.devai/config/sensor-inputs.json` declares as `exclusions` for
 * `test_coverage_depth` (the `RC_ONLY` list), and writes the Istanbul per-file
 * report to `scratch/coverage/local/coverage-final.json`. It never reads
 * `DEVAI_DB_TESTS` and enforces no threshold: the sensor applies thresholds, so
 * a second enforcement point here would disagree with it.
 *
 * Beside the report it writes `population.json`, naming the population, the
 * include globs, the excluded suites, and the count of files measured, so the
 * sensor can refuse a report produced over another population. The sidecar is
 * written only when every test passed; a failed run leaves neither file, and the
 * producer's non-zero exit is the reading.
 */
export const LOCAL_COVERAGE_POPULATION = 'local';
export const LOCAL_COVERAGE_EXCLUSIONS: readonly string[] = [...RC_ONLY];
export const LOCAL_COVERAGE_DIRECTORY = 'scratch/coverage/local';
export const LOCAL_COVERAGE_REPORT = `${LOCAL_COVERAGE_DIRECTORY}/coverage-final.json`;
export const LOCAL_COVERAGE_SIDECAR = `${LOCAL_COVERAGE_DIRECTORY}/population.json`;

export interface LocalCoverageSidecar {
  readonly schemaVersion: '1.0.0';
  readonly population: string;
  readonly include: readonly string[];
  readonly exclusions: readonly string[];
  /** Source files the coverage report measures (its per-file entries). */
  readonly filesMeasured: number;
  /** Test files the run executed. */
  readonly testFiles: number;
  /**
   * Binds the report to the commit and the full run that wrote it (#336); the sensor reuses
   * an existing report only when this matches the candidate.
   */
  readonly binding?: CoverageBinding;
}

/** The sidecar's content for a run; deterministic for the same counts. */
export function localCoverageSidecar(counts: {
  readonly filesMeasured: number;
  readonly testFiles: number;
  readonly binding?: CoverageBinding;
}): LocalCoverageSidecar {
  return {
    schemaVersion: '1.0.0',
    population: LOCAL_COVERAGE_POPULATION,
    include: [...LOCAL_INCLUDE],
    exclusions: [...LOCAL_COVERAGE_EXCLUSIONS],
    filesMeasured: counts.filesMeasured,
    testFiles: counts.testFiles,
    ...(counts.binding !== undefined && { binding: counts.binding }),
  };
}

/** The selector of a run: `full-suite`, or what narrowed it (file filter, name, shard, changed). */
export function runSelector(config: {
  readonly filters?: readonly string[];
  readonly testNamePattern?: unknown;
  readonly shard?: unknown;
  readonly changed?: unknown;
  readonly related?: readonly string[];
}): string {
  const parts: string[] = [];
  if ((config.filters ?? []).length > 0) parts.push(`files ${(config.filters ?? []).join(' ')}`);
  if (config.testNamePattern !== undefined) parts.push('test name pattern');
  if (config.shard !== undefined) parts.push('shard');
  if (config.changed !== undefined && config.changed !== false) parts.push('changed files');
  if ((config.related ?? []).length > 0) parts.push('related files');
  return parts.length === 0 ? FULL_SUITE_SELECTOR : parts.join('; ');
}

/** The number of per-file entries in a coverage map or a plain report object. */
export function measuredFileCount(coverage: unknown): number {
  if (coverage === null || typeof coverage !== 'object') return 0;
  const files = (coverage as { files?: unknown }).files;
  if (typeof files === 'function') {
    const listed: unknown = (files as () => unknown).call(coverage);
    if (Array.isArray(listed)) return listed.length;
  }
  return Object.keys(coverage).length;
}

/** Writes the population sidecar after a passing run; removes a stale one first. */
export class PopulationSidecarReporter implements Reporter {
  private filesMeasured: number | undefined;
  private testFiles = 0;
  private passed = false;
  private version = 'unknown';
  private vitest: Vitest | undefined;
  private subset: string | undefined;

  constructor(
    private readonly sidecarPath: string = resolve(LOCAL_COVERAGE_SIDECAR),
    private readonly reportPath: string = resolve(LOCAL_COVERAGE_REPORT),
    private readonly repoRoot: string = resolve('.'),
  ) {}

  onInit(vitest: Vitest): void {
    rmSync(this.sidecarPath, { force: true });
    this.vitest = vitest;
    this.version = vitest.version;
  }

  onCoverage(coverage: unknown): void {
    this.filesMeasured = measuredFileCount(coverage);
  }

  async onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    _unhandledErrors: ReadonlyArray<unknown>,
    reason: TestRunEndReason,
  ): Promise<void> {
    this.passed = reason === 'passed';
    this.testFiles = testModules.length;
    // The command-line file filters reach vitest after `onInit`, so a run is judged a subset
    // by what it executed against the whole population as well as by its recorded filters.
    const population = await this.vitest?.globTestSpecifications();
    if (population !== undefined && population.length !== testModules.length) {
      this.subset = `${String(testModules.length)} of ${String(population.length)} test files`;
    }
  }

  /**
   * Vitest writes the coverage report after the run ends, so the sidecar, which carries the
   * report's digest, is written once the report is on disk. A failed run leaves no sidecar.
   */
  onFinishedReportCoverage(): void {
    if (!this.passed || this.filesMeasured === undefined) return;
    const config = this.vitest?.config;
    const filenamePattern = (this.vitest as { filenamePattern?: readonly string[] } | undefined)
      ?.filenamePattern;
    const narrowed = runSelector({
      ...config,
      filters: filenamePattern ?? config?.filters ?? [],
    });
    const selector =
      this.subset === undefined
        ? narrowed
        : [...(narrowed === FULL_SUITE_SELECTOR ? [] : [narrowed]), this.subset].join('; ');
    const commit = readHeadCommit(this.repoRoot);
    const reportSha256 = sha256OfFile(this.reportPath);
    const sidecar = localCoverageSidecar({
      filesMeasured: this.filesMeasured,
      testFiles: this.testFiles,
      ...(commit !== undefined &&
        reportSha256 !== undefined && {
          binding: {
            commit,
            producer: { name: COVERAGE_PRODUCER_NAME, version: this.version },
            selector,
            reportSha256,
          },
        }),
    });
    mkdirSync(dirname(this.sidecarPath), { recursive: true });
    writeFileSync(this.sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
  }
}

export default defineConfig({
  resolve: {
    alias: {
      '#runtime-core': resolve('packages/cli/src/runtime-core.ts'),
      '@devai-nyx/authority': resolve('packages/authority/src/index.ts'),
    },
    conditions: ['development'],
  },
  test: {
    name: 'local coverage',
    environment: 'node',
    include: [...LOCAL_INCLUDE],
    exclude: ['**/node_modules/**', '**/dist/**', ...LOCAL_COVERAGE_EXCLUSIONS],
    passWithNoTests: false,
    testTimeout: SUBPROCESS_TEST_TIMEOUT_MS,
    hookTimeout: SUBPROCESS_TEST_TIMEOUT_MS,
    maxWorkers: MAX_TEST_WORKERS,
    reporters: ['default', new PopulationSidecarReporter()],
    coverage: {
      provider: 'v8',
      enabled: true,
      clean: true,
      reportsDirectory: LOCAL_COVERAGE_DIRECTORY,
      reporter: ['json', 'text-summary'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/dist/**', '**/tests/**', '**/*.config.ts', '**/generated/**', '**/*.d.ts'],
    },
  },
});
