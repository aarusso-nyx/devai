import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sensePlantCoverage } from '../../src/plant-coverage.js';

const NOW = '2026-09-08T12:00:00.000Z';
let root: string;

function write(path: string, value: unknown): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, typeof value === 'string' ? value : JSON.stringify(value));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-plant-partial-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('plant coverage partial inventory boundaries', () => {
  it('fails with the exact no-inventory finding when both bodies are absent', () => {
    const reading = sensePlantCoverage({ repoRoot: root, now: NOW });

    expect(reading).toMatchObject({
      status: 'fail',
      timestamp: NOW,
      sensor: { name: 'plant-coverage', kind: 'plant_coverage' },
      command: 'devai sense-plant-coverage',
      deterministic: true,
      tier: 'L0',
      metrics: { endpoint_count: 0, route_count: 0, missing_files: 0 },
      findings: [
        {
          severity: 'error',
          code: 'PLANT_COVERAGE_NO_INVENTORY',
          message:
            'Neither api-map nor routes-inventory found. Run sense-api + sense-routes first.',
        },
      ],
    });
  });

  it('reviews an API-only inventory when its controller file is missing', () => {
    write('record/proofs/sensors/inventory_api/api-map.json', {
      endpoints: [
        { method: 'GET', path: '/accounts', controller: { file: 'src/missing-controller.ts' } },
      ],
    });

    const reading = sensePlantCoverage({ repoRoot: root, now: NOW });

    expect(reading).toMatchObject({
      status: 'review',
      timestamp: NOW,
      metrics: { endpoint_count: 1, route_count: 0, missing_files: 1 },
      findings: [
        {
          severity: 'warning',
          code: 'PLANT_COVERAGE_MISSING_CONTROLLER_FILE',
          message: 'Endpoint GET /accounts references non-existent file: src/missing-controller.ts',
          file: 'src/missing-controller.ts',
        },
      ],
    });
  });

  it('reviews a routes-only inventory when its component file is missing', () => {
    write('record/proofs/sensors/inventory_routes/routes-inventory.json', {
      routes: [{ path: '/checkout', component: { file: 'src/missing-route.ts' } }],
    });

    const reading = sensePlantCoverage({ repoRoot: root, now: NOW });

    expect(reading).toMatchObject({
      status: 'review',
      timestamp: NOW,
      metrics: { endpoint_count: 0, route_count: 1, missing_files: 1 },
      findings: [
        {
          severity: 'warning',
          code: 'PLANT_COVERAGE_MISSING_COMPONENT_FILE',
          message: 'Route /checkout references non-existent file: src/missing-route.ts',
          file: 'src/missing-route.ts',
        },
      ],
    });
  });

  it('passes a partial API inventory when every referenced file exists', () => {
    write('src/accounts-controller.ts', 'export const accounts = true;\n');
    write('record/proofs/sensors/inventory_api/api-map.json', {
      endpoints: [
        { method: 'POST', path: '/accounts', controller: { file: 'src/accounts-controller.ts' } },
      ],
    });

    const reading = sensePlantCoverage({ repoRoot: root, now: NOW });

    expect(reading).toMatchObject({
      status: 'pass',
      timestamp: NOW,
      metrics: { endpoint_count: 1, route_count: 0, missing_files: 0 },
      findings: [],
    });
  });
});
