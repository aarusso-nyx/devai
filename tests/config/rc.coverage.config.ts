import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

if (process.env.DEVAI_DB_TESTS !== '1') {
  throw new Error(
    'CHECK_RC_DB_TESTS_REQUIRED: set DEVAI_DB_TESTS=1 and provide a reachable test database before running the RC gate',
  );
}
import { LOCAL_INCLUDE, MAX_TEST_WORKERS } from './local.config.js';

interface ThresholdPolicy {
  coverage: {
    lines: number;
    branches: number;
    functions: number;
    statements: number;
  };
}

interface ReachableSourceManifest {
  schemaVersion: '1.0.0';
  sources: string[];
}

const policy = JSON.parse(
  readFileSync(resolve('law/policy/thresholds.json'), 'utf8'),
) as ThresholdPolicy;
const reachable = JSON.parse(
  readFileSync(resolve('scratch/coverage/rc-reachable-sources.json'), 'utf8'),
) as ReachableSourceManifest;
if (reachable.schemaVersion !== '1.0.0' || reachable.sources.length === 0) {
  throw new Error('RC_REACHABLE_SOURCE_MANIFEST_INVALID');
}

process.env['DEVAI_V8_SUBPROCESS_COVERAGE_DIR'] = resolve('scratch/coverage/rc-child-v8');

export default defineConfig({
  resolve: {
    alias: { '#runtime-core': resolve('packages/cli/src/runtime-core.ts') },
  },
  test: {
    name: 'RC coverage',
    environment: 'node',
    // Coverage instruments every case and its child processes, multiplying a case's cost 2-3x.
    // Cases measured at 5-7 s alone (the bundled export-store lifecycle, newest-line evidence
    // recovery, release-intent receipt export) timed out at the former 15 s across three 2.2.0
    // certification attempts. 60 s matches the per-case hang guards of #330 and #346 (#246), and
    // a genuine hang still surfaces far inside the 30-minute certification task limit. Only this
    // lane changes; the local and other RC lanes keep their defaults.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: [...LOCAL_INCLUDE, 'tests/e2e/**/*.test.ts', 'tests/regression/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/regression/xref-resolver-performance.regression.test.ts',
    ],
    passWithNoTests: false,
    // A full 2.6 RC took 20.4 minutes on an eight-core, 16 GB host with 9.54 GB of swap;
    // unrelated late TypeScript scans slowed 6-10x during shared-host memory pressure.
    // Cap this lane at three workers to bound concurrent compiler and subprocess pressure.
    // The fresh full RC validates this resource choice against the unchanged 30-minute
    // task guard, complete test population, and coverage thresholds.
    maxWorkers: Math.min(MAX_TEST_WORKERS, 3),
    coverage: {
      provider: 'custom',
      customProviderModule: resolve('tests/config/subprocess-v8-coverage-provider.ts'),
      enabled: true,
      reportsDirectory: 'scratch/coverage/rc',
      reporter: ['text', 'json-summary', 'json'],
      include: reachable.sources,
      exclude: ['**/dist/**', '**/tests/**', '**/*.config.ts', '**/generated/**'],
      thresholds: {
        lines: policy.coverage.lines,
        branches: policy.coverage.branches,
        functions: policy.coverage.functions,
        statements: policy.coverage.statements,
      },
    },
  },
});
