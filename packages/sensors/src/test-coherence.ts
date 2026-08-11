import { readdirSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
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

function abs(repoRoot: string, p: string): string {
  return isAbsolute(p) ? p : resolve(repoRoot, p);
}

function safeStat(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

function listFiles(dir: string, sink: string[]): void {
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
    listFiles(join(dir, e), sink);
  }
}

function isTestFile(name: string): { isTest: boolean; usesTest: boolean; usesSpec: boolean } {
  const isTest = /\.test\.(ts|tsx|js|jsx)$/.test(name);
  const isSpec = /\.spec\.(ts|tsx|js|jsx)$/.test(name);
  return { isTest: isTest || isSpec, usesTest: isTest, usesSpec: isSpec };
}

function isSourceFile(name: string): boolean {
  if (!/\.(ts|tsx|js|jsx)$/.test(name)) return false;
  if (/\.d\.ts$/.test(name)) return false;
  if (/\.test\.(ts|tsx|js|jsx)$/.test(name)) return false;
  if (/\.spec\.(ts|tsx|js|jsx)$/.test(name)) return false;
  return true;
}

function listPackageDirs(repoRoot: string, roots: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of roots) {
    // Trailing /** is collapsed to /*, since the per-package scanner walks recursively anyway.
    const normalised = r.replace(/\/\*\*$/, '/*');
    if (!normalised.includes('*')) {
      const st = safeStat(abs(repoRoot, normalised));
      if (st !== null && st.isDirectory()) out.push(abs(repoRoot, normalised));
      continue;
    }
    const parts = normalised.split('/');
    const wildIdx = parts.findIndex((p) => p.includes('*'));
    if (wildIdx < 0) continue;
    const before = parts.slice(0, wildIdx).join('/');
    const after = parts.slice(wildIdx + 1).join('/');
    let entries: string[];
    try {
      entries = readdirSync(abs(repoRoot, before));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = abs(repoRoot, [before, entry, after].filter((s) => s !== '').join('/'));
      const st = safeStat(candidate);
      if (st !== null && st.isDirectory()) out.push(candidate);
    }
  }
  return out;
}

export function senseTestCoherence(opts: TestCoherenceOptions): SensorReading {
  const roots = opts.packageRoots ?? DEFAULT_PACKAGE_ROOTS;
  const minRatio = opts.minPerPackageRatio ?? DEFAULT_MIN_RATIO;
  const passRatio = opts.passRatio ?? DEFAULT_PASS_RATIO;
  const pkgDirs = listPackageDirs(opts.repoRoot, roots);

  let totalSources = 0;
  let totalTests = 0;
  let usesTest = 0;
  let usesSpec = 0;
  let belowMin = 0;
  const findings: SensorFinding[] = [];

  for (const pkg of pkgDirs) {
    const allFiles: string[] = [];
    listFiles(pkg, allFiles);
    let pkgSources = 0;
    let pkgTests = 0;
    for (const f of allFiles) {
      const base = f.split('/').pop() ?? '';
      const t = isTestFile(base);
      if (t.isTest) {
        pkgTests += 1;
        if (t.usesTest) usesTest += 1;
        else if (t.usesSpec) usesSpec += 1;
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
  const namingConsistent = usesTest === 0 || usesSpec === 0;
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
