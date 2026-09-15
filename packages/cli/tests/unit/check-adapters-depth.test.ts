// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
// Inspector acceptance: check-member adapters must preserve exact subprocess
// outcomes, bounded execution parameters, and delegated service verdicts.
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';

type ProcessResult = {
  readonly status: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
};

const boundary = vi.hoisted(() => ({
  processResult: { status: 0, stdout: '', stderr: '' } as ProcessResult,
  spawnSync: vi.fn(),
  senseBuild: vi.fn(),
  senseLint: vi.fn(),
  senseTypeCheck: vi.fn(),
  senseTest: vi.fn(),
  runCheckTasks: vi.fn(),
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: boundary.spawnSync,
}));

vi.mock('@devai-nyx/sensors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/sensors')>()),
  senseBuild: boundary.senseBuild,
  senseLint: boundary.senseLint,
  senseTypeCheck: boundary.senseTypeCheck,
  senseTest: boundary.senseTest,
}));

vi.mock('../../src/services/check-runner/index.js', () => ({
  runCheckTasks: boundary.runCheckTasks,
}));

import { executeCheckMember } from '../../src/commands/check/adapters.js';
import type {
  CheckCost,
  CheckStatus,
  ResolvedCheckMember,
} from '../../src/commands/check/contracts.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const ORIGINAL_ENV = process.env;

function member(
  serviceId: string,
  cost: CheckCost = 'low',
  effect: ResolvedCheckMember['effect'] = 'read',
): ResolvedCheckMember {
  return {
    id: `member-${serviceId}`,
    source: 'current-selector',
    service_id: serviceId,
    binding: { kind: 'runtime-gate', gate_id: `check-${serviceId}` },
    effect,
    cost,
    output: `action-envelope-plus-${serviceId}-report`,
  };
}

async function execute(serviceId: string, cost: CheckCost = 'low') {
  return withAuthorityHostTestScope(() =>
    executeCheckMember(member(serviceId, cost), { repoRoot: ROOT }),
  );
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, DEVAI_CHECK_ADAPTER_DEPTH: 'present' };
  boundary.processResult = { status: 0, stdout: '', stderr: '' };
  boundary.spawnSync.mockReset();
  boundary.spawnSync.mockImplementation(() => boundary.processResult);
  boundary.senseBuild.mockReset();
  boundary.senseLint.mockReset();
  boundary.senseTypeCheck.mockReset();
  boundary.senseTest.mockReset();
  boundary.runCheckTasks.mockReset();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe('check adapter subprocess boundaries', () => {
  it.each([
    ['low', 120_000],
    ['medium', 600_000],
    ['high', 3_600_000],
  ] as const)('uses the exact argv and %s-cost timeout', async (cost, timeout) => {
    boundary.processResult = {
      status: 0,
      stdout: '{"status":"pass","detail":"kept"}\n',
      stderr: 'diagnostic\n',
    };

    const result = await execute('full-tests', cost);

    expect(result).toMatchObject({
      id: 'member-full-tests',
      status: 'pass',
      effect: 'read',
      binding: { kind: 'runtime-gate', gate_id: 'check-full-tests' },
      value: { status: 'pass', detail: 'kept' },
      stdout: '{"status":"pass","detail":"kept"}\n',
      stderr: 'diagnostic\n',
      exit_code: 0,
      duration_ms: expect.any(Number),
    });
    expect(boundary.spawnSync).toHaveBeenCalledOnce();
    expect(boundary.spawnSync).toHaveBeenCalledWith(
      'pnpm',
      ['vitest', 'run'],
      expect.objectContaining({
        cwd: ROOT,
        encoding: 'utf8',
        shell: false,
        timeout,
        env: process.env,
      }),
    );
  });

  it.each([
    [null, '{"status":"pass"}', 'error', 'CHECK_PROCESS_NO_EXIT'],
    [0, 'plain text', 'pass', undefined],
    [0, '{"verdict":"GREEN"}', 'pass', undefined],
    [0, '{"status":"crash"}', 'error', undefined],
    [4, '{"status":"crash"}', 'error', undefined],
    [4, '{"status":"review"}', 'review', undefined],
    [4, '{"status":"pass"}', 'fail', undefined],
    [4, 'not json', 'fail', undefined],
  ] as const)(
    'maps process exit %s with output %s to %s',
    async (status, stdout, expectedStatus, code) => {
      boundary.processResult = { status, stdout, stderr: 'stderr retained' };

      const result = await execute('full-tests');

      expect(result).toMatchObject({
        status: expectedStatus,
        exit_code: status,
        stdout,
        stderr: 'stderr retained',
        ...(code === undefined ? {} : { code }),
      });
      if (status !== null && stdout.startsWith('{'))
        expect(result.value).toEqual(JSON.parse(stdout));
      else expect(result).not.toHaveProperty('value');
    },
  );

  it('normalizes absent child output streams to retained empty strings', async () => {
    boundary.processResult = { status: 0 };

    await expect(execute('full-tests')).resolves.toMatchObject({
      status: 'pass',
      stdout: '',
      stderr: '',
      exit_code: 0,
    });
  });
});

