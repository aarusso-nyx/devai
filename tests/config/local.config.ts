import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export const LOCAL_INCLUDE = [
  'packages/*/tests/**/*.test.ts',
  'packages/*/tests/**/*.spec.ts',
  'tests/contract/**/*.test.ts',
  'tests/integration/**/*.test.ts',
] as const;

export const RC_ONLY = [
  'packages/authority/tests/unit/authority-resource-boundaries.red.test.ts',
  'packages/skills/tests/recipes/adapters.test.ts',
  'tests/integration/authority-effect-postgres.db.test.ts',
  'tests/integration/runtime-probe-data.integration.test.ts',
] as const;

export default defineConfig({
  resolve: {
    alias: { '#runtime-core': resolve('packages/cli/src/runtime-core.ts') },
  },
  test: {
    name: 'local',
    environment: 'node',
    include: [...LOCAL_INCLUDE],
    exclude: ['**/node_modules/**', '**/dist/**', ...RC_ONLY],
    passWithNoTests: false,
  },
});
