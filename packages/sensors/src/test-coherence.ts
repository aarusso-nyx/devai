import { lstatSync, readFileSync } from 'node:fs';
import { testRunnerFamily } from './test-runner-family.js';
import {
  executableTestKind,
  expandRepositoryPaths,
  isExecutableTestFile,
  regularFilePopulation,
} from './test-file-population.js';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

/**
 * Inventory sensor: test coherence (F3 × T3). Phase 27.H.
 * Per design note at docs/theory/architecture/sensors/test_coherence.md.
 */

export interface TestCoherenceOptions {
  readonly repoRoot: string;
  readonly packageRoots?: readonly string[];
  readonly minPerPackageRatio?: number;
  readonly passRatio?: number;
  readonly now?: string;
}

const DEFAULT_PACKAGE_ROOTS = ['packages/*'];
const DEFAULT_MIN_RATIO = 0.1;
const DEFAULT_PASS_RATIO = 0.3;

function isSourceFile(name: string): boolean {
  return (
    /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u.test(name) &&
    !/\.d\.ts$/u.test(name) &&
    !isExecutableTestFile(name)
  );
}

export function senseTestCoherence(opts: TestCoherenceOptions): SensorReading {
  const roots = opts.packageRoots ?? DEFAULT_PACKAGE_ROOTS;
  const minRatio = opts.minPerPackageRatio ?? DEFAULT_MIN_RATIO;
  const passRatio = opts.passRatio ?? DEFAULT_PASS_RATIO;
  const population = expandRepositoryPaths(opts.repoRoot, roots, {
    optional: opts.packageRoots === undefined,
    jsonDataAliasesWithin: opts.repoRoot,
  });
  const pkgDirs = population.paths.filter((path) =>
    lstatSync(population.physicalRoots?.get(path) ?? path).isDirectory(),
  );
  const errors = [...population.errors];

  let totalSources = 0;
  let totalTests = 0;
  let usesTest = 0;
  let usesSpec = 0;
  let unknownNaming = false;
  const familyNaming = new Map<string, { test: number; spec: number }>();
  let belowMin = 0;
  const findings: SensorFinding[] = [];

  for (const pkg of pkgDirs) {
    const allFiles = regularFilePopulation([pkg], population.physicalRoots, {
      jsonDataAliasesWithin: opts.repoRoot,
    });
    errors.push(...allFiles.errors);
    let pkgSources = 0;
    let pkgTests = 0;
    for (const f of allFiles.paths) {
      const base = f.split('/').pop() ?? '';
      const kind = executableTestKind(base);
      if (kind !== undefined) {
        pkgTests += 1;
        if (kind === 'test') usesTest += 1;
        else if (kind === 'spec' || kind === 'wiring-spec') usesSpec += 1;
        if (kind !== 'e2e') {
          try {
            const family = testRunnerFamily(f, readFileSync(f, 'utf8'));
            if (family === undefined) unknownNaming = true;
            else {
              const naming = familyNaming.get(family) ?? { test: 0, spec: 0 };
              if (kind === 'test') naming.test += 1;
              else naming.spec += 1;
              familyNaming.set(family, naming);
            }
          } catch (error) {
            errors.push(`Cannot read executable test ${f}: ${String(error)}`);
          }
        }
      } else if (isSourceFile(base)) {
        pkgSources += 1;
      }
    }
    const ratio = pkgSources === 0 ? 1 : pkgTests / pkgSources;
    if (ratio < minRatio && pkgSources > 0) {
      belowMin += 1;
      const rel = pkg.replace(opts.repoRoot + '/', '');
      findings.push({
        severity: 'warning',
        code: 'TEST_COHERENCE_PACKAGE_BELOW_MIN',
        message: `Package ${rel} has test/source ratio ${ratio.toFixed(2)} (< ${String(minRatio)}).`,
        file: rel,
      });
    }
    totalSources += pkgSources;
    totalTests += pkgTests;
  }

  const globalRatio = totalSources === 0 ? 1 : totalTests / totalSources;
  const namingConsistent =
    usesTest === 0 ||
    usesSpec === 0 ||
    (!unknownNaming &&
      [...familyNaming.values()].every((naming) => naming.test === 0 || naming.spec === 0));
  if (!namingConsistent) {
    findings.push({
      severity: 'warning',
      code: 'TEST_COHERENCE_NAMING_MIXED',
      message: `Test-file naming mixes .test.* (${String(usesTest)}) and .spec.* (${String(usesSpec)}).`,
    });
  }

  let status: SensorStatus;
  if (globalRatio < minRatio) {
    status = 'fail';
  } else if (namingConsistent && belowMin === 0 && globalRatio >= passRatio) {
    status = 'pass';
  } else {
    status = 'review';
  }

  if (errors.length > 0) {
    status = 'error';
    findings.push(
      ...errors.map((message) => ({
        severity: 'critical' as const,
        code: 'TEST_EXECUTABLE_POPULATION_INCOMPLETE',
        message,
      })),
    );
  }

  return buildSensorReading({
    sensorName: 'test-coherence',
    sensorKind: 'test_coherence',
    command: ['devai', 'sense-test-coherence'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      packages_scanned: pkgDirs.length,
      source_files: totalSources,
      test_files: totalTests,
      global_ratio: Number(globalRatio.toFixed(3)),
      packages_below_min_ratio: belowMin,
      naming_uses_test: usesTest,
      naming_uses_spec: usesSpec,
      naming_consistent: namingConsistent ? 1 : 0,
    },
  });
}
