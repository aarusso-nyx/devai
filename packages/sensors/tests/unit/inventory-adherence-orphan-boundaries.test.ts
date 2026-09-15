import { describe, expect, it } from 'vitest';
import { senseInventoryAdherence } from '../../src/inventory-adherence.js';

const NOW = '2026-09-08T12:00:00.000Z';

describe('inventory adherence orphan boundaries', () => {
  it('passes a fully claimed report and preserves its counts', () => {
    const reading = senseInventoryAdherence({
      report: { counts: { total: 12, claimed: 12, orphan: 0 }, orphans: [] },
      now: NOW,
    });

    expect(reading).toMatchObject({
      status: 'pass',
      timestamp: NOW,
      findings: [],
      metrics: { total_count: 12, claimed_count: 12, orphan_count: 0, max_orphans: 50 },
    });
  });

  it('reviews orphan counts exactly at the configured limit', () => {
    const reading = senseInventoryAdherence({
      report: {
        counts: { total: 10, claimed: 8, orphan: 2 },
        orphans: [
          { kind: 'route', id: 'route-1', file: 'src/routes.ts' },
          { kind: 'table', id: 'accounts', file: 'db/schema.sql' },
        ],
      },
      maxOrphans: 2,
      now: NOW,
    });

    expect(reading).toMatchObject({
      status: 'review',
      timestamp: NOW,
      metrics: { total_count: 10, claimed_count: 8, orphan_count: 2, max_orphans: 2 },
      findings: [
        {
          severity: 'warning',
          code: 'INVENTORY_ADHERENCE_PARTIAL',
          message: '2 plant surfaces are unclaimed by any invariant.code_areas[] (threshold 2).',
        },
        {
          severity: 'info',
          code: 'INVENTORY_ADHERENCE_ORPHAN',
          message: 'Unclaimed route: route-1',
          file: 'src/routes.ts',
        },
        {
          severity: 'info',
          code: 'INVENTORY_ADHERENCE_ORPHAN',
          message: 'Unclaimed table: accounts',
          file: 'db/schema.sql',
        },
      ],
    });
  });

  it('fails when the orphan count exceeds the configured limit', () => {
    const reading = senseInventoryAdherence({
      report: {
        counts: { total: 10, claimed: 7, orphan: 3 },
        orphans: [{ kind: 'route', id: 'route-3' }],
      },
      maxOrphans: 2,
      now: NOW,
    });

    expect(reading).toMatchObject({
      status: 'fail',
      metrics: { total_count: 10, claimed_count: 7, orphan_count: 3, max_orphans: 2 },
      findings: [
        {
          severity: 'error',
          code: 'INVENTORY_ADHERENCE_BELOW_THRESHOLD',
          message: '3 orphans exceed max_orphans=2.',
        },
        {
          severity: 'info',
          code: 'INVENTORY_ADHERENCE_ORPHAN',
          message: 'Unclaimed route: route-3',
        },
      ],
    });
  });

  it('reports at most the first ten orphan details', () => {
    const orphans = Array.from({ length: 12 }, (_, index) => ({
      kind: 'file',
      id: `orphan-${index + 1}`,
      file: `src/file-${index + 1}.ts`,
    }));

    const reading = senseInventoryAdherence({
      report: { counts: { total: 20, claimed: 8, orphan: 12 }, orphans },
      maxOrphans: 10,
      now: NOW,
    });

    const details = reading.findings?.filter(
      (finding) => finding.code === 'INVENTORY_ADHERENCE_ORPHAN',
    );
    expect(reading.status).toBe('fail');
    expect(details).toHaveLength(10);
    expect(details?.[0]).toMatchObject({
      message: 'Unclaimed file: orphan-1',
      file: 'src/file-1.ts',
    });
    expect(details?.[9]).toMatchObject({
      message: 'Unclaimed file: orphan-10',
      file: 'src/file-10.ts',
    });
    expect(details?.some((finding) => finding.message.includes('orphan-11'))).toBe(false);
    expect(details?.some((finding) => finding.message.includes('orphan-12'))).toBe(false);
  });
});
