import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeRuntimeProbe, type RuntimeProbeCharter } from '../../src/runtime-probe.js';

const NOW = '2026-09-09T12:00:00.000Z';
const base: Omit<RuntimeProbeCharter, 'kind' | 'probes'> = {
  schemaVersion: '1.0.0',
  id: 'RPC-http-boundaries',
  mission: 'HTTP boundary fixture',
  target: { base_url: 'http://fixture.invalid/api/' },
};

function response(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('runtime probe HTTP boundaries', () => {
  it('constructs method, URL, JSON body, and content headers from a typed API probe', async () => {
    fetchMock.mockResolvedValueOnce(response(201, '{"created":true}'));
    const { summary } = await executeRuntimeProbe({
      charter: {
        ...base,
        kind: 'api',
        probes: [
          {
            pid: 'CREATE-1',
            name: 'create',
            method: 'post',
            path: 'records',
            body: { enabled: true },
            expect: { status: 201, contains: ['created'] },
          },
        ],
      },
      now: NOW,
    });

    expect(summary).toMatchObject({ verdict: 'pass', total: 1, pass: 1, fail: 0, error: 0 });
    expect(fetchMock).toHaveBeenCalledWith('http://fixture.invalid/api/records', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: '{"enabled":true}',
    });
  });

  it('does not send declared bodies for GET or HEAD requests', async () => {
    for (const method of ['GET', 'HEAD']) {
      fetchMock.mockResolvedValueOnce(response(200, 'ok'));
      await executeRuntimeProbe({
        charter: {
          ...base,
          kind: 'api',
          probes: [{ pid: method, name: method, method, body: { ignored: true }, expect: {} }],
        },
      });
      expect(fetchMock).toHaveBeenLastCalledWith('http://fixture.invalid/', {
        method,
        headers: { accept: 'application/json' },
      });
    }
  });

  it('evaluates status, contains, and absent against the full response while retaining only a 2048 excerpt', async () => {
    const body = `${'x'.repeat(2048)}TAIL`;
    fetchMock.mockResolvedValueOnce(response(200, body));
    const { summary, reading } = await executeRuntimeProbe({
      charter: {
        ...base,
        kind: 'auth',
        probes: [
          {
            pid: 'TAIL-1',
            name: 'tail',
            expect: { status: 200, contains: ['TAIL'], absent: ['secret'] },
          },
        ],
      },
      now: NOW,
    });

    expect(summary).toMatchObject({ verdict: 'pass', pass: 1, total: 1 });
    expect(summary.outcomes[0]).toMatchObject({
      pid: 'TAIL-1',
      observed_status: 200,
      observed_body_excerpt: 'x'.repeat(2048),
      failed_expectations: [],
    });
    expect(reading).toMatchObject({
      status: 'pass',
      deterministic: false,
      timestamp: NOW,
      metrics: { probes_total: 1, probes_pass: 1, probes_fail: 0, probes_error: 0 },
    });

    fetchMock.mockResolvedValueOnce(response(200, `${'x'.repeat(2048)}SECRET`));
    const absent = await executeRuntimeProbe({
      charter: {
        ...base,
        kind: 'api',
        probes: [{ pid: 'TAIL-2', name: 'forbidden tail', expect: { absent: ['SECRET'] } }],
      },
    });
    expect(absent.summary).toMatchObject({ verdict: 'fail', fail: 1 });
    expect(absent.summary.outcomes[0]?.failed_expectations).toEqual([
      "absent: 'SECRET' MUST NOT appear in response",
    ]);
  });

  it('aggregates connection errors before failed and passing probes and dry-runs without fetch', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(response(500, '{}'))
      .mockResolvedValueOnce(response(200, '{"ok":true}'));
    const observed = await executeRuntimeProbe({
      charter: {
        ...base,
        kind: 'api',
        probes: [
          { pid: 'ERR-1', name: 'unreachable', expect: { status: 200 } },
          { pid: 'FAIL-1', name: 'failed', expect: { status: 200 } },
          { pid: 'PASS-1', name: 'healthy', expect: { status: 200, contains: ['ok'] } },
        ],
      },
    });
    expect(observed.summary).toMatchObject({
      verdict: 'error',
      total: 3,
      error: 1,
      fail: 1,
      pass: 1,
    });
    expect(observed.reading.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'PROBE_ERROR',
          message: '[ERR-1] unreachable: probe execution error: ECONNREFUSED',
        }),
        expect.objectContaining({
          code: 'EXPECT_FAILED',
          message: expect.stringContaining('[FAIL-1]'),
        }),
      ]),
    );

    fetchMock.mockReset();
    const dry = await executeRuntimeProbe({
      charter: {
        ...base,
        kind: 'api',
        probes: [{ pid: 'DRY-1', name: 'dry', expect: { status: 200 } }],
      },
      dryRun: true,
    });
    expect(dry.summary).toMatchObject({ verdict: 'skipped', total: 1, skipped: 1 });
    expect(dry.summary.outcomes[0]?.failed_expectations).toEqual([]);
    const dryOutcome = dry.summary.outcomes[0];
    if (dryOutcome === undefined) throw new Error('Expected one dry-run outcome');
    expect(Object.hasOwn(dryOutcome, 'invariant')).toBe(false);
    const bound = await executeRuntimeProbe({
      charter: {
        ...base,
        kind: 'api',
        probes: [{ pid: 'BOUND', name: 'bound', expect: { invariant: 'INV-BOUND' } }],
      },
      dryRun: true,
    });
    expect(bound.summary.outcomes[0]?.invariant).toBe('INV-BOUND');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
