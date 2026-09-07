import { describe, expect, it } from 'vitest';
import { recoverValidationLeases } from '../../src/translation-validation/index.js';

function lease(suffix = '0123456789abcdef') {
  return {
    schemaVersion: '1.0.0',
    id: `TVL-${suffix}`,
    task_id: 'TASK-0028',
    worktree_id: `WT-TV-${suffix}`,
    worktree_path: `.devai/worktrees/WT-TV-${suffix}`,
    database: `devai_task_TV_${suffix}`,
    base_sha: 'a'.repeat(40),
    created_at: '2026-09-07T00:00:00.000Z',
  };
}
function host(calls: string[]) {
  return {
    remove_worktree: async (path: string) => {
      calls.push(`remove:${path}`);
    },
    drop_database: async (database: string) => {
      calls.push(`drop:${database}`);
    },
  };
}

describe('translation lease recovery', () => {
  it('uses exact bound resources, in order, and reports recovery only after both operations', async () => {
    const value = lease();
    const calls: string[] = [];
    const result = await recoverValidationLeases({ leases: [value], host: host(calls) });
    expect(calls).toEqual([`remove:${value.worktree_path}`, `drop:${value.database}`]);
    expect(result).toEqual({ status: 'pass', recovered: [value.id], findings: [] });
  });

  it('performs no effects for an empty population', async () => {
    const calls: string[] = [];
    expect(await recoverValidationLeases({ leases: [], host: host(calls) })).toEqual({
      status: 'pass',
      recovered: [],
      findings: [],
    });
    expect(calls).toEqual([]);
  });

  it.each([
    null,
    false,
    17,
    'lease',
    [],
    {},
    { ...lease(), schemaVersion: '2.0.0' },
    { ...lease(), id: 'TVL-0123456789abcdeg' },
    { ...lease(), task_id: 'TASK-123' },
    { ...lease(), worktree_id: 'WT-TV-fedcba9876543210' },
    { ...lease(), worktree_path: '../other' },
    { ...lease(), database: 'production' },
    { ...lease(), base_sha: 'a'.repeat(39) },
    { ...lease(), base_sha: 'G'.repeat(40) },
    { ...lease(), created_at: 'not a timestamp' },
    { ...lease(), created_at: 123 },
  ])('refuses malformed or mismatched lease without calling controls: %j', async (value) => {
    const calls: string[] = [];
    expect(await recoverValidationLeases({ leases: [value], host: host(calls) })).toEqual({
      status: 'fail',
      recovered: [],
      findings: ['LEASE_INVALID'],
    });
    expect(calls).toEqual([]);
  });

  it.each(['id', 'task_id', 'base_sha'] as const)(
    'rejects coercible non-string %s without running conversion hooks',
    async (field) => {
      const value = lease();
      let conversions = 0;
      const calls: string[] = [];
      const fake = {
        toString() {
          conversions += 1;
          return value[field];
        },
      };
      expect(
        await recoverValidationLeases({ leases: [{ ...value, [field]: fake }], host: host(calls) }),
      ).toEqual({ status: 'fail', recovered: [], findings: ['LEASE_INVALID'] });
      expect(calls).toEqual([]);
      expect(conversions).toBe(0);
    },
  );

  it('does not start database cleanup after a failed worktree removal and continues with independent leases', async () => {
    const first = lease();
    const second = lease('fedcba9876543210');
    const calls: string[] = [];
    const controls = host(calls);
    const result = await recoverValidationLeases({
      leases: [null, first, second],
      host: {
        ...controls,
        remove_worktree: async (path) => {
          calls.push(`remove:${path}`);
          if (path === first.worktree_path) throw new Error('worktree busy');
        },
      },
    });
    expect(result).toEqual({
      status: 'fail',
      recovered: [second.id],
      findings: ['LEASE_INVALID', `${first.id}: RECOVERY_FAILED: worktree busy`],
    });
    expect(calls).toEqual([
      `remove:${first.worktree_path}`,
      `remove:${second.worktree_path}`,
      `drop:${second.database}`,
    ]);
  });

  it('reports database failures without claiming the partially cleaned lease recovered', async () => {
    const value = lease();
    const calls: string[] = [];
    const result = await recoverValidationLeases({
      leases: [value],
      host: {
        ...host(calls),
        drop_database: async (database) => {
          calls.push(`drop:${database}`);
          throw 'connection lost';
        },
      },
    });
    expect(result).toEqual({
      status: 'fail',
      recovered: [],
      findings: [`${value.id}: RECOVERY_FAILED: connection lost`],
    });
    expect(calls).toEqual([`remove:${value.worktree_path}`, `drop:${value.database}`]);
  });
});
