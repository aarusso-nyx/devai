import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: mocks.spawnSync,
}));

import { senseSecurityScan } from '../../src/security-scan.js';

const repoRoot = '/tmp/security-scan-shape-boundaries';
const now = '2026-09-09T00:00:00.000Z';

function audit(data: unknown): {
  status: number;
  signal: null;
  stdout: string;
  stderr: string;
  error: undefined;
} {
  return { status: 0, signal: null, stdout: JSON.stringify(data), stderr: '', error: undefined };
}

beforeEach(() => mocks.spawnSync.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('security scan audit shape boundaries', () => {
  it('falls back to the top-level npm shape when metadata is null', () => {
    mocks.spawnSync.mockReturnValueOnce(
      audit({ metadata: null, vulnerabilities: { vite: { severity: 'high' } } }),
    );

    const reading = senseSecurityScan({ repoRoot, now });

    expect(reading).toMatchObject({
      status: 'review',
      command: 'pnpm audit --json',
      timestamp: now,
      metrics: {
        tool: 'pnpm',
        total_vulnerabilities: 1,
        critical: 0,
        high: 1,
        moderate: 0,
        low: 0,
        info: 0,
      },
      findings: [
        {
          severity: 'warning',
          code: 'SECURITY_SCAN_HIGH_PRESENT',
          message: '1 high-severity vulnerability (above PASS threshold 0).',
        },
      ],
    });
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      'pnpm',
      ['audit', '--json'],
      expect.objectContaining({ cwd: repoRoot }),
    );
  });

  it.each([undefined, null])(
    'treats a null metadata summary and %s fallback as empty',
    (vulnerabilities) => {
      mocks.spawnSync.mockReturnValueOnce(
        audit({ metadata: { vulnerabilities: null }, vulnerabilities }),
      );

      const reading = senseSecurityScan({ repoRoot, now });

      expect(reading).toMatchObject({
        status: 'pass',
        metrics: {
          tool: 'pnpm',
          total_vulnerabilities: 0,
          critical: 0,
          high: 0,
          moderate: 0,
          low: 0,
          info: 0,
        },
        findings: [],
      });
    },
  );

  it('uses the top-level population when metadata counts have a primitive shape', () => {
    mocks.spawnSync.mockReturnValueOnce(
      audit({
        metadata: { vulnerabilities: 7 },
        vulnerabilities: { dependency: { severity: 'high' } },
      }),
    );
    const reading = senseSecurityScan({ repoRoot, now });
    expect(reading.status).toBe('review');
    expect(reading.metrics).toMatchObject({ total_vulnerabilities: 1, high: 1 });
  });

  it('uses the npm fallback shape only when its vulnerability map is an object', () => {
    mocks.spawnSync.mockReturnValueOnce(
      audit({ vulnerabilities: { lodash: { severity: 'moderate' }, eslint: { severity: 'low' } } }),
    );

    const reading = senseSecurityScan({ repoRoot, now });

    expect(reading).toMatchObject({
      status: 'pass',
      command: 'pnpm audit --json',
      metrics: {
        total_vulnerabilities: 2,
        critical: 0,
        high: 0,
        moderate: 1,
        low: 1,
        info: 0,
      },
      findings: [],
    });
  });

  it('ignores null and primitive vulnerability members while counting valid severities', () => {
    mocks.spawnSync.mockReturnValueOnce(
      audit({
        vulnerabilities: {
          missing: null,
          malformed: 'high',
          high: { severity: 'high' },
          info: { severity: 'info' },
        },
      }),
    );

    const reading = senseSecurityScan({ repoRoot, now });

    expect(reading).toMatchObject({
      status: 'review',
      metrics: {
        total_vulnerabilities: 2,
        critical: 0,
        high: 1,
        moderate: 0,
        low: 0,
        info: 1,
      },
      findings: [
        {
          severity: 'warning',
          code: 'SECURITY_SCAN_HIGH_PRESENT',
        },
      ],
    });
  });
});
