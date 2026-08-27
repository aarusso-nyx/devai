import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export const LOCAL_INCLUDE = [
  'packages/*/tests/**/*.test.ts',
  'packages/*/tests/**/*.spec.ts',
  'tests/contract/**/*.test.ts',
  'tests/integration/**/*.test.ts',
] as const;

/**
 * Much of this suite is subprocess-integration work wearing a unit-test path:
 * a single case can fork ten to twenty-five `git` and `node` processes. Vitest's
 * 5s default is calibrated for in-process unit tests, and the heaviest file here
 * has a ~3s median case — so the default leaves the top decile timing out under
 * load even though nothing is nondeterministic. The RC coverage lane already
 * raised its own timeout for the same reason.
 *
 * A high ceiling costs nothing while tests pass; it only bounds a genuine hang.
 * It weakens no assertion and skips nothing.
 */
export const SUBPROCESS_TEST_TIMEOUT_MS = 30_000;

/**
 * One worker per logical CPU oversubscribes a hybrid machine, because each
 * worker then forks subprocesses of its own. Halving approximates the
 * performance-core count without hardcoding one machine's topology, and
 * measured near-identical wall time while removing most timeout failures.
 */
export const MAX_TEST_WORKERS = Math.max(2, Math.floor(availableParallelism() / 2));

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
    testTimeout: SUBPROCESS_TEST_TIMEOUT_MS,
    hookTimeout: SUBPROCESS_TEST_TIMEOUT_MS,
    maxWorkers: MAX_TEST_WORKERS,
  },
});
