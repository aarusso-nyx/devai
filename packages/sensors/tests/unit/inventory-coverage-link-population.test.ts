import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryCoverage } from '../../src/inventory-coverage.js';

const NOW = '2026-09-08T12:00:00.000Z';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-coverage-link-population-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(rel: string, value: unknown): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
  return path;
}

function surfaces(): void {
  write('record/proofs/sensors/inventory_api/api-map.json', {
    endpoints: [
      { method: 'GET', path: '/accounts' },
      { id: 'audit', method: 'POST', path: '/audit' },
      { id: 'endpoint-b', method: 'GET', path: '/settings' },
    ],
  });
  write('record/proofs/sensors/inventory_routes/routes-react.json', {
    framework: 'react',
    routes: [
      { id: 'route-a', path: '/accounts' },
      { id: 'route-b', path: '/settings' },
      { id: 'audit', path: '/audit' },
    ],
  });
}

function sense() {
  return senseInventoryCoverage({
    repoRoot: root,
    framework: 'react',
    persistBody: false,
    now: NOW,
  });
}

describe('inventory coverage link population', () => {
  it('processes only JSON use-case files', () => {
    surfaces();
    write('product/use-cases/good.json', {
      schemaVersion: '1.0.0',
      roles: ['operator'],
      cases: [{ id: 'UC-good', title: 'Browse accounts', mainFlow: [{ action: 'browse' }] }],
    });
    write('product/use-cases/notes.txt', '{not-json');

    const result = sense();

    expect(result.reading.status).toBe('review');
    expect(result.reading.findings?.map((finding) => finding.code)).not.toContain(
      'COVERAGE_USE_CASES_PARSE_FAILED',
    );
    expect(result.body).toMatchObject({ useCases: [{ id: 'UC-good' }], links: [] });
  });

  it('preserves route-only and endpoint-only links, including missing-axis defaults', () => {
    surfaces();
    write('product/use-cases/axes.json', {
      schemaVersion: '1.0.0',
      roles: ['operator'],
      cases: [
        {
          id: 'UC-axes',
          title: 'Browse each inventoried surface',
          mainFlow: [
            { action: 'two routes', refs: { routeIds: ['route-a', 'route-b'], endpointIds: [] } },
            {
              action: 'two endpoints',
              refs: { routeIds: [], endpointIds: ['GET /accounts', 'endpoint-b'] },
            },
            { action: 'missing endpoint axis', refs: { routeIds: ['audit'] } },
            { action: 'missing route axis', refs: { endpointIds: ['audit'] } },
          ],
        },
      ],
    });

    const result = sense();
    const links = (
      result.body as {
        links: Array<{
          routeId: string | null;
          endpointId: string | null;
          useCaseId: string;
          linkKind: string;
        }>;
      }
    ).links;

    expect(result.reading.status).toBe('pass');
    expect(links).toEqual([
      { routeId: 'route-a', endpointId: null, useCaseId: 'UC-axes', linkKind: 'route-only' },
      { routeId: 'route-b', endpointId: null, useCaseId: 'UC-axes', linkKind: 'route-only' },
      {
        routeId: null,
        endpointId: 'GET /accounts',
        useCaseId: 'UC-axes',
        linkKind: 'endpoint-only',
      },
      { routeId: null, endpointId: 'endpoint-b', useCaseId: 'UC-axes', linkKind: 'endpoint-only' },
      { routeId: 'audit', endpointId: null, useCaseId: 'UC-axes', linkKind: 'route-only' },
      { routeId: null, endpointId: 'audit', useCaseId: 'UC-axes', linkKind: 'endpoint-only' },
    ]);
  });

  it('reviews an authored matrix with no use cases and with partial linking', () => {
    surfaces();
    const noCases = sense();
    expect(noCases.reading.status).toBe('review');
    expect(noCases.reading.findings?.map((finding) => finding.code)).toContain(
      'COVERAGE_NO_USE_CASES',
    );

    write('product/use-cases/partial.json', {
      schemaVersion: '1.0.0',
      roles: ['operator'],
      cases: [
        {
          id: 'UC-partial',
          title: 'Browse accounts',
          mainFlow: [
            { action: 'accounts', refs: { routeIds: ['route-a'], endpointIds: ['GET /accounts'] } },
          ],
        },
      ],
    });
    const partial = sense();
    expect(partial.reading.status).toBe('review');
    expect(partial.reading.findings?.map((finding) => finding.code)).toContain(
      'COVERAGE_PARTIAL_USE_CASE_LINKING',
    );
    expect(
      (partial.body as { unmapped: { routes: string[]; endpoints: string[] } }).unmapped,
    ).toEqual({
      routes: ['route-b', 'audit'],
      endpoints: ['audit', 'endpoint-b'],
    });
  });
  it('reviews an endpoint-only inventory without authored use cases', () => {
    surfaces();
    write('record/proofs/sensors/inventory_routes/routes-react.json', {
      framework: 'react',
      routes: [],
    });
    const result = sense();
    expect(result.reading.status).toBe('review');
    expect(result.reading.findings?.map((finding) => finding.code)).toContain(
      'COVERAGE_NO_USE_CASES',
    );
  });

  it('reviews unmapped endpoints even when every route is covered', () => {
    surfaces();
    write('product/use-cases/routes.json', {
      schemaVersion: '1.0.0',
      roles: ['operator'],
      cases: [
        {
          id: 'UC-routes',
          title: 'Browse all screens',
          mainFlow: [
            {
              action: 'browse',
              refs: { routeIds: ['route-a', 'route-b', 'audit'], endpointIds: ['GET /accounts'] },
            },
          ],
        },
      ],
    });
    const result = sense();
    expect(result.reading.status).toBe('review');
    expect(result.reading.findings?.map((finding) => finding.code)).toContain(
      'COVERAGE_PARTIAL_USE_CASE_LINKING',
    );
    expect(result.body).toMatchObject({
      unmapped: { routes: [], endpoints: ['audit', 'endpoint-b'] },
    });
  });
});
