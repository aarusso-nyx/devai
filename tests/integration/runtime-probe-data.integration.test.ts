import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runDataProbeBatch } from '../../packages/sensors/src/runtime-probe-data.js';
import type { RuntimeProbeCharter } from '../../packages/sensors/src/runtime-probe.js';

/**
 * Full-production integration test for the data-kind runtime-probe driver
 * (T3.1 closure). The database-backed cases are opt-in under DII-048:
 * set DEVAI_DB_TESTS=1 and optionally DEVAI_DB_URL.
 */

const DB_TESTS = process.env.DEVAI_DB_TESTS === '1';
const DB_URL =
  process.env.DEVAI_DB_URL ??
  `postgresql://${process.env.USER ?? 'postgres'}@localhost:5432/devai_test`;
const itDb = DB_TESTS ? it : it.skip;

const SCHEMA = 'devai_runtime_probe_test';

interface TestDbClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string): Promise<{ rows: unknown[] }>;
}

async function withClient<T>(fn: (c: TestDbClient) => Promise<T>): Promise<T> {
  const requireFromSensors = createRequire(resolve('packages/sensors/package.json'));
  const pg = requireFromSensors('pg') as {
    Client: new (options: { connectionString: string }) => TestDbClient;
  };
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// These tests do NOT require a reachable Postgres — they exercise
// the input-validation + connection-failure paths that the driver
// must handle uniformly regardless of target reachability.
describe('runDataProbeBatch — input validation + connection failure', () => {
  const UNREACHABLE: RuntimeProbeCharter = {
    schemaVersion: '1.0.0',
    id: 'RPC-data-unreachable',
    kind: 'data',
    mission: 'unreachable',
    target: { base_url: 'postgres://nobody@127.0.0.1:1/nodb' },
    probes: [],
  };

  it('connection failure produces error verdict on every probe', async () => {
    const outcomes = await runDataProbeBatch({
      ...UNREACHABLE,
      probes: [
        { pid: 'P1', name: 'a', query: 'SELECT 1', expect: { row_count: 1 } },
        { pid: 'P2', name: 'b', query: 'SELECT 2', expect: { row_count: 1 } },
      ],
    });
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.verdict === 'error')).toBe(true);
    expect(outcomes[0]?.failed_expectations[0]).toMatch(/pg connect failed/);
  });

  it('preserves expect.invariant on each outcome (for trace-back)', async () => {
    const outcomes = await runDataProbeBatch({
      ...UNREACHABLE,
      probes: [
        {
          pid: 'P1',
          name: 'rls check',
          query: 'SELECT 1',
          expect: { row_count: 1, invariant: 'INV-RLS-001' },
        },
      ],
    });
    expect(outcomes[0]?.invariant).toBe('INV-RLS-001');
  });

  it('handles zero probes gracefully (empty charter)', async () => {
    const outcomes = await runDataProbeBatch(UNREACHABLE);
    expect(outcomes).toEqual([]);
  });
});

describe('runDataProbeBatch (full-production local Postgres)', () => {
  beforeAll(async () => {
    if (!DB_TESTS) return;
    await withClient(async (c) => {
      await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await c.query(`CREATE SCHEMA ${SCHEMA}`);
      await c.query(`CREATE TABLE ${SCHEMA}.widgets (id int primary key, label text)`);
      await c.query(`INSERT INTO ${SCHEMA}.widgets VALUES (1, 'hello'), (2, 'world')`);
    });
  });

  afterAll(async () => {
    if (!DB_TESTS) return;
    await withClient((c) => c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`));
  });

  function charter(
    probes: RuntimeProbeCharter['probes'],
    policy?: 'read-only' | 'idempotent_writes',
  ): RuntimeProbeCharter {
    return {
      schemaVersion: '1.0.0',
      id: 'RPC-data-it',
      kind: 'data',
      mission: 'gated data probe',
      target: { base_url: DB_URL },
      probes,
      ...(policy !== undefined && { side_effects: { policy } }),
    };
  }

  itDb('SELECT with matching row_count passes', async () => {
    const out = await runDataProbeBatch(
      charter([
        {
          pid: 'P1',
          name: 'count widgets',
          query: `SELECT id FROM ${SCHEMA}.widgets`,
          expect: { row_count: 2 },
        },
      ]),
    );
    expect(out[0]?.verdict).toBe('pass');
  });

  itDb(
    'row_count mismatch fails with the specific expectation in failed_expectations',
    async () => {
      const out = await runDataProbeBatch(
        charter([
          {
            pid: 'P1',
            name: 'wrong count',
            query: `SELECT id FROM ${SCHEMA}.widgets`,
            expect: { row_count: 99 },
          },
        ]),
      );
      expect(out[0]?.verdict).toBe('fail');
      expect(out[0]?.failed_expectations[0]).toMatch(/row_count: expected 99/);
    },
  );

  itDb('contains matches against the JSON-stringified rows', async () => {
    const out = await runDataProbeBatch(
      charter([
        {
          pid: 'P1',
          name: 'find hello',
          query: `SELECT label FROM ${SCHEMA}.widgets WHERE id=1`,
          expect: { contains: ['hello'] },
        },
      ]),
    );
    expect(out[0]?.verdict).toBe('pass');
  });

  itDb('absent fails when the substring DOES appear', async () => {
    const out = await runDataProbeBatch(
      charter([
        {
          pid: 'P1',
          name: 'no hello expected',
          query: `SELECT label FROM ${SCHEMA}.widgets`,
          expect: { absent: ['hello'] },
        },
      ]),
    );
    expect(out[0]?.verdict).toBe('fail');
    expect(out[0]?.failed_expectations[0]).toMatch(/absent: 'hello'/);
  });

  itDb('read-only policy rejects an INSERT with error verdict', async () => {
    const out = await runDataProbeBatch(
      charter(
        [
          {
            pid: 'P1',
            name: 'forbidden write',
            query: `INSERT INTO ${SCHEMA}.widgets VALUES (99, 'oops')`,
            expect: {},
          },
        ],
        'read-only',
      ),
    );
    expect(out[0]?.verdict).toBe('error');
    expect(out[0]?.failed_expectations[0]).toMatch(/read-only policy/);
    // Verify the INSERT did NOT execute.
    await withClient(async (c) => {
      const r = await c.query(`SELECT count(*)::int as n FROM ${SCHEMA}.widgets`);
      expect((r.rows[0] as { n: number }).n).toBe(2);
    });
  });

  itDb('idempotent_writes policy allows non-SELECT (UPDATE without count check)', async () => {
    const out = await runDataProbeBatch(
      charter(
        [
          {
            pid: 'P1',
            name: 'mark widget',
            query: `UPDATE ${SCHEMA}.widgets SET label='hello' WHERE id=1`,
            expect: {},
          },
        ],
        'idempotent_writes',
      ),
    );
    expect(out[0]?.verdict).toBe('pass');
  });

  itDb('bad SQL produces error verdict for that probe only (others continue)', async () => {
    const out = await runDataProbeBatch(
      charter([
        {
          pid: 'P1',
          name: 'syntax error',
          query: 'SELECT bogus FROM nowhere_table_xyz',
          expect: { row_count: 0 },
        },
        {
          pid: 'P2',
          name: 'fine query',
          query: `SELECT id FROM ${SCHEMA}.widgets WHERE id=1`,
          expect: { row_count: 1 },
        },
      ]),
    );
    expect(out).toHaveLength(2);
    expect(out[0]?.verdict).toBe('error');
    expect(out[1]?.verdict).toBe('pass');
  });
});
// Invariants: INV-DEVAI-002, INV-DEVAI-012