describe('check adapter direct-service verdicts', () => {
  it.each([
    ['pass', 'pass'],
    ['green', 'pass'],
    ['valid', 'pass'],
    ['warn', 'review'],
    ['review', 'review'],
    ['amber', 'review'],
    ['yellow', 'review'],
    ['fail', 'fail'],
    ['block', 'fail'],
    ['red', 'fail'],
    ['invalid', 'fail'],
    ['unknown', 'unknown'],
    ['inconclusive', 'unknown'],
    ['na', 'na'],
    ['n/a', 'na'],
    ['skipped', 'na'],
    ['error', 'error'],
    ['killed', 'error'],
    ['crash', 'error'],
    ['unregistered', 'error'],
  ] as const)('normalizes status %s to %s', async (raw, expected) => {
    const value = { status: raw, marker: 'preserved' };
    boundary.senseBuild.mockReturnValueOnce(value);

    await expect(execute('build')).resolves.toMatchObject({
      status: expected,
      value,
    });
    expect(boundary.senseBuild).toHaveBeenCalledWith({ cwd: ROOT });
  });

  it.each([
    [{ verdict: 'VALID' }, 'pass'],
    [{ verdict: 'AMBER' }, 'review'],
    [{ verdict: 'RED' }, 'fail'],
    [{ ok: true }, 'pass'],
    [{ ok: false }, 'fail'],
    [{ valid: true }, 'pass'],
    [{ valid: false }, 'fail'],
    [{ other: 'value' }, 'pass'],
    [null, 'pass'],
    [['not', 'a', 'record'], 'pass'],
  ] as const)('derives %s as %s while retaining the value', async (value, expected) => {
    boundary.senseLint.mockReturnValueOnce(value);

    await expect(execute('lint')).resolves.toMatchObject({
      status: expected as CheckStatus,
      value,
    });
    expect(boundary.senseLint).toHaveBeenCalledWith({ cwd: ROOT });
  });

  it('delegates type checking and unit tests with exact inputs', async () => {
    const aggregate = { status: 'yellow', packages: 3 };
    boundary.senseTypeCheck.mockReturnValueOnce({ aggregate });
    boundary.senseTest.mockReturnValueOnce({ ok: false, failed: 2 });

    const typeCheck = await execute('type-check');
    const unitTest = await execute('unit-test');

    expect(typeCheck).toMatchObject({ status: 'review', value: aggregate });
    expect(unitTest).toMatchObject({ status: 'fail', value: { ok: false, failed: 2 } });
    expect(boundary.senseTypeCheck).toHaveBeenCalledWith({ cwd: ROOT, strategy: 'root' });
    expect(boundary.senseTest).toHaveBeenCalledWith({ cwd: ROOT, suite: 'unit' });
  });

  it('selects each ledger target exactly and retains its exit verdict', async () => {
    const local = { exitCode: 0, target: 'local-report' };
    const rc = { exitCode: 2, target: 'rc-report' };
    boundary.runCheckTasks.mockReturnValueOnce(local).mockReturnValueOnce(rc);

    await expect(execute('ledger-local')).resolves.toMatchObject({
      status: 'pass',
      value: local,
      exit_code: 0,
    });
    await expect(execute('ledger-rc')).resolves.toMatchObject({
      status: 'fail',
      value: rc,
      exit_code: 2,
    });
    expect(boundary.runCheckTasks.mock.calls).toEqual([
      [{ repoRoot: ROOT, target: 'local', operation: 'run' }],
      [{ repoRoot: ROOT, target: 'rc', operation: 'run' }],
    ]);
  });

  it('returns a bounded structured error for service exceptions and non-Error throws', async () => {
    boundary.senseBuild.mockImplementationOnce(() => {
      throw new Error('sensor unavailable');
    });
    boundary.senseLint.mockImplementationOnce(() => {
      throw 'literal refusal';
    });

    await expect(execute('build')).resolves.toMatchObject({
      status: 'error',
      code: 'CHECK_SERVICE_ERROR',
      message: 'sensor unavailable',
    });
    await expect(execute('lint')).resolves.toMatchObject({
      status: 'error',
      code: 'CHECK_SERVICE_ERROR',
      message: 'literal refusal',
    });
  });
});
