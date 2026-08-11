// Invariants: INV-DEVAI-001, INV-DEVAI-012, INV-DEVAI-017
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
  connectionStrings: [] as string[],
}));

vi.mock('pg', () => ({
  Client: class Client {
    constructor(options: { connectionString: string }) {
      mocks.connectionStrings.push(options.connectionString);
    }

    connect = mocks.connect;
    query = mocks.query;
    end = mocks.end;
  },
}));

import { runDataProbeBatch } from '../../src/runtime-probe-data.js';
import type { RuntimeProbeCharter } from '../../src/runtime-probe.js';

function charter(overrides: Partial<RuntimeProbeCharter> = {}): RuntimeProbeCharter {
  return {
    schemaVersion: '1.0.0',
    id: 'RPC-data-depth',
    mission: 'exercise data probe behavior',
    kind: 'data',
    target: { base_url: 'postgres://user@db.example.test/database' },
    probes: [],
    ...overrides,
  };
}

beforeEach(() => {
  mocks.connect.mockReset().mockResolvedValue(undefined);
  mocks.query.mockReset();
  mocks.end.mockReset().mockResolvedValue(undefined);
  mocks.connectionStrings.length = 0;
});

afterEach(() => {
  delete process.env['DEVAI_DATA_DEPTH_PASSWORD'];
});

describe('data runtime-probe behavioral depth', () => {
  it('returns one error per probe when the shared connection fails', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('connection refused'));
    const outcomes = await runDataProbeBatch(
      charter({
        probes: [
          { pid: 'P1', name: 'first', query: 'SELECT 1', expect: {} },
          {
            pid: 'P2',
            name: 'second',
            query: 'SELECT 2',
            expect: { invariant: 'INV-DATA' },
          },
        ],
      }),
    );

    expect(outcomes).toEqual([
      expect.objectContaining({
        verdict: 'error',
        failed_expectations: ['pg connect failed: connection refused'],
      }),
      expect.objectContaining({
        verdict: 'error',
        invariant: 'INV-DATA',
        failed_expectations: ['pg connect failed: connection refused'],
      }),
    ]);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('enforces query presence and read-only policy before database execution', async () => {
    const outcomes = await runDataProbeBatch(
      charter({
        probes: [
          { pid: 'P1', name: 'absent', expect: {} },
          { pid: 'P2', name: 'empty', query: '', expect: { invariant: 'INV-EMPTY' } },
          { pid: 'P3', name: 'write', query: 'DELETE FROM records', expect: {} },
        ],
      }),
    );

    expect(outcomes.map((outcome) => outcome.verdict)).toEqual(['error', 'error', 'error']);
    expect(outcomes[1]).toMatchObject({ invariant: 'INV-EMPTY' });
    expect(outcomes[2]?.failed_expectations[0]).toContain('read-only policy');
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it('grades row-count, contains, absent, pass, and query-error outcomes independently', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ status: 'ok', secret: 'visible' }] })
      .mockResolvedValueOnce({ rows: [{ status: 'ok' }] })
      .mockRejectedValueOnce('bad sql');
    const outcomes = await runDataProbeBatch(
      charter({
        probes: [
          {
            pid: 'P1',
            name: 'mismatch',
            query: 'WITH result AS (SELECT 1) SELECT * FROM result',
            expect: {
              row_count: 2,
              contains: ['missing'],
              absent: ['secret'],
              invariant: 'INV-MISMATCH',
            },
          },
          {
            pid: 'P2',
            name: 'pass',
            query: 'SHOW server_version',
            expect: { row_count: 1, contains: ['ok'], absent: ['secret'] },
          },
          { pid: 'P3', name: 'query error', query: 'EXPLAIN SELECT 1', expect: {} },
        ],
      }),
    );

    expect(outcomes[0]).toMatchObject({
      verdict: 'fail',
      invariant: 'INV-MISMATCH',
      failed_expectations: [
        'row_count: expected 2, got 1',
        "contains: 'missing' not found in result rows",
        "absent: 'secret' MUST NOT appear in result rows",
      ],
    });
    expect(outcomes[0]?.observed_body_excerpt).toContain('visible');
    expect(outcomes[1]).toMatchObject({ verdict: 'pass', failed_expectations: [] });
    expect(outcomes[2]).toMatchObject({
      verdict: 'error',
      failed_expectations: ['query execution error: bad sql'],
    });
  });

  it('substitutes a declared credential and permits writes under an idempotent policy', async () => {
    process.env['DEVAI_DATA_DEPTH_PASSWORD'] = 'p@ssword';
    mocks.query.mockResolvedValueOnce({ rows: [] });
    mocks.end.mockRejectedValueOnce(new Error('best-effort close'));
    const outcomes = await runDataProbeBatch(
      charter({
        side_effects: { policy: 'idempotent_writes' },
        allowed_credentials: [
          { name: 'writer', role: 'writer', secret_ref: 'DEVAI_DATA_DEPTH_PASSWORD' },
        ],
        probes: [
          {
            pid: 'P1',
            name: 'write',
            query: 'UPDATE records SET seen = true',
            as_credential: 'writer',
            expect: { row_count: 0 },
          },
        ],
      }),
    );

    expect(outcomes[0]?.verdict).toBe('pass');
    expect(mocks.connectionStrings).toEqual([
      'postgres://user:p%40ssword@db.example.test/database',
    ]);
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it('falls back to the unchanged target for absent, empty, unknown, and non-URL credentials', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    for (const current of [
      charter({ probes: [{ pid: 'P1', name: 'none', query: 'SELECT 1', expect: {} }] }),
      charter({
        allowed_credentials: [
          { name: 'empty', role: 'reader', secret_ref: 'DEVAI_DATA_DEPTH_PASSWORD' },
        ],
        probes: [
          { pid: 'P1', name: 'empty', query: 'SELECT 1', as_credential: 'empty', expect: {} },
        ],
      }),
      charter({
        probes: [
          { pid: 'P1', name: 'unknown', query: 'SELECT 1', as_credential: 'missing', expect: {} },
        ],
      }),
      charter({
        target: { base_url: 'host=db.example.test dbname=fixture' },
        allowed_credentials: [
          { name: 'raw', role: 'reader', secret_ref: 'DEVAI_DATA_DEPTH_PASSWORD' },
        ],
        probes: [{ pid: 'P1', name: 'raw', query: 'SELECT 1', as_credential: 'raw', expect: {} }],
      }),
    ]) {
      if (current.target.base_url.startsWith('host=')) {
        process.env['DEVAI_DATA_DEPTH_PASSWORD'] = 'secret';
      }
      expect((await runDataProbeBatch(current))[0]?.verdict).toBe('pass');
    }

    expect(mocks.connectionStrings).toEqual([
      'postgres://user@db.example.test/database',
      'postgres://user@db.example.test/database',
      'postgres://user@db.example.test/database',
      'host=db.example.test dbname=fixture',
    ]);
  });
});
