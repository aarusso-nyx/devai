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

/**
 * Files whose cost is a scan of the whole real repository, or a chain of whole-repository
 * subprocesses, rather than a fixture (#246). Measured alone on a loaded eight-core
 * workstation: the decision-record history scan 30 s, the check-adapter sweep 14 s, the
 * preflight lane-parity plans 33 s, the release package staging 30 s, and the local sensor
 * sweep over 100 s. Run beside three other workers that each fork `git` and `node`, they
 * took four to eight times as long and timed out; the ones that read or copy the live
 * tree also saw sibling tests writing into it. They stay in the local population
 * (`LOCAL_INCLUDE`); the `local-serial` project runs them one file at a time after every
 * parallel file has finished, so each competes only with the machine, never with its own
 * suite.
 */
export const SERIAL_LANE = [
  'packages/cli/tests/unit/check-adapters-acceptance.test.ts',
  'packages/cli/tests/unit/release-package-staging.test.ts',
  'packages/cli/tests/unit/sense-adapter-acceptance.test.ts',
  'packages/loop/tests/governance-ledger.test.ts',
  'tests/contract/preflight-lane-parity.contract.test.ts',
] as const;

/**
 * The `--exclude` globs on the Vitest command line. Vitest applies them to a root project
 * but never forwards them to the entries of `projects`, so the lanes below add them
 * themselves; `test:cli` relies on `--exclude **\/release-package-staging.test.ts`.
 */
export function commandLineExcludes(argv: readonly string[] = process.argv): string[] {
  const globs: string[] = [];
  argv.forEach((argument, index) => {
    if (argument === '--exclude') {
      const value = argv[index + 1];
      if (value !== undefined) globs.push(value);
    } else if (argument.startsWith('--exclude=')) globs.push(argument.slice('--exclude='.length));
  });
  return globs;
}

const EXCLUDE = ['**/node_modules/**', '**/dist/**', ...RC_ONLY, ...commandLineExcludes()];

export default defineConfig({
  resolve: {
    alias: {
      '#runtime-core': resolve('packages/cli/src/runtime-core.ts'),
      '@devai-nyx/authority': resolve('packages/authority/src/index.ts'),
    },
    conditions: ['development'],
  },
  test: {
    environment: 'node',
    passWithNoTests: false,
    testTimeout: SUBPROCESS_TEST_TIMEOUT_MS,
    hookTimeout: SUBPROCESS_TEST_TIMEOUT_MS,
    projects: [
      {
        extends: true,
        test: {
          name: 'local',
          include: [...LOCAL_INCLUDE],
          exclude: [...EXCLUDE, ...SERIAL_LANE],
          maxWorkers: MAX_TEST_WORKERS,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'local-serial',
          include: [...SERIAL_LANE],
          exclude: [...EXCLUDE],
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
