import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeRuntimeProbe, type RuntimeProbeCharter } from '../../src/runtime-probe.js';

/**
 * Unit tests for the runtime-probe sensor (Phase 11.A, D-39).
 *
 * The HTTP driver is exercised via a vi.spyOn(global, 'fetch')
 * mock so the test suite stays hermetic — no real network, no
 * port-binding flake. The CLI integration tests cover the
 * --dry-run + usage/schema-validation paths against the real
 * binary.
 */

const baseCharter: Omit<RuntimeProbeCharter, 'probes' | 'kind'> = {
  schemaVersion: '1.0.0',
  id: 'RPC-unit',
  mission: 'unit test',
  target: { base_url: 'http://example.test/' },
};

function jsonResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

// Use a loose type for the spy: vi.spyOn on global fetch has a
// signature TS can't infer against the MockInstance generic.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fetchSpy: any;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('executeRuntimeProbe (api kind)', () => {
  it('emits pass when probe expectations match the mocked HTTP response', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, '{"status":"ok"}'));
    const charter: RuntimeProbeCharter = {
      ...baseCharter,
      kind: 'api',
      probes: [
        {
          pid: 'P1',
          name: 'GET /health',
          method: 'GET',
          path: '/health',
          expect: { status: 200, contains: ['ok'] },
        },
      ],
    };
    const { summary, reading } = await executeRuntimeProbe({ charter });
    expect(summary.verdict).toBe('pass');
    expect(summary.pass).toBe(1);
    expect(reading.status).toBe('pass');
    expect(reading.sensor.kind).toBe('runtime_probe_api');
  });

  it('emits fail when the status code is wrong; finding lists the expectation', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(404, '{"error":"not found"}'));
    const charter: RuntimeProbeCharter = {
      ...baseCharter,
      kind: 'api',
      probes: [
        {
          pid: 'P1',
          name: 'GET /missing',
          method: 'GET',
          path: '/missing',
          expect: { status: 200 },
        },
      ],
    };
    const { summary, reading } = await executeRuntimeProbe({ charter });
    expect(summary.verdict).toBe('fail');
    expect(summary.fail).toBe(1);
    expect(reading.status).toBe('fail');
    expect(reading.findings?.some((f) => f.message.includes('expected 200'))).toBe(true);
  });

  it('emits fail when an "absent" string DOES appear in the body', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, '{"token":"leaked"}'));
    const charter: RuntimeProbeCharter = {
      ...baseCharter,
      kind: 'api',
      probes: [
        {
          pid: 'P1',
          name: 'no leaked token',
          method: 'GET',
          path: '/x',
          expect: { status: 200, absent: ['token'] },
        },
      ],
    };
    const { summary } = await executeRuntimeProbe({ charter });
    expect(summary.verdict).toBe('fail');
  });

  it('classifies a thrown fetch as error (not fail)', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const charter: RuntimeProbeCharter = {
      ...baseCharter,
      kind: 'api',
      probes: [
        { pid: 'P1', name: 'unreachable', method: 'GET', path: '/x', expect: { status: 200 } },
      ],
    };
    const { summary, reading } = await executeRuntimeProbe({ charter });
    expect(summary.verdict).toBe('error');
    expect(summary.error).toBe(1);
    expect(reading.status).toBe('error');
  });

  it('attaches Bearer auth from secret_ref env var when as_credential is set', async () => {
    process.env.DEVAI_UT_TOKEN = 'shh';
    try {
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, '{}'));
      const charter: RuntimeProbeCharter = {
        ...baseCharter,
        kind: 'auth',
        allowed_credentials: [{ name: 'admin', role: 'admin', secret_ref: 'DEVAI_UT_TOKEN' }],
        probes: [
          {
            pid: 'P1',
            name: 'auth probe',
            method: 'GET',
            path: '/secret',
            as_credential: 'admin',
            expect: { status: 200 },
          },
        ],
      };
      const { reading } = await executeRuntimeProbe({ charter });
      expect(reading.sensor.kind).toBe('runtime_probe_auth');
      const callArgs = fetchSpy.mock.calls[0];
      expect(callArgs).toBeDefined();
      // 2nd arg of fetch is RequestInit; extract its headers.
      const headers = ((callArgs?.[1] as RequestInit | undefined)?.headers ?? {}) as Record<
        string,
        string
      >;
      expect(headers.authorization).toBe('Bearer shh');
    } finally {
      delete process.env.DEVAI_UT_TOKEN;
    }
  });

  it('dry-run skips network and marks all probes skipped', async () => {
    const charter: RuntimeProbeCharter = {
      ...baseCharter,
      kind: 'api',
      probes: [
        { pid: 'P1', name: 'p1', method: 'GET', path: '/a', expect: { status: 200 } },
        { pid: 'P2', name: 'p2', method: 'GET', path: '/b', expect: { status: 200 } },
      ],
    };
    const { summary } = await executeRuntimeProbe({ charter, dryRun: true });
    expect(summary.verdict).toBe('skipped');
    expect(summary.skipped).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('data kind dispatches to the pg-based driver via --dry-run (no pg load)', async () => {
    // The real data-driver dispatch is exercised in the integration
    // test at packages/sensors/test/runtime-probe-data.integration.test.ts.
    // Here we only assert that --dry-run short-circuits before the
    // driver loads, so the unit suite stays free of the pg ESM/CJS
    // interop that requires vitest's integration resolver.
    const charter: RuntimeProbeCharter = {
      ...baseCharter,
      kind: 'data',
      target: { base_url: 'postgres://nobody@127.0.0.1:1/nodb' },
      probes: [{ pid: 'P1', name: 'rows', query: 'SELECT 1', expect: { row_count: 1 } }],
    };
    const { summary, reading } = await executeRuntimeProbe({ charter, dryRun: true });
    expect(reading.sensor.kind).toBe('runtime_probe_data');
    expect(summary.verdict).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
// Invariants: INV-DEVAI-002, INV-DEVAI-012
