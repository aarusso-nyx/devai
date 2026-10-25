import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

if (process.env.DEVAI_DB_TESTS !== '1') {
  throw new Error(
    'CHECK_RC_DB_TESTS_REQUIRED: set DEVAI_DB_TESTS=1 and provide a reachable test database before running the RC gate',
  );
}
import {
  LOCAL_INCLUDE,
  MAX_TEST_WORKERS,
  NATIVE_HOST_LANE,
  SERIAL_LANE,
  commandLineExcludes,
} from './local.config.js';

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

const INCLUDE = [...LOCAL_INCLUDE, 'tests/e2e/**/*.test.ts', 'tests/regression/**/*.test.ts'];
const EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  'tests/regression/xref-resolver-performance.regression.test.ts',
  ...commandLineExcludes(),
];

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
    // a genuine hang still surfaces inside the certification task limit. Only this
    // lane changes; the local and other RC lanes keep their defaults.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    exclude: EXCLUDE,
    passWithNoTests: false,
    // A full 2.6 RC took 20.4 minutes on an eight-core, 16 GB host with 9.54 GB of swap;
    // unrelated late TypeScript scans slowed 6-10x during shared-host memory pressure.
    // The full B1 RC used 5,162 of three workers' 5,400 available worker-seconds
    // before its 30-minute task guard, with the suite still unfinished.
    // Permit at most four workers, retaining the existing shared host-size bound.
    // A fresh full RC must validate this choice with every test and threshold.
    maxWorkers: Math.min(MAX_TEST_WORKERS, 4),
    // Four mixed workers also exhausted that task guard and timed out nine native
    // cases and one P1 process. Keep the same complete population and case guards,
    // applying the already qualified local isolation before and after the parallel files.
    projects: [
      {
        extends: true,
        test: {
          name: 'RC coverage native host',
          include: [...NATIVE_HOST_LANE],
          exclude: EXCLUDE,
          maxWorkers: 2,
          fileParallelism: true,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'RC coverage',
          include: INCLUDE,
          exclude: [...EXCLUDE, ...NATIVE_HOST_LANE, ...SERIAL_LANE],
          maxWorkers: Math.min(MAX_TEST_WORKERS, 4),
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'RC coverage serial',
          include: [...SERIAL_LANE],
          exclude: EXCLUDE,
          fileParallelism: false,
          sequence: { groupOrder: 2 },
        },
      },
    ],
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
