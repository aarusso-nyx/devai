import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

/**
 * Inventory sensor: test idiomaticity (F3 × T5). Phase 27.I.
 * Per design note at docs/theory/architecture/sensors/test_idiomaticity.md.
 */

export interface TestIdiomaticityOptions {
  readonly repoRoot: string;
  readonly testGlobs?: readonly string[];
  readonly thresholds?: { readonly review: number; readonly fail: number };
  readonly now?: string;
}

const DEFAULT_TEST_GLOBS = ['packages/*/test', 'packages/*/src'];
const DEFAULT_THRESHOLDS = { review: 0.5, fail: 0.8 } as const;

const MOCK_RE =
  /\b(jest\.mock|jest\.fn|vi\.mock|vi\.fn|mockReturnValue|mockImplementation|spyOn)\(/g;
const FIXTURE_RE = /\b(beforeAll|beforeEach|afterAll|afterEach)\(/g;
const SNAPSHOT_RE = /\btoMatch(Inline)?Snapshot\(/g;
const INTEGRATION_RE = /\.(integration|e2e)\.(test|spec)\.[jt]sx?$/i;

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

function walkTestFiles(dir: string, sink: string[]): void {
  const st = safeStat(dir);
  if (st === null) return;
  if (st.isFile()) {
    if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(dir)) sink.push(dir);
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
    walkTestFiles(join(dir, e), sink);
  }
}

function expandRoots(repoRoot: string, globs: readonly string[]): string[] {
  const out: string[] = [];
  for (const g of globs) {
    const normalised = g.replace(/\/\*\*$/, '/*');
    if (!normalised.includes('*')) {
      out.push(abs(repoRoot, normalised));
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
      out.push(abs(repoRoot, [before, entry, after].filter((s) => s !== '').join('/')));
    }
  }
  return out;
}

function countMatches(content: string, re: RegExp): number {
  const matches = content.match(re);
  return matches === null ? 0 : matches.length;
}

export function senseTestIdiomaticity(opts: TestIdiomaticityOptions): SensorReading {
  const globs = opts.testGlobs ?? DEFAULT_TEST_GLOBS;
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;

  const roots = expandRoots(opts.repoRoot, globs);
  const files: string[] = [];
  for (const r of roots) walkTestFiles(r, files);

  let mockHeavyFiles = 0;
  let mocksInIntegration = 0;
  let totalMocks = 0;
  let totalFixtures = 0;
  let totalSnapshots = 0;
  const findings: SensorFinding[] = [];

  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const mocks = countMatches(content, MOCK_RE);
    const fixtures = countMatches(content, FIXTURE_RE);
    const snapshots = countMatches(content, SNAPSHOT_RE);
    totalMocks += mocks;
    totalFixtures += fixtures;
    totalSnapshots += snapshots;
    if (mocks >= 2) mockHeavyFiles += 1;
    if (mocks > 0 && INTEGRATION_RE.test(f)) {
      mocksInIntegration += 1;
      const rel = f.replace(opts.repoRoot + '/', '');
      findings.push({
        severity: 'warning',
        code: 'TEST_IDIOMATICITY_MOCK_IN_INTEGRATION',
        message: `Integration/e2e file uses mocks: ${rel}`,
        file: rel,
      });
    }
  }

  const total = files.length;
  const mockHeavyRatio = total === 0 ? 0 : mockHeavyFiles / total;
  let status: SensorStatus;
  if (total === 0) {
    status = 'review';
    findings.push({
      severity: 'info',
      code: 'TEST_IDIOMATICITY_NO_TESTS',
      message: 'No test files found.',
    });
  } else if (mockHeavyRatio >= thresholds.fail) {
    status = 'fail';
    findings.push({
      severity: 'error',
      code: 'TEST_IDIOMATICITY_MOCK_DOMINANT',
      message: `${(mockHeavyRatio * 100).toFixed(1)}% of test files are mock-heavy (≥ ${String(thresholds.fail * 100)}%).`,
    });
  } else if (mockHeavyRatio >= thresholds.review || mocksInIntegration > 0) {
    status = 'review';
    if (mockHeavyRatio >= thresholds.review) {
      findings.push({
        severity: 'warning',
        code: 'TEST_IDIOMATICITY_MOCK_HEAVY',
        message: `${(mockHeavyRatio * 100).toFixed(1)}% of test files are mock-heavy.`,
      });
    }
  } else {
    status = 'pass';
  }

  return buildSensorReading({
    sensorName: 'test-idiomaticity',
    sensorKind: 'test_idiomaticity',
    command: ['devai', 'sense-test-idiomaticity'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      test_files: total,
      mock_calls: totalMocks,
      fixture_calls: totalFixtures,
      snapshot_calls: totalSnapshots,
      mock_heavy_files: mockHeavyFiles,
      mock_heavy_ratio: Number(mockHeavyRatio.toFixed(3)),
      mocks_in_integration_files: mocksInIntegration,
    },
  });
}
