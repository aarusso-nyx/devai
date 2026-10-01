// ADR-SCR-0007, Inspector Adversarial Acceptance IA-002, IA-003 and IA-005, on the CLI side.
//
// IA-002: under `sense run` the broker admits the governed e2e configuration
// (tests/config/rc.e2e.config.ts) and the local coverage producer
// (tests/config/local.coverage.config.ts) in the template shape
// `pnpm vitest run --config <governed-config> [<test-path>]`; an argv naming a configuration
// outside the governed list, or appending a path outside tests/, is refused before vitest
// starts, and the refusal names the argv.
//
// IA-003: package.json carries `test:coverage:local` for the local producer, and the
// descriptor check still passes on the checkout once the descriptor follows.
//
// IA-005: the RC lane is unchanged: `test:coverage:rc` still runs rc.coverage.config.ts, its
// descriptor node still declares DEVAI_DB_TESTS, and the configuration still refuses to load
// without DEVAI_DB_TESTS=1, with CHECK_RC_DB_TESTS_REQUIRED.
//
// Interface assumptions: `createAuthorityHostBroker` from src/authority/broker.ts as the
// existing broker tests use it. A refusal names the argv either in its message or in an
// `argv` field of its `context` (TASK-0416 chooses). No test here spawns vitest.
import type { AuthorityHostEffectRequest } from '@devai-nyx/authority';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthorityHostBroker } from '../../src/authority/broker.js';
import { canonicalRegistry } from '../../src/define-command.js';
import { resolveCliVersion } from '../../src/version.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const entries = canonicalRegistry();
const senseRun = (() => {
  const entry = entries.find((candidate) => candidate.name === 'sense run');
  if (entry === undefined) throw new Error('missing action sense run');
  return entry;
})();

const E2E_CONFIG = 'tests/config/rc.e2e.config.ts';
const LOCAL_COVERAGE_CONFIG = 'tests/config/local.coverage.config.ts';

function effect(executable: string, args: readonly string[]): AuthorityHostEffectRequest {
  return { kind: 'process', symbol: 'spawnSync', arguments: [executable, [...args]] };
}

interface Attempt {
  readonly started: boolean;
  readonly error: unknown;
}

/** Ask the sense-run broker to start a process; `started` is whether the spawn ran. */
function attempt(kind: string, executable: string, args: readonly string[]): Attempt {
  const host = createAuthorityHostBroker({
    entry: senseRun,
    entries,
    argv: [process.execPath, 'devai', 'sense', 'run', kind],
    role: 'inspector',
    declaration: { as_role: 'inspector' },
    repository_root: ROOT,
    package_version: resolveCliVersion(),
    bootstrap_policy: true,
  });
  const spawn = vi.fn(() => 'started');
  try {
    host.scope.apply_effect(effect(executable, args), spawn);
    return { started: spawn.mock.calls.length > 0, error: undefined };
  } catch (error) {
    return { started: spawn.mock.calls.length > 0, error };
  } finally {
    host.dispose();
  }
}

function refusalText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const context = (error as Error & { context?: unknown }).context;
  return `${error.message} ${context === undefined ? '' : JSON.stringify(context)}`;
}

describe('the broker admits the governed e2e and local coverage configurations (IA-002)', () => {
  it.each([
    ['e2e_test', ['vitest', 'run', '--config', E2E_CONFIG]],
    ['test_coverage_depth', ['vitest', 'run', '--config', LOCAL_COVERAGE_CONFIG]],
  ] as const)('admits %s: pnpm %j', (kind, args) => {
    const result = attempt(kind, 'pnpm', args);
    expect(result.error).toBeUndefined();
    expect(result.started).toBe(true);
  });

  it('still admits the configurations it already governed', () => {
    const result = attempt('perf_test', 'pnpm', [
      'vitest',
      'run',
      '--config',
      'tests/config/rc.performance.config.ts',
      'tests/regression',
    ]);
    expect(result.error).toBeUndefined();
    expect(result.started).toBe(true);
  });

  it.each([
    [
      'a configuration outside the governed list',
      ['vitest', 'run', '--config', 'tests/config/rc.coverage.config.ts'],
    ],
    [
      'the RC database configuration',
      ['vitest', 'run', '--config', 'tests/config/rc.db.config.ts'],
    ],
    [
      'a parent-segment path after the governed e2e configuration',
      ['vitest', 'run', '--config', E2E_CONFIG, '../tests/e2e'],
    ],
    [
      'a path outside tests/ after the governed e2e configuration',
      ['vitest', 'run', '--config', E2E_CONFIG, 'packages/cli'],
    ],
    [
      'an absolute path after the local coverage configuration',
      ['vitest', 'run', '--config', LOCAL_COVERAGE_CONFIG, '/tmp/tests'],
    ],
    [
      'an option after the governed e2e configuration',
      ['vitest', 'run', '--config', E2E_CONFIG, '--coverage.enabled=false'],
    ],
    [
      'a dot-prefixed spelling of the governed e2e configuration',
      ['vitest', 'run', '--config', `./${E2E_CONFIG}`],
    ],
  ] as const)('refuses %s before vitest starts', (_label, args) => {
    const result = attempt('e2e_test', 'pnpm', args);
    expect(result.started).toBe(false);
    expect(refusalText(result.error)).toContain('AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED');
  });

  it.each([
    [
      ['vitest', 'run', '--config', 'tests/config/rc.coverage.config.ts'],
      'tests/config/rc.coverage.config.ts',
    ],
    [['vitest', 'run', '--config', E2E_CONFIG, '../tests/e2e'], '../tests/e2e'],
  ] as const)('names the refused argv %j', (args, named) => {
    const result = attempt('e2e_test', 'pnpm', args);
    expect(result.started).toBe(false);
    expect(refusalText(result.error)).toContain(named);
  });

  it('refuses a bare package script for the local producer', () => {
    for (const args of [['test:coverage:local'], ['run', 'test:coverage:local']]) {
      const result = attempt('test_coverage_depth', 'pnpm', args);
      expect(result.started).toBe(false);
      expect(refusalText(result.error)).toContain('AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED');
    }
  });
});

