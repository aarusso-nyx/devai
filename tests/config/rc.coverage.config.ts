import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { LOCAL_INCLUDE } from './local.config.js';

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
    testTimeout: 15_000,
    include: [...LOCAL_INCLUDE, 'tests/e2e/**/*.test.ts', 'tests/regression/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    passWithNoTests: false,
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
