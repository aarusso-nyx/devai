import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { executeRuntimeProbe, type RuntimeProbeCharter } from '../../src/runtime-probe.js';

const baseCharter: Omit<RuntimeProbeCharter, 'probes' | 'kind'> = {
  schemaVersion: '1.0.0',
  id: 'RPC-pilot',
  mission: 'runtime boundary pilot',
  target: { base_url: 'http://example.test/api/' },
};

function jsonResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

// A real Response keeps response status and body behavior observable without network access.
let fetchSpy: MockInstance<typeof fetch>;
let previousToken: string | undefined;

beforeEach(() => {
  previousToken = process.env.DEVAI_PILOT_TOKEN;
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected fetch'));
});

afterEach(() => {
  fetchSpy.mockRestore();
  if (previousToken === undefined) delete process.env.DEVAI_PILOT_TOKEN;
  else process.env.DEVAI_PILOT_TOKEN = previousToken;
});

describe('runtime probe boundary pilot', () => {
  it('uppercases methods, joins paths, and sends JSON only for a body-capable request', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(201, '{}'))
      .mockResolvedValueOnce(jsonResponse(200, '{}'));
    const charter: RuntimeProbeCharter = {
      ...baseCharter,
      kind: 'api',
      probes: [
        {
          pid: 'POST-1',
          name: 'submit',
          method: 'post',
          path: 'submit',
          body: { enabled: true },
          expect: { status: 201 },
        },
        {
          pid: 'GET-1',
          name: 'health',
          path: 'health',
          expect: { status: 200 },
        },
      ],
    };

    const { summary } = await executeRuntimeProbe({ charter });
    expect(summary.verdict).toBe('pass');
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const [postUrl, postInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(postUrl).toBe('http://example.test/api/submit');
    expect(postInit.method).toBe('POST');
    expect(postInit.headers).toMatchObject({
      accept: 'application/json',
      'content-type': 'application/json',
    });
    expect(postInit.body).toBe('{"enabled":true}');

    const [getUrl, getInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(getUrl).toBe('http://example.test/api/health');
    expect(getInit.method).toBe('GET');
    expect(getInit.headers).toEqual({ accept: 'application/json' });
    expect(getInit.body).toBeUndefined();
  });

  it('adds Bearer credentials from the named environment variable and omits them when absent', async () => {
    process.env.DEVAI_PILOT_TOKEN = 'pilot-secret';
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, '{}'));
    const charter: RuntimeProbeCharter = {
      ...baseCharter,
      kind: 'auth',
      allowed_credentials: [
        { name: 'operator', role: 'operator', secret_ref: 'DEVAI_PILOT_TOKEN' },
      ],
      probes: [
        { pid: 'AUTH-1', name: 'private', as_credential: 'operator', expect: { status: 200 } },
      ],
    };

    await executeRuntimeProbe({ charter });
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer pilot-secret',
    });

    delete process.env.DEVAI_PILOT_TOKEN;
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, '{}'));
    await executeRuntimeProbe({ charter });
    expect((fetchSpy.mock.calls[1]?.[1] as RequestInit).headers).toEqual({
      accept: 'application/json',
    });
  });

  it('records status, contains, and absent expectation failures with their exact messages', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(404, '{"ok":"present","secret":"leaked"}'));
    const charter: RuntimeProbeCharter = {
      ...baseCharter,
      kind: 'api',
      probes: [
        {
          pid: 'EXPECT-1',
          name: 'expectations',
          expect: {
            status: 200,
            contains: ['missing'],
            absent: ['secret'],
            invariant: 'INV-RUNTIME-001',
          },
        },
      ],
    };

    const { summary, reading } = await executeRuntimeProbe({ charter });
    expect(summary.verdict).toBe('fail');
    expect(summary.fail).toBe(1);
    expect(summary.outcomes[0]?.failed_expectations).toEqual([
      'status: expected 200, got 404',
      "contains: 'missing' not found in response",
      "absent: 'secret' MUST NOT appear in response",
    ]);
    expect(reading.findings).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'EXPECT_FAILED',
        invariant_id: 'INV-RUNTIME-001',
        message: expect.stringContaining('[EXPECT-1] expectations:'),
      }),
      expect.objectContaining({
        severity: 'error',
        code: 'EXPECT_FAILED',
        invariant_id: 'INV-RUNTIME-001',
      }),
      expect.objectContaining({
        severity: 'error',
        code: 'EXPECT_FAILED',
        invariant_id: 'INV-RUNTIME-001',
      }),
    ]);
  });

  it('gives connection errors precedence over failed and passing probes', async () => {
    fetchSpy
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(jsonResponse(500, '{}'))
      .mockResolvedValueOnce(jsonResponse(200, '{"ok":true}'));
    const charter: RuntimeProbeCharter = {
      ...baseCharter,
      kind: 'api',
      probes: [
        { pid: 'ERR-1', name: 'unreachable', expect: { status: 200 } },
        { pid: 'FAIL-1', name: 'server error', expect: { status: 200 } },
        { pid: 'PASS-1', name: 'healthy', expect: { status: 200, contains: ['ok'] } },
      ],
    };

    const { summary, reading } = await executeRuntimeProbe({ charter });
    expect(summary).toMatchObject({ verdict: 'error', total: 3, error: 1, fail: 1, pass: 1 });
    expect(reading.status).toBe('error');
    expect(reading.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'PROBE_ERROR',
          message: expect.stringContaining('[ERR-1]'),
        }),
        expect.objectContaining({
          code: 'EXPECT_FAILED',
          message: expect.stringContaining('[FAIL-1]'),
        }),
      ]),
    );
    expect(reading.findings).toHaveLength(2);
  });

  it('dry-run skips every probe and emits the requested reading identity and timestamp', async () => {
    const charter: RuntimeProbeCharter = {
      ...baseCharter,
      id: 'RPC-dry-run',
      kind: 'api',
      probes: [
        { pid: 'DRY-1', name: 'one', expect: { status: 200 } },
        { pid: 'DRY-2', name: 'two', expect: { status: 200 } },
      ],
    };

    const { summary, reading } = await executeRuntimeProbe({
      charter,
      dryRun: true,
      now: '2026-09-08T12:00:00.000Z',
    });
    expect(summary).toMatchObject({ verdict: 'skipped', total: 2, skipped: 2 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reading).toMatchObject({
      status: 'skipped',
      deterministic: false,
      timestamp: '2026-09-08T12:00:00.000Z',
      sensor: { name: 'runtime-probe:api:RPC-dry-run', kind: 'runtime_probe_api' },
      metrics: {
        probes_total: 2,
        probes_pass: 0,
        probes_fail: 0,
        probes_error: 0,
        probes_skipped: 2,
      },
    });
    expect(reading.command).toContain('runtime-api');
    expect(reading.command).toContain('RPC-dry-run');
  });

  it('contains checks must inspect evidence beyond the 2048-character excerpt', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, `${'x'.repeat(2048)}TAIL`));
    const charter: RuntimeProbeCharter = {
      ...baseCharter,
      kind: 'api',
      probes: [
        { pid: 'TAIL-1', name: 'tail evidence', expect: { status: 200, contains: ['TAIL'] } },
      ],
    };

    const { summary } = await executeRuntimeProbe({ charter });
    expect(summary.verdict).toBe('pass');
    expect(summary.outcomes[0]?.failed_expectations).toEqual([]);
    expect(summary.outcomes[0]?.observed_body_excerpt).toHaveLength(2048);
    expect(summary.outcomes[0]?.observed_body_excerpt).not.toContain('TAIL');
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, `${'x'.repeat(2048)}TAIL`));
    const absent = await executeRuntimeProbe({
      charter: {
        ...charter,
        probes: [{ pid: 'TAIL-2', name: 'forbidden tail', expect: { absent: ['TAIL'] } }],
      },
    });
    expect(absent.summary.verdict).toBe('fail');
    expect(absent.summary.outcomes[0]?.failed_expectations).toEqual([
      "absent: 'TAIL' MUST NOT appear in response",
    ]);
  });
});
