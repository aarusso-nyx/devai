import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sensePlantCoverage } from '../../src/plant-coverage.js';

const now = '2026-09-09T12:00:00.000Z';
let root: string;

function write(path: string, contents: string): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

function writeInventories(
  endpoints: readonly Record<string, unknown>[],
  routes: readonly Record<string, unknown>[],
): void {
  write('record/proofs/sensors/inventory_api/api-map.json', JSON.stringify({ endpoints }));
  write('record/proofs/sensors/inventory_routes/routes-inventory.json', JSON.stringify({ routes }));
}

function reading() {
  return sensePlantCoverage({ repoRoot: root, now });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-plant-coverage-files-'));
  write('apps/api/users.ts', 'export function users() {}\n');
  write('apps/web/routes.tsx', 'export const routes = [];\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('plant-coverage endpoint and route file population', () => {
  it('passes existing files and ignores empty controller/component references', () => {
    writeInventories(
      [
        { method: 'GET', path: '/users', controller: { file: 'apps/api/users.ts' } },
        { method: 'GET', path: '/health', controller: { file: '' } },
      ],
      [
        { path: '/users', component: { file: 'apps/web/routes.tsx' } },
        { path: '/health', component: { file: '' } },
      ],
    );

    const result = reading();

    expect(result.timestamp).toBe(now);

    expect(result.status).toBe('pass');
    expect(result.findings).toEqual([]);
    expect(result.metrics).toEqual({ endpoint_count: 2, route_count: 2, missing_files: 0 });
  });

  it('reviews stale endpoint and route references with exact missing-file findings', () => {
    writeInventories(
      [
        { method: 'GET', path: '/users', controller: { file: 'apps/api/users.ts' } },
        { method: 'POST', path: '/ghost', controller: { file: 'apps/api/missing.ts' } },
        { method: 'GET', path: '/empty', controller: { file: '' } },
      ],
      [
        { path: '/users', component: { file: 'apps/web/routes.tsx' } },
        { path: '/ghost', component: { file: 'apps/web/missing.tsx' } },
        { path: '/empty', component: { file: '' } },
      ],
    );

    const result = reading();

    expect(result.timestamp).toBe(now);

    expect(result.status).toBe('review');
    expect(result.metrics).toEqual({ endpoint_count: 3, route_count: 3, missing_files: 2 });
    expect(result.findings).toEqual([
      {
        severity: 'warning',
        code: 'PLANT_COVERAGE_MISSING_CONTROLLER_FILE',
        message: 'Endpoint POST /ghost references non-existent file: apps/api/missing.ts',
        file: 'apps/api/missing.ts',
      },
      {
        severity: 'warning',
        code: 'PLANT_COVERAGE_MISSING_COMPONENT_FILE',
        message: 'Route /ghost references non-existent file: apps/web/missing.tsx',
        file: 'apps/web/missing.tsx',
      },
    ]);
  });
});

// #382: the routes producer writes routes-<framework>.json, so plant coverage resolves the
// routes body as inventory_coverage does instead of a fixed routes-inventory.json name.
describe('plant-coverage routes body resolution', () => {
  const ROUTES_DIR = 'record/proofs/sensors/inventory_routes';
  const api = {
    endpoints: [{ method: 'GET', path: '/users', controller: { file: 'apps/api/users.ts' } }],
  };
  const routes = (path: string) => ({
    framework: 'react',
    routes: [{ path, component: { file: 'apps/web/routes.tsx' } }],
  });

  beforeEach(() => {
    write('record/proofs/sensors/inventory_api/api-map.json', JSON.stringify(api));
  });

  it('reads the single framework-named routes body the producer writes', () => {
    write(`${ROUTES_DIR}/routes-react.json`, JSON.stringify(routes('/users')));

    const result = reading();

    expect(result.status).toBe('pass');
    expect(result.metrics).toMatchObject({ endpoint_count: 1, route_count: 1, missing_files: 0 });
  });

  it('still reads a lone legacy routes-inventory.json body', () => {
    write(`${ROUTES_DIR}/routes-inventory.json`, JSON.stringify(routes('/legacy')));

    expect(reading().metrics).toMatchObject({ route_count: 1 });
  });

  it('never guesses between two routes bodies', () => {
    write(`${ROUTES_DIR}/routes-react.json`, JSON.stringify(routes('/react')));
    write(`${ROUTES_DIR}/routes-angular.json`, JSON.stringify(routes('/angular')));

    expect(reading().metrics).toMatchObject({ route_count: 0 });
  });

  it('keeps an explicit routes path over any candidate in the directory', () => {
    write(`${ROUTES_DIR}/routes-react.json`, JSON.stringify(routes('/react')));
    write(
      'elsewhere/routes.json',
      JSON.stringify({ routes: [...routes('/a').routes, ...routes('/b').routes] }),
    );

    const result = sensePlantCoverage({
      repoRoot: root,
      now,
      routesInventoryPath: 'elsewhere/routes.json',
    });

    expect(result.metrics).toMatchObject({ route_count: 2 });
  });

  it('keeps PLANT_COVERAGE_NO_INVENTORY when neither body exists anywhere', () => {
    rmSync(join(root, 'record'), { recursive: true, force: true });

    const result = reading();

    expect(result.status).toBe('fail');
    expect(result.findings?.map((finding) => finding.code)).toContain(
      'PLANT_COVERAGE_NO_INVENTORY',
    );
  });
});
