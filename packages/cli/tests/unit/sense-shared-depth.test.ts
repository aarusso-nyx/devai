import type { SensorReading } from '@devai-nyx/sensors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  resolveSensorParams: vi.fn(),
}));

vi.mock('@devai-nyx/authority', () => ({
  mkdirSync: mocks.mkdirSync,
  writeFileSync: mocks.writeFileSync,
}));
vi.mock('@devai-nyx/skills', () => ({ resolveSensorParams: mocks.resolveSensorParams }));

import {
  DEFAULT_REPO_ROOT,
  emit,
  exitFor,
  finishInventorySenseCommand,
  finishSenseCommand,
  maybeResolvePackParams,
  persistSensorReading,
} from '../../src/commands/sense/shared.js';

function reading(status: SensorReading['status'] = 'pass'): SensorReading {
  return {
    id: 'SR-fixture',
    sensor: { name: 'fixture', kind: 'fixture', version: '1.0.0' },
    status,
    duration_ms: 17,
    findings: [
      { severity: 'warning', code: 'WITH_LINE', message: 'first', file: 'a.ts', line: 4 },
      { severity: 'info', code: 'WITHOUT_LINE', message: 'second', file: 'b.ts' },
      { severity: 'info', code: 'WITHOUT_FILE', message: 'third' },
    ],
  } as unknown as SensorReading;
}