interface RootManifest {
  readonly scripts: Readonly<Record<string, string>>;
}
interface DescriptorTask {
  readonly nodeId: string;
  readonly argv?: readonly string[];
  readonly allowlistedEnv?: readonly string[];
  readonly inputSelectors?: readonly { readonly kind: string; readonly pattern: string }[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as T;
}

describe('the local producer script and the descriptor (IA-003)', () => {
  const manifest = readJson<RootManifest>('package.json');

  it('carries test:coverage:local for the local producer, with no database gate', () => {
    expect(manifest.scripts['test:coverage:local']).toBe(
      `vitest run --config ${LOCAL_COVERAGE_CONFIG}`,
    );
  });

  it('keeps pnpm test and the local suites on tests/config/local.config.ts', () => {
    expect(manifest.scripts['test']).toBe('pnpm run test:local');
    expect(manifest.scripts['test:local']).toBe('vitest run --config tests/config/local.config.ts');
    expect(manifest.scripts['test:e2e:rc']).toBe(`vitest run --config ${E2E_CONFIG}`);
  });

  it('keeps tests/config/ among the root suite selectors so the producer is in a closure', () => {
    const descriptor = readJson<{ readonly tasks: readonly DescriptorTask[] }>('test-tasks.json');
    const rootSuite = descriptor.tasks.find((task) => task.nodeId === 'test:root');
    expect(rootSuite?.inputSelectors).toContainEqual({ kind: 'prefix', pattern: 'tests/config/' });
  });

  it('passes the descriptor check on the checkout', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/check-test-task-workspace-selectors.mjs', '--check'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/test task workspace selectors: PASS/u);
  });
});

describe('the RC lane still refuses without DEVAI_DB_TESTS (IA-005)', () => {
  const previous = process.env['DEVAI_DB_TESTS'];
  afterEach(() => {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'DEVAI_DB_TESTS');
    else process.env['DEVAI_DB_TESTS'] = previous;
    vi.resetModules();
  });

  it('keeps test:coverage:rc on the RC configuration with DEVAI_DB_TESTS declared', () => {
    const manifest = readJson<RootManifest>('package.json');
    expect(manifest.scripts['test:coverage:rc']).toBe(
      'vitest run --config tests/config/rc.coverage.config.ts',
    );
    const descriptor = readJson<{ readonly tasks: readonly DescriptorTask[] }>('test-tasks.json');
    const rcCoverage = descriptor.tasks.find((task) => task.nodeId === 'test:coverage:rc');
    expect(rcCoverage?.allowlistedEnv).toContain('DEVAI_DB_TESTS');
  });

  it('refuses to load the RC coverage configuration with CHECK_RC_DB_TESTS_REQUIRED', async () => {
    Reflect.deleteProperty(process.env, 'DEVAI_DB_TESTS');
    vi.resetModules();
    await expect(import('../../../../tests/config/rc.coverage.config.js')).rejects.toThrow(
      /CHECK_RC_DB_TESTS_REQUIRED/u,
    );
  });

  it('loads the local coverage configuration without DEVAI_DB_TESTS', async () => {
    Reflect.deleteProperty(process.env, 'DEVAI_DB_TESTS');
    vi.resetModules();
    const loaded = (await import('../../../../tests/config/local.coverage.config.js')) as {
      readonly default: { readonly test?: { readonly name?: unknown } };
    };
    expect(loaded.default.test?.name).toBe('local coverage');
  });
});
