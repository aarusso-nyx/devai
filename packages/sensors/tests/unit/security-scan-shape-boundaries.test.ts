// Invariants: INV-DEVAI-012; CMP-0006 TASK-0622 / issue #233.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: mocks.spawnSync,
}));

import { senseSecurityScan } from '../../src/security-scan.js';

const repoRoot = '/tmp/security-scan-shape-boundaries';
const now = '2026-09-09T00:00:00.000Z';

function audit(
  data: unknown,
  status = 0,
): {
  status: number;
  signal: null;
  stdout: string;
  stderr: string;
  error: undefined;
} {
  return { status, signal: null, stdout: JSON.stringify(data), stderr: '', error: undefined };
}

beforeEach(() =>
  mocks.spawnSync.mockReset().mockReturnValue({
    status: null,
    signal: null,
    stdout: '',
    stderr: '',
    error: Object.assign(new Error('alternate audit tool absent'), { code: 'ENOENT' }),
  }),
);
afterEach(() => vi.restoreAllMocks());

describe('security scan audit shape boundaries', () => {
  it('falls back to the top-level npm shape when metadata is null', () => {
    mocks.spawnSync.mockReturnValueOnce(
      audit({ metadata: null, vulnerabilities: { vite: { severity: 'high' } } }, 1),
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
    'rejects a null metadata summary and %s fallback as incomplete evidence',
    (vulnerabilities) => {
      mocks.spawnSync.mockReturnValueOnce(
        audit({ metadata: { vulnerabilities: null }, vulnerabilities }),
      );

      const reading = senseSecurityScan({ repoRoot, now });

      expect(reading.status).toBe('unknown');
      expect(reading.findings?.length).toBeGreaterThan(0);
      expect(reading.timestamp).toBe(now);
      expect(mocks.spawnSync.mock.calls.map(([tool]) => tool)).toEqual(['pnpm', 'npm']);
    },
  );

  it('uses the top-level population when metadata counts have a primitive shape', () => {
    mocks.spawnSync.mockReturnValueOnce(
      audit(
        {
          metadata: { vulnerabilities: 7 },
          vulnerabilities: { dependency: { severity: 'high' } },
        },
        1,
      ),
    );
    const reading = senseSecurityScan({ repoRoot, now });
    expect(reading.status).toBe('review');
    expect(reading.metrics).toMatchObject({ total_vulnerabilities: 1, high: 1 });
  });

  it('uses the npm fallback shape only when its vulnerability map is an object', () => {
    mocks.spawnSync.mockReturnValueOnce(
      audit(
        { vulnerabilities: { lodash: { severity: 'moderate' }, eslint: { severity: 'low' } } },
        1,
      ),
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

  it('counts valid severities and rejects null and primitive members rather than discarding them', () => {
    mocks.spawnSync.mockReturnValueOnce(
      audit(
        {
          vulnerabilities: {
            high: { severity: 'high' },
            info: { severity: 'info' },
          },
        },
        1,
      ),
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

    for (const invalidMembers of [
      { missing: null },
      { malformed: 'high' },
      { missing: null, malformed: 'high' },
    ]) {
      mocks.spawnSync.mockReturnValueOnce(
        audit(
          {
            vulnerabilities: {
              high: { severity: 'high' },
              info: { severity: 'info' },
              ...invalidMembers,
            },
          },
          1,
        ),
      );
      const rejected = senseSecurityScan({ repoRoot, now });
      expect(rejected.status).toBe('unknown');
      expect(rejected.findings?.length).toBeGreaterThan(0);
    }
  });
});
