import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: mocks.spawnSync,
}));

import { senseSecurityScan } from '../../src/security-scan.js';

const root = '/fixture/security-scan';
const now = '2026-09-08T00:00:00.000Z';

type SpawnResult = {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: NodeJS.ErrnoException;
};

function okJson(value: unknown): SpawnResult {
  return { status: 0, signal: null, stdout: JSON.stringify(value), stderr: '' };
}

function spawnError(code: 'EACCES' | 'ENOENT', message: string): SpawnResult {
  return {
    status: null,
    signal: null,
    error: Object.assign(new Error(message), { code }),
  };
}

function keyedSpawn(handlers: Readonly<Record<string, SpawnResult>>): void {
  mocks.spawnSync.mockClear();
  mocks.spawnSync.mockImplementation((command: string) => {
    const result = handlers[command];
    if (result === undefined) throw new Error(`unexpected audit command: ${command}`);
    return result;
  });
}

function calls(): string[] {
  return mocks.spawnSync.mock.calls.map(([command]) => command as string);
}

afterEach(() => {
  mocks.spawnSync.mockReset();
});

describe('security scan mutation boundaries', () => {
  it('keeps the preferred audit argv, cwd, timeout, and controlled environment', () => {
    const marker = process.env.DEVAI_SENSOR_ENV_MARKER;
    process.env.DEVAI_SENSOR_ENV_MARKER = 'present';
    try {
      keyedSpawn({
        pnpm: okJson({ metadata: { vulnerabilities: {} } }),
      });

      const reading = senseSecurityScan({ repoRoot: root, preferredTool: 'pnpm', now });

      expect(reading.status).toBe('pass');
      expect(mocks.spawnSync).toHaveBeenCalledWith(
        'pnpm',
        ['audit', '--json'],
        expect.objectContaining({
          cwd: root,
          encoding: 'utf8',
          timeout: 60_000,
          env: expect.objectContaining({ DEVAI_SENSOR_ENV_MARKER: 'present' }),
        }),
      );
    } finally {
      if (marker === undefined) delete process.env.DEVAI_SENSOR_ENV_MARKER;
      else process.env.DEVAI_SENSOR_ENV_MARKER = marker;
    }
  });

  it('distinguishes generic audit errors from missing binaries', () => {
    keyedSpawn({
      pnpm: spawnError('EACCES', 'permission denied'),
      npm: spawnError('EACCES', 'permission denied'),
    });
    const generic = senseSecurityScan({ repoRoot: root, now });
    expect(generic).toMatchObject({
      status: 'unknown',
      metrics: { tools_tried: 2 },
    });
    expect(generic.findings?.[0]?.message).toBe(
      'Neither pnpm nor npm available: npm-error: permission denied',
    );

    keyedSpawn({
      pnpm: spawnError('ENOENT', 'not found'),
      npm: spawnError('ENOENT', 'not found'),
    });
    const missing = senseSecurityScan({ repoRoot: root, now });
    expect(missing.findings?.[0]?.message).toBe('Neither pnpm nor npm available: npm-not-on-path');
  });

  it('preserves every numeric severity count from pnpm metadata', () => {
    keyedSpawn({
      pnpm: okJson({
        metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 2, low: 3, info: 4 } },
      }),
    });

    const reading = senseSecurityScan({ repoRoot: root, now });

    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({
      total_vulnerabilities: 9,
      moderate: 2,
      low: 3,
      info: 4,
    });
  });

  it('selects the alternate fallback and counts npm v2 info advisories', () => {
    keyedSpawn({
      npm: spawnError('EACCES', 'permission denied'),
      pnpm: okJson({ metadata: { vulnerabilities: {} } }),
    });
    const npmPreferred = senseSecurityScan({ repoRoot: root, preferredTool: 'npm', now });
    expect(calls()).toEqual(['npm', 'pnpm']);
    expect(npmPreferred.command).toBe('pnpm audit --json');
    expect(npmPreferred.status).toBe('pass');

    keyedSpawn({
      pnpm: spawnError('EACCES', 'permission denied'),
      npm: okJson({ vulnerabilities: { pkg: { severity: 'info' } } }),
    });
    const pnpmPreferred = senseSecurityScan({ repoRoot: root, preferredTool: 'pnpm', now });
    expect(calls()).toEqual(['pnpm', 'npm']);
    expect(pnpmPreferred).toMatchObject({
      status: 'pass',
      metrics: { info: 1, total_vulnerabilities: 1 },
    });
  });

  it('keeps the review threshold strict at equality', () => {
    keyedSpawn({
      pnpm: okJson({ metadata: { vulnerabilities: { critical: 0, high: 5 } } }),
    });

    const reading = senseSecurityScan({
      repoRoot: root,
      thresholds: { passMaxHigh: 0, reviewMaxHigh: 5 },
      now,
    });

    expect(reading.status).toBe('review');
    expect(reading.findings?.[0]?.code).toBe('SECURITY_SCAN_HIGH_PRESENT');
    expect(reading.metrics?.high).toBe(5);
    expect(reading.findings?.[0]?.message).toContain('above PASS threshold 0');
  });
});