const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe('sense shared command boundaries', () => {
  it('resolves pack parameters only when explicitly selected and forwards exact selectors', () => {
    expect(DEFAULT_REPO_ROOT).toBe('.');
    expect(maybeResolvePackParams('inventory', '/adopter', {})).toEqual({});
    expect(maybeResolvePackParams('inventory', '/adopter', { packTune: false })).toEqual({});
    expect(mocks.resolveSensorParams).not.toHaveBeenCalled();

    mocks.resolveSensorParams.mockReturnValue({ params: { mode: 'strict' } });
    expect(
      maybeResolvePackParams('inventory', '/adopter', {
        packTune: true,
        packId: 'pack-a',
        packsRoot: '/packs',
      }),
    ).toEqual({ mode: 'strict' });
    expect(mocks.resolveSensorParams).toHaveBeenCalledWith({
      adopterRoot: '/adopter',
      sensorKind: 'inventory',
      packsRoot: '/packs',
      explicitId: 'pack-a',
    });

    mocks.resolveSensorParams.mockReturnValue(undefined);
    expect(maybeResolvePackParams('inventory', '/adopter', { packId: 'pack-b' })).toEqual({});
    expect(mocks.resolveSensorParams).toHaveBeenLastCalledWith({
      adopterRoot: '/adopter',
      sensorKind: 'inventory',
      explicitId: 'pack-b',
    });

    mocks.resolveSensorParams.mockReturnValue({ params: { source: 'pin' } });
    expect(
      maybeResolvePackParams('inventory', '/adopter', { packTune: false, packId: 'pack-c' }),
    ).toEqual({ source: 'pin' });
    expect(mocks.resolveSensorParams).toHaveBeenLastCalledWith({
      adopterRoot: '/adopter',
      sensorKind: 'inventory',
      explicitId: 'pack-c',
    });

    mocks.resolveSensorParams.mockReturnValue({ params: {} });
    maybeResolvePackParams('inventory', '/adopter', { packTune: true });
    expect(mocks.resolveSensorParams).toHaveBeenLastCalledWith({
      adopterRoot: '/adopter',
      sensorKind: 'inventory',
    });
    const unpinnedCall = mocks.resolveSensorParams.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(unpinnedCall, 'packsRoot')).toBe(false);
    expect(Object.hasOwn(unpinnedCall, 'explicitId')).toBe(false);
  });

  it.each([
    ['pass', 0],
    ['skipped', 0],
    ['unknown', 0],
    ['review', 0],
    ['fail', 3],
    ['error', 6],
    ['killed', 6],
  ] as const)('maps %s to exit code %s', (status, expected) => {
    expect(exitFor(status)).toBe(expected);
  });

  it('renders exact JSON and detailed human findings', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const value = reading();
    emit(value, false);
    expect(stdout).toHaveBeenLastCalledWith(`${JSON.stringify(value)}\n`);

    emit(value, true);
    expect(stdout).toHaveBeenLastCalledWith(
      'fixture [fixture]: PASS (17ms)\n' +
        '  [warning] WITH_LINE: first (a.ts:4)\n' +
        '  [info] WITHOUT_LINE: second (b.ts)\n' +
        '  [info] WITHOUT_FILE: third\n',
    );

    emit({ ...value, duration_ms: undefined, findings: undefined } as SensorReading, true);
    expect(stdout).toHaveBeenLastCalledWith('fixture [fixture]: PASS\n');
  });

  it('persists canonical reading bytes and reports both Error and opaque write failures', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const value = reading();
    expect(persistSensorReading(value, '/repo')).toBe(
      '/repo/.devai/state/sensor-readings/fixture/SR-fixture.json',
    );
    expect(mocks.mkdirSync).toHaveBeenCalledWith('/repo/.devai/state/sensor-readings/fixture', {
      recursive: true,
    });
    expect(mocks.writeFileSync).toHaveBeenCalledWith(
      '/repo/.devai/state/sensor-readings/fixture/SR-fixture.json',
      `${JSON.stringify(value, null, 2)}\n`,
    );

    mocks.mkdirSync.mockImplementationOnce(() => {
      throw new Error('read only');
    });
    persistSensorReading(value, '/repo');
    expect(stderr).toHaveBeenLastCalledWith(
      'warning: failed to persist SensorReading to /repo/.devai/state/sensor-readings/fixture/SR-fixture.json: read only\n',
    );

    mocks.mkdirSync.mockImplementationOnce(() => {
      throw 'opaque';
    });
    persistSensorReading(value, '/repo');
    expect(stderr).toHaveBeenLastCalledWith(
      'warning: failed to persist SensorReading to /repo/.devai/state/sensor-readings/fixture/SR-fixture.json: opaque\n',
    );
  });

  it('finishes ordinary and inventory readings without implicit persistence', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const value = reading('review');
    finishSenseCommand(value, { repoRoot: '/repo' });
    expect(stdout).toHaveBeenLastCalledWith(`${JSON.stringify(value)}\n`);
    expect(process.exitCode).toBe(0);
    expect(mocks.writeFileSync).not.toHaveBeenCalled();

    const body = { entries: [1, 2] };
    finishInventorySenseCommand(value, body, { repoRoot: '/repo' });
    expect(stdout).toHaveBeenLastCalledWith(`${JSON.stringify(value)}\n`);

    finishInventorySenseCommand(reading('fail'), body, { repoRoot: '/repo', output: 'body' });
    expect(stdout).toHaveBeenLastCalledWith(`${JSON.stringify(body)}\n`);
    expect(process.exitCode).toBe(3);

    finishInventorySenseCommand(reading('error'), body, {
      repoRoot: '/repo',
      output: 'reading',
      human: true,
    });
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining('fixture [fixture]: ERROR'));
    expect(process.exitCode).toBe(6);
  });

  it.each([
    [{ output: 'xml' }, "sense inventory: --output must be 'reading' or 'body' (got 'xml')\n"],
    [
      { output: 'body', human: true },
      'sense inventory: --output body cannot be combined with --format human\n',
    ],
  ] as const)('fails closed for invalid inventory output options', (options, message) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('EXIT_CALLED');
    }) as never);
    expect(() =>
      finishInventorySenseCommand(reading(), {}, { repoRoot: '/repo', ...options }),
    ).toThrow('EXIT_CALLED');
    expect(stderr).toHaveBeenLastCalledWith(message);
    expect(exit).toHaveBeenCalledWith(2);
  });

  it('activates static exports through a fresh module instance', async () => {
    vi.resetModules();
    // @ts-expect-error the query creates a distinct ESM identity for static mutation activation
    const fresh = await import('../../src/commands/sense/shared.js?fresh-sense-shared-depth');
    expect(fresh.DEFAULT_REPO_ROOT).toBe('.');
  });
});
